/**
 * Local vault: turns a real directory of files into the contract's FileNode
 * tree, persists per-node inclusion flags, and runs real content retrieval
 * (TF-IDF cosine over the text of the *included* files only).
 *
 * No cloud, no database server — just the filesystem. Embeddings can later
 * replace `retrieve()` behind the same surface without touching the API or UI.
 */
import fs from "node:fs";
import path from "node:path";
import type { DataSource, FileNode, RagReference } from "@/contracts";
import {
  VAULT_SOURCE_ID,
  vaultDir,
  statePath,
  readJson,
  writeJson,
} from "./config";

interface VaultState {
  sourceAvailable: boolean;
  /** Explicit inclusion overrides keyed by node id; absent ⇒ default true. */
  included: Record<string, boolean>;
}

const DEFAULT_STATE: VaultState = { sourceAvailable: true, included: {} };

function loadState(): VaultState {
  return { ...DEFAULT_STATE, ...readJson(statePath(), DEFAULT_STATE) };
}
function saveState(s: VaultState): void {
  writeJson(statePath(), s);
}

/** Text-extractable extensions. Binary formats (pdf/docx) await the parser upgrade. */
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".csv", ".tsv", ".json",
  ".yaml", ".yml", ".log", ".html", ".htm", ".xml", ".js", ".ts", ".tsx",
  ".jsx", ".py", ".java", ".go", ".rb", ".rs", ".c", ".h", ".cpp", ".sh",
  ".sql", ".toml", ".ini", ".env", ".css",
]);

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".html": "text/html", ".htm": "text/html",
};

const isTextFile = (name: string) => TEXT_EXT.has(path.extname(name).toLowerCase());
const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()];

/** A node id is its POSIX-relative path from the vault root (stable + unique). */
function walk(root: string): FileNode[] {
  const out: FileNode[] = [];
  const state = loadState();
  const included = (id: string) => state.included[id] ?? true;

  const recurse = (absDir: string, parentId: string | null) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // skip .rag-vault and dotfiles
      const abs = path.join(absDir, e.name);
      const id = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        out.push({
          id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
          kind: "folder", ragIncluded: included(id),
        });
        recurse(abs, id);
      } else if (e.isFile()) {
        let size: number | undefined;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = undefined;
        }
        out.push({
          id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
          kind: "file", mimeType: mimeOf(e.name), size,
          ragIncluded: included(id),
        });
      }
    }
  };
  recurse(root, null);
  return out;
}

export function listSources(): DataSource[] {
  const state = loadState();
  return [{
    id: VAULT_SOURCE_ID,
    name: "Local Vault",
    kind: "folder",
    available: state.sourceAvailable,
  }];
}

export function listNodes(parentId?: string | null): FileNode[] {
  const all = walk(vaultDir());
  if (parentId === undefined) return all;
  return all.filter((n) => n.parentId === parentId);
}

/** Toggle a node and (for folders) all of its descendants. */
export function setIncluded(nodeId: string, value: boolean): void {
  const all = walk(vaultDir());
  const target = new Set<string>([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && target.has(n.parentId) && !target.has(n.id)) {
        target.add(n.id);
        grew = true;
      }
    }
  }
  const state = loadState();
  for (const id of target) state.included[id] = value;
  saveState(state);
}

export function setSourceAvailable(available: boolean): void {
  const state = loadState();
  state.sourceAvailable = available;
  saveState(state);
}

/**
 * File ids currently included on disk — the single source of truth for what
 * chat may see. Returns empty if the vault source is toggled unavailable.
 * This is what makes inclusion changes hot: the next answer reads this fresh,
 * so unselecting a file (or hiding the source) drops it immediately.
 */
export function activeIncludedFileIds(): string[] {
  const state = loadState();
  if (!state.sourceAvailable) return [];
  return walk(vaultDir())
    .filter((n) => n.kind === "file" && (state.included[n.id] ?? true))
    .map((n) => n.id);
}

/** Read a file's text, or "" for unsupported/binary types. */
function readText(nodeId: string): string {
  if (!isTextFile(nodeId)) return "";
  try {
    return fs.readFileSync(path.join(vaultDir(), nodeId), "utf8");
  } catch {
    return "";
  }
}

const STOP = new Set("the a an and or of to in is are for on with as at by from this that it be".split(" "));
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];
}

interface Chunk { fileId: string; name: string; text: string; tf: Map<string, number>; }

function chunksOf(text: string, fileId: string, name: string): Chunk[] {
  const words = text.split(/\s+/);
  const SIZE = 120, OVERLAP = 25;
  const chunks: Chunk[] = [];
  for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
    const slice = words.slice(i, i + SIZE).join(" ").trim();
    if (!slice) continue;
    const tf = new Map<string, number>();
    for (const t of tokenize(slice)) tf.set(t, (tf.get(t) ?? 0) + 1);
    chunks.push({ fileId, name, text: slice, tf });
    if (i + SIZE >= words.length) break;
  }
  return chunks;
}

export interface Retrieved {
  references: RagReference[];
  contexts: { name: string; text: string; score: number }[];
}

/** TF-IDF cosine retrieval over the included files' text. */
export function retrieve(query: string, includedFileIds: string[], k = 5): Retrieved {
  // Server-authoritative inclusion: intersect the caller's set with what is
  // actually included on disk right now, so unselecting a file (or hiding the
  // source) removes it from the very next answer — a stale client cannot leak
  // an excluded file into retrieval.
  const authoritative = new Set(activeIncludedFileIds());
  const idset = new Set(includedFileIds.filter((id) => authoritative.has(id)));
  const nodes = walk(vaultDir()).filter((n) => n.kind === "file" && idset.has(n.id));

  const chunks: Chunk[] = [];
  for (const n of nodes) {
    const text = readText(n.id);
    if (text.trim()) chunks.push(...chunksOf(text, n.id, n.name));
  }
  if (chunks.length === 0) return { references: [], contexts: [] };

  // idf over chunks
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = chunks.length;
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const qtf = new Map<string, number>();
  for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  if (qtf.size === 0) return { references: [], contexts: [] };

  const vec = (tf: Map<string, number>) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = f * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const q = vec(qtf);

  const scored = chunks.map((c) => {
    const d = vec(c.tf);
    let dot = 0;
    for (const [t, w] of q.v) dot += w * (d.v.get(t) ?? 0);
    return { c, score: dot / (q.norm * d.norm) };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (top.length === 0) return { references: [], contexts: [] };

  const max = top[0].score || 1;
  // one reference per file (best chunk), but keep all top chunks as context
  const seen = new Set<string>();
  const references: RagReference[] = [];
  for (const { c, score } of top) {
    if (seen.has(c.fileId)) continue;
    seen.add(c.fileId);
    references.push({
      fileId: c.fileId,
      name: c.name,
      snippet: c.text.slice(0, 240).trim() + (c.text.length > 240 ? "…" : ""),
      score: Math.min(1, score / max),
    });
  }
  const contexts = top.map(({ c, score }) => ({
    name: c.name,
    text: c.text,
    score: Math.min(1, score / max),
  }));
  return { references, contexts };
}
