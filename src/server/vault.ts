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

/** An item referenced in place (not copied) — its real absolute path on disk. */
interface Reference {
  path: string;
  name: string;
  kind: "file" | "folder";
}

interface VaultState {
  sourceAvailable: boolean;
  /** Explicit inclusion overrides keyed by node id; absent ⇒ excluded. */
  included: Record<string, boolean>;
  /**
   * External references keyed by a synthetic node-id prefix (e.g. "ext0"). Their
   * content lives at `path` on disk and is read in place — no copy is made.
   */
  references: Record<string, Reference>;
}

function loadState(): VaultState {
  // Construct fresh objects each call so a missing state file never aliases a
  // shared default that setIncluded() would then mutate for the process life.
  const raw = readJson<Partial<VaultState>>(statePath(), {});
  return {
    sourceAvailable: raw.sourceAvailable ?? true,
    included: { ...(raw.included ?? {}) },
    references: { ...(raw.references ?? {}) },
  };
}

/** True when `child` is `parent` or lives beneath it on disk. */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** True when either path contains the other (overlapping subtrees). */
function pathsOverlap(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/** Which reference, if any, owns a node id (`extN` itself or `extN/...`). */
function refIdOf(id: string, refs: Record<string, Reference>): string | null {
  for (const refId of Object.keys(refs)) {
    if (id === refId || id.startsWith(`${refId}/`)) return refId;
  }
  return null;
}

/**
 * Resolve a node id to an absolute path on disk. Vault-relative ids map under
 * the vault directory; referenced ids (`extN/...`) map under their registered
 * real path. Both reject paths that escape their base.
 */
function resolveAbs(id: string, state: VaultState): string {
  const refId = refIdOf(id, state.references);
  if (!refId) return safeAbs(id);
  const base = path.resolve(state.references[refId].path);
  const sub = id.slice(refId.length).replace(/^\//, "");
  const abs = path.resolve(base, sub);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error("path escapes the reference");
  }
  return abs;
}
function saveState(s: VaultState): void {
  writeJson(statePath(), s);
}

/**
 * Effective inclusion — default is EXCLUDED. A node counts as included only
 * when its own flag is explicitly `true` AND no ancestor folder is explicitly
 * excluded. Consequences, by design:
 *  - anything new (added from the computer, anywhere) defaults out;
 *  - an excluded folder forces every descendant out, even a file moved in
 *    later that carried an included flag (ancestor exclusion wins);
 *  - an internal move preserves the node's own flag (see moveNode), but the
 *    ancestor rule above still applies at its new location.
 */
function isEffectivelyIncluded(id: string, state: VaultState): boolean {
  const parts = id.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    if (state.included[prefix] === false) return false; // an ancestor folder is excluded
  }
  return state.included[id] === true; // absent ⇒ excluded
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
  const included = (id: string) => isEffectivelyIncluded(id, state);

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

  // Referenced items (added via "Link…"): read in place under an `extN` prefix.
  for (const [refId, ref] of Object.entries(state.references)) {
    let exists = true;
    try {
      fs.statSync(ref.path);
    } catch {
      exists = false;
    }
    if (ref.kind === "file") {
      let size: number | undefined;
      try {
        size = fs.statSync(ref.path).size;
      } catch {
        size = undefined;
      }
      out.push({
        id: refId, parentId: null, sourceId: VAULT_SOURCE_ID, name: ref.name,
        kind: "file", mimeType: mimeOf(ref.name), size,
        ragIncluded: included(refId), external: true,
      });
      continue;
    }
    out.push({
      id: refId, parentId: null, sourceId: VAULT_SOURCE_ID, name: ref.name,
      kind: "folder", ragIncluded: included(refId), external: true,
    });
    if (!exists) continue;

    const recurseExt = (absDir: string, parentId: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(absDir, e.name);
        const rel = path.relative(ref.path, abs).split(path.sep).join("/");
        const id = `${refId}/${rel}`;
        if (e.isDirectory()) {
          out.push({
            id, parentId, sourceId: VAULT_SOURCE_ID, name: e.name,
            kind: "folder", ragIncluded: included(id), external: true,
          });
          recurseExt(abs, id);
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
            ragIncluded: included(id), external: true,
          });
        }
      }
    };
    recurseExt(ref.path, refId);
  }
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

/** Resolve a vault-relative id to an absolute path, refusing to escape the vault. */
function safeAbs(relId: string): string {
  const base = vaultDir();
  const abs = path.resolve(base, relId);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error("path escapes the vault");
  }
  return abs;
}

/**
 * Move a file/folder within the vault (an *internal* move), preserving its
 * inclusion setting and that of its subtree. This is what distinguishes an
 * internal move from an external add: an external add is only ever discovered
 * by a fresh scan and so defaults to excluded, whereas an internal move carries
 * its flags across. The ancestor-exclusion rule in isEffectivelyIncluded still
 * governs the effective result at the destination.
 */
export function moveNode(fromId: string, toParentId: string | null): { newId: string } {
  if (!fromId) throw new Error("fromId required");
  const fromAbs = safeAbs(fromId);
  const name = path.basename(fromId);
  const newId = toParentId ? `${toParentId}/${name}` : name;
  const toAbs = safeAbs(newId);
  if (!fs.existsSync(fromAbs)) throw new Error("source not found");
  if (fs.existsSync(toAbs)) throw new Error("destination already exists");

  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);

  // Remap the node and every descendant's inclusion flag onto the new prefix.
  const state = loadState();
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(state.included)) {
    if (k === fromId) next[newId] = v;
    else if (k.startsWith(`${fromId}/`)) next[newId + k.slice(fromId.length)] = v;
    else next[k] = v;
  }
  state.included = next;
  saveState(state);
  return { newId };
}

/**
 * Write an uploaded file into the vault (optionally under a folder). The name is
 * reduced to a basename and collisions get a " (n)" suffix, so a client can
 * never write outside the vault or clobber an existing file. No state entry is
 * created, so an uploaded file is EXCLUDED by default like any external add.
 */
export function addFile(name: string, bytes: Buffer, destParentId: string | null = null): { newId: string } {
  const safeName = path.basename(name).trim();
  if (!safeName || safeName.startsWith(".")) throw new Error("invalid filename");
  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);

  let finalId = destParentId ? `${destParentId}/${safeName}` : safeName;
  let abs = safeAbs(finalId);
  for (let i = 1; fs.existsSync(abs); i++) {
    const alt = `${base} (${i})${ext}`;
    finalId = destParentId ? `${destParentId}/${alt}` : alt;
    abs = safeAbs(finalId);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return { newId: finalId };
}

/**
 * Register a file or folder *in place* (a reference / link) instead of copying
 * it into the vault — this is how the app adds existing files without making a
 * second copy. The path must be an existing absolute path. Re-linking the same
 * path returns the existing reference. Excluded by default, like any new add.
 */
export function addReference(inputPath: string): { id: string; kind: "file" | "folder" } {
  const abs = path.resolve(inputPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("path not found");
  }
  const kind: "file" | "folder" = st.isDirectory() ? "folder" : "file";
  const state = loadState();

  // Never link a path that overlaps the vault (inside it, or an ancestor that
  // contains it) — those files are already first-class vault items and linking
  // them would re-enumerate the same content under a second `extN` id.
  if (pathsOverlap(abs, vaultDir())) {
    throw new Error("overlaps the vault");
  }
  // Re-linking the exact same path is idempotent; reject anything that overlaps
  // an existing reference so the same file can't be indexed twice (which would
  // duplicate retrieval hits and skew the TF-IDF scoring).
  for (const [id, r] of Object.entries(state.references)) {
    const rp = path.resolve(r.path);
    if (rp === abs) return { id, kind: r.kind };
    if (pathsOverlap(abs, rp)) {
      throw new Error("overlaps an existing reference");
    }
  }

  let i = 0;
  let id = `ext${i}`;
  while (state.references[id]) id = `ext${++i}`;
  state.references[id] = { path: abs, name: path.basename(abs) || abs, kind };
  saveState(state);
  return { id, kind };
}

/** Drop a reference (unlink). Leaves the real files on disk untouched. */
export function removeReference(refId: string): void {
  const state = loadState();
  if (!state.references[refId]) return;
  delete state.references[refId];
  for (const k of Object.keys(state.included)) {
    if (k === refId || k.startsWith(`${refId}/`)) delete state.included[k];
  }
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
    .filter((n) => n.kind === "file" && isEffectivelyIncluded(n.id, state))
    .map((n) => n.id);
}

/**
 * Read a file's text, or "" for unsupported/binary types. Resolves the node id
 * to its real path first, so referenced files (whose id is a synthetic `extN`
 * with no extension) are read — and type-checked — by their true path.
 */
function readText(nodeId: string, state: VaultState): string {
  let abs: string;
  try {
    abs = resolveAbs(nodeId, state);
  } catch {
    return "";
  }
  if (!isTextFile(abs)) return "";
  try {
    return fs.readFileSync(abs, "utf8");
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

  const state = loadState();
  const chunks: Chunk[] = [];
  for (const n of nodes) {
    const text = readText(n.id, state);
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
