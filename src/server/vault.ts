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
  stateDir,
  statePath,
  readJson,
  writeJson,
} from "./config";
import { effectiveDefaultInclusion } from "./profile";
import { recordEvent } from "./license";
import { isRichFile, extractRichText } from "./extract";

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
  invalidateWalkCache(); // inclusion flags and references feed the walked tree
}

/**
 * Short-lived snapshot of the walked tree. A walk is a full synchronous
 * recursive scan of the vault AND every linked folder; with a large tree (a
 * whole desktop linked in, thousands of files) re-walking on every API call
 * blocks the server's event loop and the entire app reads as frozen. Every
 * in-app mutation invalidates the snapshot immediately, so app actions never
 * see stale data; the TTL only bounds how long a change made OUTSIDE the app
 * (files copied in by hand) can go unnoticed between scans.
 */
const WALK_TTL_MS = 3_000;
let walkCache: { root: string; nodes: FileNode[]; at: number } | null = null;

function invalidateWalkCache(): void {
  walkCache = null;
}

/**
 * Resolve a node id to its real absolute path on disk (vault file or referenced
 * item), refusing any path that escapes the vault / its reference. Used to open
 * a file in its native application from a chat citation.
 */
export function resolveNodePath(nodeId: string): string {
  return resolveAbs(nodeId, loadState());
}

/**
 * Whether absent inclusion flags default to INCLUDED. Honors the user's explicit
 * onboarding choice first (`include` ⇒ new files are searchable by default, the
 * user opts pieces out; `exclude` ⇒ nothing in until toggled on), falling back
 * to the `default_inclusion` A/B experiment variant when they haven't chosen.
 * Resolved once per walk and threaded into isEffectivelyIncluded so a big tree
 * isn't re-reading the preference per node.
 */
function defaultIncluded(): boolean {
  return effectiveDefaultInclusion() === "include";
}

/**
 * Effective inclusion. An ancestor folder explicitly excluded always forces a
 * node out (ancestor exclusion wins). For an absent own flag the default is the
 * experiment's: EXCLUDED under `opt_in` (the original behavior), INCLUDED under
 * `opt_out`. Consequences, by design:
 *  - opt_in: anything new (added from the computer, anywhere) defaults out;
 *  - opt_out: anything new defaults in until the user opts it out;
 *  - an excluded folder forces every descendant out, even a file moved in
 *    later that carried an included flag (ancestor exclusion wins);
 *  - an internal move preserves the node's own flag (see moveNode), but the
 *    ancestor rule above still applies at its new location.
 */
function isEffectivelyIncluded(id: string, state: VaultState, defaultIn = defaultIncluded()): boolean {
  const parts = id.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
    if (state.included[prefix] === false) return false; // an ancestor folder is excluded
  }
  // absent ⇒ included under opt_out, excluded under opt_in
  return defaultIn ? state.included[id] !== false : state.included[id] === true;
}

/**
 * Extensions read directly as UTF-8 text. Rich binary formats (pdf/docx/xlsx)
 * are decoded via parsers in ./extract and are *not* listed here.
 */
// .xml deliberately absent: app-generated sidecar/config XML in linked folders
// kept surfacing as AI sources (0.6.x field report). The files stay visible in
// the explorer — they just never become chunks. KEEP IN SYNC with vault.rs.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".csv", ".tsv", ".json",
  ".yaml", ".yml", ".log", ".html", ".htm", ".js", ".ts", ".tsx",
  ".jsx", ".py", ".java", ".go", ".rb", ".rs", ".c", ".h", ".cpp", ".sh",
  ".sql", ".toml", ".ini", ".env", ".css",
]);

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".html": "text/html", ".htm": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
};

const isTextFile = (name: string) => TEXT_EXT.has(path.extname(name).toLowerCase());
const mimeOf = (name: string) => MIME[path.extname(name).toLowerCase()];

/** A node id is its POSIX-relative path from the vault root (stable + unique). */
function walk(root: string): FileNode[] {
  if (walkCache && walkCache.root === root && Date.now() - walkCache.at < WALK_TTL_MS) {
    return walkCache.nodes;
  }
  const nodes = walkUncached(root);
  walkCache = { root, nodes, at: Date.now() };
  return nodes;
}

function walkUncached(root: string): FileNode[] {
  const out: FileNode[] = [];
  const state = loadState();
  const defaultIn = defaultIncluded(); // resolve the variant once for this walk
  const included = (id: string) => isEffectivelyIncluded(id, state, defaultIn);

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
  // A full-tree listing (no parentId) is the app's regular vault scan - the one
  // hook that also catches files copied in / deleted OUTSIDE the app. Diff it
  // against the last snapshot to emit privacy-safe presence counts.
  if (parentId === undefined) {
    recordPresenceDiff(all);
    return all;
  }
  return all.filter((n) => n.parentId === parentId);
}

const usageSnapshotPath = () => path.join(stateDir(), "usage-snapshot.json");

/**
 * Emit privacy-safe file-presence telemetry by diffing the current tree against
 * the last snapshot: one `file_added` per newly-appeared node, one
 * `file_removed` per disappeared one. The payload is COUNTS ONLY - at most a
 * coarse `{ kind }` - never a name, path, extension, or size.
 *
 * First run seeds the snapshot silently (no events), so a pre-loaded demo vault
 * never fires a spurious burst. Best-effort: wrapped so a telemetry failure can
 * never break or slow the scan that produced `nodes`.
 */
function recordPresenceDiff(nodes: FileNode[]): void {
  try {
    const current: Record<string, "file" | "folder"> = {};
    for (const n of nodes) {
      if (n.kind === "file" || n.kind === "folder") current[n.id] = n.kind;
    }
    const snap = readJson<{ ids?: Record<string, "file" | "folder"> } | null>(
      usageSnapshotPath(),
      null,
    );
    if (!snap?.ids) {
      // First run: seed without emitting (don't count existing files as "added").
      writeJson(usageSnapshotPath(), { ids: current });
      return;
    }
    const prev = snap.ids;
    for (const id of Object.keys(current)) {
      if (!(id in prev)) void recordEvent("file_added", { kind: current[id] });
    }
    for (const id of Object.keys(prev)) {
      if (!(id in current)) void recordEvent("file_removed", { kind: prev[id] });
    }
    writeJson(usageSnapshotPath(), { ids: current });
  } catch {
    /* presence telemetry is best-effort; never break a scan */
  }
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
 * Rename a node in place (same parent, new basename), carrying its inclusion
 * flags and its subtree's. Refuses empty / dotfile / separator names and an
 * existing destination. Vault-resident nodes only.
 */
export function renameNode(id: string, newName: string): { newId: string } {
  if (!id) throw new Error("id required");
  const clean = newName.trim();
  if (!clean || clean.startsWith(".") || clean.includes("/") || clean.includes("\\")) {
    throw new Error("invalid name");
  }
  const fromAbs = safeAbs(id);
  if (!fs.existsSync(fromAbs)) throw new Error("source not found");
  const slash = id.lastIndexOf("/");
  const newId = slash >= 0 ? `${id.slice(0, slash)}/${clean}` : clean;
  if (newId === id) return { newId }; // no-op rename
  const toAbs = safeAbs(newId);
  if (fs.existsSync(toAbs)) throw new Error("destination already exists");
  fs.renameSync(fromAbs, toAbs);
  // Remap the node and every descendant's inclusion flag onto the new prefix.
  const state = loadState();
  const next: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(state.included)) {
    if (k === id) next[newId] = v;
    else if (k.startsWith(`${id}/`)) next[newId + k.slice(id.length)] = v;
    else next[k] = v;
  }
  state.included = next;
  saveState(state);
  return { newId };
}

/**
 * Create an empty folder under a parent (or the vault root when null). Returns
 * its id. Refuses empty / dotfile / separator names and existing paths.
 */
export function createFolder(parentId: string | null, name: string): { newId: string } {
  const clean = name.trim();
  if (!clean || clean.startsWith(".") || clean.includes("/") || clean.includes("\\")) {
    throw new Error("invalid folder name");
  }
  const newId = parentId ? `${parentId}/${clean}` : clean;
  const abs = safeAbs(newId);
  if (fs.existsSync(abs)) throw new Error("a file or folder with that name already exists");
  fs.mkdirSync(abs, { recursive: true });
  invalidateWalkCache(); // a new (empty, excluded) folder no state write announced
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
  invalidateWalkCache(); // a new file exists that no state write announced
  return { newId: finalId };
}

/**
 * Write an artifact into a named vault folder ("Lighthouse Results",
 * "Lighthouse Notes") — openspec: add-answer-artifacts. The name hint is
 * REPAIRED, never rejected (separators and control chars become dashes,
 * leading dots shed, length capped), then addFile supplies the collision
 * suffix — an existing file is never overwritten. KEEP IN SYNC with
 * native vault.rs::write_artifact.
 */
export function writeArtifact(
  subdir: string,
  nameHint: string,
  ext: string,
  bytes: Buffer,
): { id: string; name: string } {
  let clean = [...nameHint]
    .slice(0, 80)
    .map((c) => {
      const code = c.charCodeAt(0);
      // Control chars = C0 + DEL + C1, matching Rust's char::is_control().
      return c === "/" || c === "\\" || code < 32 || (code >= 127 && code <= 159) ? "-" : c;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (!clean) clean = "result";
  const { newId } = addFile(`${clean}.${ext}`, bytes, subdir);
  return { id: newId, name: newId.split("/").pop() ?? newId };
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
    // A path INSIDE an already-linked folder is already indexed as a descendant
    // of that reference. Resolve it to that existing node id (the same id the
    // walk produces) instead of re-linking, so a drop of an already-covered file
    // succeeds idempotently rather than failing as an overlap.
    if (r.kind === "folder" && isWithin(rp, abs)) {
      const rel = path.relative(rp, abs).split(path.sep).join("/");
      return { id: `${id}/${rel}`, kind };
    }
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

/**
 * Remove a node from the vault — non-destructively. A linked (referenced) item
 * is simply unlinked, leaving the user's real external files untouched. A
 * vault-resident file or folder is MOVED to a recoverable trash directory
 * (`.rag-vault/trash/<date>/…`) rather than deleted, and its inclusion flags
 * (and its subtree's) are dropped. The trash lives under the hidden state dir,
 * so it never reappears in the tree, and can be restored by hand.
 */
/** A token returned by removeFromVault; pass to restoreFromVault to undo. */
export type RestoreDescriptor =
  | { kind: "unlink"; root: string; path: string; included: Record<string, boolean> }
  | { kind: "flags"; included: Record<string, boolean> }
  | { kind: "trash"; id: string; trashPath: string; included: Record<string, boolean> };

/** Collect + drop the inclusion flags for a node and its subtree, returning the
 *  removed (id → included) pairs so a restore can put them back exactly. */
function takeIncludedSubtree(
  state: ReturnType<typeof loadState>,
  nodeId: string,
): Record<string, boolean> {
  const taken: Record<string, boolean> = {};
  for (const k of Object.keys(state.included)) {
    if (k === nodeId || k.startsWith(`${nodeId}/`)) {
      taken[k] = state.included[k];
      delete state.included[k];
    }
  }
  return taken;
}

export function removeFromVault(nodeId: string): RestoreDescriptor {
  const state = loadState();
  const refId = refIdOf(nodeId, state.references);
  // The reference root itself: unlink the whole link; never move or delete the
  // real external files. Restore re-links the same real path.
  if (refId === nodeId) {
    const realPath = state.references[nodeId]?.path ?? "";
    const included = takeIncludedSubtree(state, nodeId);
    delete state.references[nodeId];
    saveState(state);
    return { kind: "unlink", root: nodeId, path: realPath, included };
  }
  // A node *inside* a linked folder: unlinking the whole reference here would
  // drop every sibling too, and we must never touch the user's real external
  // files. Scope the removal to just this node's subtree by dropping its
  // inclusion flags; the link itself stays intact.
  if (refId) {
    const included = takeIncludedSubtree(state, nodeId);
    saveState(state);
    return { kind: "flags", included };
  }
  const abs = safeAbs(nodeId); // refuses to escape the vault
  if (abs === vaultDir()) throw new Error("cannot remove the vault root");
  const included = takeIncludedSubtree(state, nodeId);
  if (fs.existsSync(abs)) {
    const day = new Date().toISOString().slice(0, 10);
    const trashDir = path.join(stateDir(), "trash", day);
    fs.mkdirSync(trashDir, { recursive: true });
    let dest = path.join(trashDir, path.basename(nodeId));
    const ext = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    for (let i = 1; fs.existsSync(dest); i++) dest = `${base} (${i})${ext}`;
    fs.renameSync(abs, dest);
    saveState(state);
    return { kind: "trash", id: nodeId, trashPath: dest, included };
  }
  saveState(state);
  return { kind: "flags", included };
}

/**
 * Reverse a removeFromVault using the descriptor it returned. Non-destructive:
 * refuses to overwrite if something now occupies the original location. Returns
 * the node's (possibly new) id.
 */
export function restoreFromVault(desc: RestoreDescriptor): { id?: string; ok?: boolean } {
  if (desc.kind === "unlink") {
    if (!desc.path) throw new Error("nothing to restore");
    const { id: newRoot } = addReference(desc.path); // may get a fresh extN id
    const state = loadState();
    for (const [k, v] of Object.entries(desc.included)) {
      const newKey =
        k === desc.root
          ? newRoot
          : k.startsWith(`${desc.root}/`)
            ? `${newRoot}/${k.slice(desc.root.length + 1)}`
            : k;
      state.included[newKey] = v;
    }
    saveState(state);
    return { id: newRoot };
  }
  if (desc.kind === "flags") {
    const state = loadState();
    for (const [k, v] of Object.entries(desc.included)) state.included[k] = v;
    saveState(state);
    return { ok: true };
  }
  // trash: move the file back to its original location, refusing to clobber.
  const abs = safeAbs(desc.id);
  if (fs.existsSync(abs)) throw new Error("something already exists at the original location");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.renameSync(desc.trashPath, abs);
  const state = loadState();
  for (const [k, v] of Object.entries(desc.included)) state.included[k] = v;
  saveState(state);
  return { id: desc.id };
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
  const defaultIn = defaultIncluded();
  return walk(vaultDir())
    .filter((n) => n.kind === "file" && isEffectivelyIncluded(n.id, state, defaultIn))
    .map((n) => n.id);
}

/**
 * Per-file read cap. A vault can hold very large text files (e.g. a 150 MB CSV
 * dataset); reading and chunking one whole would stall — or OOM — a query. The
 * first slice is more than enough for relevance matching, so we cap the read.
 */
const MAX_TEXT_BYTES = 1_000_000;

/**
 * Read a file's text, or "" for unsupported/binary types. Resolves the node id
 * to its real path first, so referenced files (whose id is a synthetic `extN`
 * with no extension) are read — and type-checked — by their true path. Files
 * larger than MAX_TEXT_BYTES are read up to that prefix only.
 */
async function readText(nodeId: string, state: VaultState): Promise<string> {
  let abs: string;
  try {
    abs = resolveAbs(nodeId, state);
  } catch {
    return "";
  }
  return readTextAbs(abs);
}

/**
 * Read text from an absolute path — used for vault files and for the local
 * mirror of a cloud (SharePoint) file. Rich formats (pdf/docx/xlsx) go through
 * the parser with its own size handling and cache; plain text is read directly,
 * capped at MAX_TEXT_BYTES.
 */
export async function readTextAbs(abs: string): Promise<string> {
  if (isRichFile(abs)) return extractRichText(abs, path.extname(abs).toLowerCase());
  if (!isTextFile(abs)) return "";
  try {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      size = 0;
    }
    if (size <= MAX_TEXT_BYTES) return fs.readFileSync(abs, "utf8");
    // Large file: read only the first MAX_TEXT_BYTES so it can't blow up memory
    // or stall the query. Enough text to match on.
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_TEXT_BYTES);
      const read = fs.readSync(fd, buf, 0, MAX_TEXT_BYTES, 0);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const STOP = new Set(
  "the a an and or of to in is are for on with as at by from this that it be do does have any there my our your you me i".split(
    " ",
  ),
);
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((t) => !STOP.has(t)) ?? [];
}

/** Crude singularizer so "cards" matches "card". */
function singular(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

/** Searchable tokens from a file's name and path (so it's findable by what it's
 *  called, not only by its contents). */
function nameTokensOf(id: string, name: string): string[] {
  return tokenize(`${id.replace(/\//g, " ")} ${name}`);
}

/** Extension-ish tokens that don't count as "naming" a file in a question. */
const EXT_TOKENS = new Set([
  "xlsx", "xlsm", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
  "pptx", "json", "html", "log",
]);

/**
 * Vault files the question NAMES (every meaningful name token appears in the
 * question) that are NOT currently included — feeds the deterministic
 * "it exists but the AI can't see it" note in the answer pipeline. KEEP IN
 * SYNC with vault.rs::named_but_excluded. Returns display names, capped at 2.
 */
export function namedButExcluded(question: string): string[] {
  const qtokens = tokenize(question).map(singular);
  if (qtokens.length === 0) return [];
  const active = new Set(activeIncludedFileIds());
  const out: string[] = [];
  for (const node of walk(vaultDir())) {
    if (node.kind !== "file" || active.has(node.id)) continue;
    const meaningful = tokenize(node.name).filter((t) => t.length >= 3 && !EXT_TOKENS.has(t));
    if (meaningful.length === 0 || !meaningful.some((t) => t.length >= 4)) continue;
    const allPresent = meaningful.every((nt0) => {
      const nt = singular(nt0);
      return qtokens.some((q) => q === nt || q.includes(nt) || (q.length >= 3 && nt.includes(q)));
    });
    if (allPresent) {
      out.push(node.name);
      if (out.length === 2) break;
    }
  }
  return out;
}

/**
 * How strongly the query matches a file's name/path tokens. Substring matching
 * lets "credit"/"card" hit a file literally named "creditcard.csv", and the
 * singularizer bridges "cards"→"card". `strong` requires a real (≥4-char) word
 * to match, so noise like "csv" alone doesn't qualify a file.
 */
function nameMatch(qTokens: string[], nameToks: string[]): { hits: number; strong: boolean } {
  let hits = 0;
  let strong = false;
  for (const raw of qTokens) {
    const q = singular(raw);
    if (q.length < 3) continue;
    const hit = nameToks.some((nt0) => {
      const nt = singular(nt0);
      return nt === q || nt.includes(q) || (nt.length >= 3 && q.includes(nt));
    });
    if (hit) {
      hits++;
      if (raw.length >= 4) strong = true;
    }
  }
  return { hits, strong };
}

/**
 * The named-file pin's target, if any: the single file whose meaningful
 * name/path tokens the question covers substantially enough to read as "the
 * user named this file". Deliberately conservative — the pin FORCES a file
 * into the top-k, so a weak or ambiguous match must select nothing (0.6.2
 * field report: a lone generic token shared with a filename pinned irrelevant
 * files). KEEP IN SYNC with vault.rs::pinned_named_file. Rules:
 *   - coverage: the question must mention at least half of the file's unique
 *     meaningful name tokens (len ≥ 3, extension tokens dropped);
 *   - specificity: ≥ 2 covered tokens, or a single-token name whose token is
 *     ≥ 5 chars ("resume" can pin, "plan" never does);
 *   - uniqueness: two files with the same coverage signature mean the phrase
 *     is generic (meeting-notes-1/2/3…) — pin nothing.
 */
export function pinnedNamedFile(
  qtokens: string[],
  files: { id: string; toks: string[] }[],
): string | null {
  let best: { id: string; c: number; m: number } | null = null;
  let ambiguous = false;
  for (const f of files) {
    const uniq = [
      ...new Set(f.toks.map(singular).filter((t) => t.length >= 3 && !EXT_TOKENS.has(t))),
    ];
    if (uniq.length === 0) continue;
    const covered = uniq.filter((nt) =>
      qtokens.some((q0) => {
        const q = singular(q0);
        return q.length >= 3 && (q === nt || nt.includes(q) || q.includes(nt));
      }),
    );
    const c = covered.length;
    const m = uniq.length;
    const specific = c >= 2 || (m === 1 && (covered[0]?.length ?? 0) >= 5);
    if (c * 2 < m || !specific) continue;
    if (!best) {
      best = { id: f.id, c, m };
      continue;
    }
    // Compare coverage fractions via cross-multiplication (c/m vs bc/bm),
    // then absolute covered count. An exact tie on both is the
    // generic-siblings case.
    const lhs = c * best.m;
    const rhs = best.c * m;
    if (lhs > rhs || (lhs === rhs && c > best.c)) {
      best = { id: f.id, c, m };
      ambiguous = false;
    } else if (lhs === rhs && c === best.c) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? best.id : null;
}

// --- catalog / listing queries -----------------------------------------------
interface Listing {
  label: string;
  match: (name: string) => boolean;
}

const LISTING_EXT: Record<string, string[]> = {
  dataset: [".csv", ".tsv", ".xlsx", ".xlsm", ".xls", ".parquet", ".json", ".arrow", ".feather"],
  spreadsheet: [".csv", ".tsv", ".xlsx", ".xlsm", ".xls"],
  document: [".md", ".markdown", ".txt", ".text", ".rst", ".doc", ".docx", ".pdf", ".rtf", ".odt"],
  pdf: [".pdf"],
};

// Catalog scaffolding tokens — verbs, determiners, and quantifiers that frame a
// "list my files" request but carry no content of their own.
const LISTING_FILLER = new Set([
  "show", "me", "list", "give", "please", "can", "could", "would", "you", "display",
  "name", "names", "enumerate", "tell", "what", "which", "how", "many", "much",
  "are", "there", "is", "do", "does", "did", "i", "we", "my", "our", "the", "a",
  "an", "all", "every", "each", "of", "in", "on", "to", "get", "see", "view",
  "find", "catalog", "catalogue", "count", "number", "total", "available",
  "included", "uploaded", "stored", "have", "has", "any",
]);
// Catalog nouns (singular/plural) that name the kind being enumerated.
const LISTING_NOUN = new Set([
  "file", "files", "dataset", "datasets", "document", "documents", "doc", "docs",
  "pdf", "pdfs", "spreadsheet", "spreadsheets", "csv", "csvs", "table", "tables",
  "source", "sources",
]);
// File-type qualifiers ("csv files", "pdf documents") — extension-like adjectives
// mapped to the concrete extensions they name. A named type narrows the listing
// to exactly those extensions, overriding the broad noun-based kind.
const LISTING_QUALIFIER: Record<string, string[]> = {
  csv: [".csv"], tsv: [".tsv"], xlsx: [".xlsx"], xlsm: [".xlsm"], xls: [".xls"],
  parquet: [".parquet"], json: [".json"], arrow: [".arrow"], feather: [".feather"],
  md: [".md", ".markdown"], markdown: [".md", ".markdown"],
  txt: [".txt", ".text"], text: [".txt", ".text"], rst: [".rst"], rtf: [".rtf"],
  odt: [".odt"], docx: [".docx"], xml: [".xml"], html: [".html"],
};

/**
 * Detect a catalog-style query ("show me all files", "list my datasets", "how
 * many documents") — which should ENUMERATE the included set rather than rank by
 * relevance — and which file kind it refers to. Returns null for an ordinary
 * content question (e.g. "what's in the budget file": singular, no list cue).
 */
function listingIntent(query: string): Listing | null {
  const q = query.toLowerCase();
  const m = q.match(/\b(file|dataset|document|doc|pdf|spreadsheet|csv|table|source)(s)?\b/);
  if (!m) return null;
  const plural = Boolean(m[2]);
  const verb = /\b(show|list|give|display|name|what|which|how many|enumerate|tell)\b/.test(q);
  if (!verb) return null;
  // A singular noun needs an explicit "all/every/list/how many" cue so a content
  // question about one file ("summarize the report file") doesn't trip this.
  const strong = /\b(all|every|each|list|how many|enumerate|catalog|catalogue)\b/.test(q);
  if (!plural && !strong) return null;

  // Only a pure catalog request should enumerate. Strip the catalog scaffolding
  // (verbs, determiners, the catalog noun, and any file-type qualifier); if any
  // meaningful content token survives, this is a content question — e.g. "which
  // documents mention the lawsuit" — so fall through to relevance ranking.
  const tokens = q.match(/[a-z0-9]+/g) ?? [];
  const residual = tokens.filter(
    (t) => !LISTING_FILLER.has(t) && !LISTING_NOUN.has(t) && !LISTING_QUALIFIER[t],
  );
  if (residual.length > 0) return null;

  // A named file-type qualifier (including a catalog noun that is itself a
  // concrete type, e.g. "csvs") narrows the listing to exactly its extensions,
  // overriding the broad noun-based kind below.
  const qualWords: string[] = [];
  const qualExts = new Set<string>();
  for (const t of tokens) {
    const base = LISTING_QUALIFIER[t]
      ? t
      : t.endsWith("s") && LISTING_QUALIFIER[t.slice(0, -1)]
        ? t.slice(0, -1)
        : null;
    if (base && !qualWords.includes(base)) {
      qualWords.push(base);
      for (const e of LISTING_QUALIFIER[base]) qualExts.add(e);
    }
  }
  if (qualExts.size > 0)
    return {
      label: `${qualWords.map((w) => w.toUpperCase()).join("/")} files`,
      match: (name) => qualExts.has(path.extname(name).toLowerCase()),
    };

  const noun = m[1];
  const kind =
    noun === "dataset" || noun === "csv" || noun === "table"
      ? "dataset"
      : noun === "spreadsheet"
        ? "spreadsheet"
        : noun === "document" || noun === "doc"
          ? "document"
          : noun === "pdf"
            ? "pdf"
            : "all";
  if (kind === "all") return { label: "files", match: () => true };
  const exts = new Set(LISTING_EXT[kind]);
  return {
    label: kind === "pdf" ? "PDFs" : `${kind}s`,
    match: (name) => exts.has(path.extname(name).toLowerCase()),
  };
}

/** Enumerate the included files matching a listing intent (capped for huge vaults). */
function buildListing(nodes: FileNode[], intent: Listing): Retrieved {
  const files = nodes.filter((n) => intent.match(n.name));
  if (files.length === 0)
    return {
      references: [],
      contexts: [{ name: `Included ${intent.label}`, text: `No included ${intent.label} found.`, score: 1 }],
    };
  const names = files.map((f) => f.name);
  // Cap the prose list at the same count as the citeable references below so
  // every named file has a corresponding clickable citation.
  const CAP = 50;
  const list =
    `${files.length} included ${intent.label}:\n` +
    names.slice(0, CAP).map((n) => `- ${n}`).join("\n") +
    (names.length > CAP ? `\n…and ${names.length - CAP} more` : "");
  const references: RagReference[] = files.slice(0, CAP).map((f) => ({
    fileId: f.id,
    name: f.name,
    snippet: "",
    score: 1,
  }));
  return { references, contexts: [{ name: `Included ${intent.label}`, text: list, score: 1 }] };
}

interface Chunk { fileId: string; name: string; text: string; tf: Map<string, number>; }

function chunksOf(text: string, fileId: string, name: string): Chunk[] {
  const texts = chunkTextsNamed(name, text);
  return texts.map((slice) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(slice)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { fileId, name, text: slice, tf };
  });
}

/**
 * Structure-aware chunking (docs/analytics-genie.md, B1): tabular extracts
 * chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
 * holding row 400 still carries its column names; prose keeps the 120-word
 * windows. KEEP BYTE-IDENTICAL with the Rust twin (vault.rs chunk_texts_named).
 */
export function chunkTextsNamed(name: string, text: string): string[] {
  const lower = name.toLowerCase();
  const tabular = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"].some((e) => lower.endsWith(e));
  if (tabular) return chunkTabular(name, text);
  return chunkTextsProse(text);
}

function chunkTabular(name: string, text: string): string[] {
  const ROWS = 30, ROW_OVERLAP = 5;
  const lower = name.toLowerCase();
  // Workbook extracts prepend the sheet name above each sheet's CSV; carry
  // BOTH the sheet line and the header row into every chunk.
  const headerLines =
    lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls") ? 2 : 1;
  const chunks: string[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const h = Math.min(headerLines, Math.max(0, lines.length - 1));
    if (lines.length <= h + 1) {
      chunks.push(lines.join("\n"));
      continue;
    }
    const header = lines.slice(0, h).join("\n");
    const data = lines.slice(h);
    for (let i = 0; i < data.length; i += ROWS - ROW_OVERLAP) {
      const body = data.slice(i, i + ROWS).join("\n");
      chunks.push(header ? `${header}\n${body}` : body);
      if (i + ROWS >= data.length) break;
    }
  }
  return chunks;
}

function chunkTextsProse(text: string): string[] {
  const words = text.split(/\s+/);
  const SIZE = 120, OVERLAP = 25;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
    const slice = words.slice(i, i + SIZE).join(" ").trim();
    if (slice) out.push(slice);
    if (i + SIZE >= words.length) break;
  }
  return out;
}

export interface Retrieved {
  references: RagReference[];
  contexts: { name: string; text: string; score: number }[];
}

/** Bound total chunks scored per query so many/large files can't stall it. */
const MAX_TOTAL_CHUNKS = 4000;

/**
 * Retrieval over the included files. Combines TF-IDF cosine over file *content*
 * with a *filename/path* match — so a file is findable both by what it contains
 * and by what it's called. (A file literally named "creditcard.csv" answers
 * "do I have any credit cards?" even when its rows are anonymized numbers.)
 */
export async function retrieve(
  query: string,
  includedFileIds: string[],
  k = 5,
  external: { id: string; name: string; abs: string }[] = [],
  attachmentIds: string[] = [],
): Promise<Retrieved> {
  // Explicit per-question attachments: the user dragged/attached these specific
  // files to *this* question, so honor them directly and scope retrieval to only
  // them — even if they aren't in the global included set (the attach gesture is
  // the consent). They're still validated to real vault files by the `walk`
  // filter below, so a client can't name a file outside the vault.
  //
  // Otherwise, server-authoritative inclusion: intersect the caller's set with
  // what is actually included on disk right now, so unselecting a file (or
  // hiding the source) removes it from the very next answer — a stale client
  // cannot leak an excluded file into retrieval. (Cloud items arrive pre-filtered
  // in `external`, already scoped to enabled, mirrored files by the registry.)
  let idset: Set<string>;
  if (attachmentIds.length > 0) {
    idset = new Set(attachmentIds);
  } else {
    const authoritative = new Set(activeIncludedFileIds());
    idset = new Set(includedFileIds.filter((id) => authoritative.has(id)));
  }
  const nodes = walk(vaultDir()).filter((n) => n.kind === "file" && idset.has(n.id));
  if (nodes.length === 0 && external.length === 0) return { references: [], contexts: [] };

  // Catalog/listing intent ("show me all files", "list my datasets") enumerates
  // vault files (cloud placeholders aren't part of the vault tree); content
  // retrieval below spans both the vault and mirrored cloud files.
  if (nodes.length > 0) {
    const listing = listingIntent(query);
    if (listing) return buildListing(nodes, listing);
  }

  const qtokens = tokenize(query);
  if (qtokens.length === 0) return { references: [], contexts: [] };

  const state = loadState();
  // Unified retrieval items: vault files (read by node id) and mirrored cloud
  // files (read by absolute mirror path). `pathFor` seeds name-token matching —
  // vault ids are real paths; cloud ids are opaque, so match on the name only.
  const items: { id: string; name: string; pathFor: string; read: () => Promise<string> }[] = [
    ...nodes.map((n) => ({ id: n.id, name: n.name, pathFor: n.id, read: () => readText(n.id, state) })),
    ...external.map((e) => ({ id: e.id, name: e.name, pathFor: "", read: () => readTextAbs(e.abs) })),
  ];
  const nameToks = new Map<string, string[]>();
  for (const it of items) nameToks.set(it.id, nameTokensOf(it.pathFor, it.name));
  const preview = new Map<string, string>(); // first content slice, for name-only hits
  const chunks: Chunk[] = [];
  for (const it of items) {
    const text = await it.read();
    if (text.trim()) {
      const cs = chunksOf(text, it.id, it.name);
      preview.set(it.id, cs[0]?.text.slice(0, 240) ?? "");
      for (const c of cs) {
        chunks.push(c);
        if (chunks.length >= MAX_TOTAL_CHUNKS) break;
      }
    }
    if (chunks.length >= MAX_TOTAL_CHUNKS) break;
  }

  // --- content scoring (TF-IDF cosine over chunks) ---
  let scored: { c: Chunk; score: number }[] = [];
  if (chunks.length > 0) {
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const N = chunks.length;
    const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
    const qtf = new Map<string, number>();
    for (const t of qtokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
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
    scored = chunks.map((c) => {
      const d = vec(c.tf);
      let dot = 0;
      for (const [t, w] of q.v) dot += w * (d.v.get(t) ?? 0);
      let score = dot / (q.norm * d.norm);
      // Nudge a chunk up when its file also matches by name (name + content).
      const nm = nameMatch(qtokens, nameToks.get(c.fileId) ?? []);
      if (nm.strong) score += 0.2 * (nm.hits / qtokens.length);
      return { c, score };
    });
  }

  // Build merged candidates: scored content chunks, plus a synthetic entry for
  // any file that matches by name but isn't already represented by its content.
  interface Cand { fileId: string; name: string; text: string; score: number }
  const cands: Cand[] = scored
    .filter((s) => s.score > 0)
    .map((s) => ({ fileId: s.c.fileId, name: s.c.name, text: s.c.text, score: s.score }));
  const present = new Set(cands.map((c) => c.fileId));
  for (const it of items) {
    if (present.has(it.id)) continue;
    const nm = nameMatch(qtokens, nameToks.get(it.id) ?? []);
    if (nm.hits === 0 || !nm.strong) continue;
    const pv = preview.get(it.id) ?? "";
    cands.push({
      fileId: it.id,
      name: it.name,
      text: pv || "(matched by file name; no readable text could be extracted)",
      score: 0.5 + 0.4 * (nm.hits / qtokens.length), // 0.5..0.9
    });
  }

  const sorted = cands.sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, k);
  // Named-file guarantee: a question that strongly names a file MUST surface
  // that file — keyword-heavy chunks from other files can otherwise crowd it
  // out of the top-k (and the Rust engine's hybrid scores make that routine;
  // see vault.rs::retrieve). KEEP IN SYNC with the Rust twin.
  const named = pinnedNamedFile(
    qtokens,
    items.map((it) => ({ id: it.id, toks: nameToks.get(it.id) ?? [] })),
  );
  if (named && !top.some((c) => c.fileId === named)) {
    const best = sorted.find((c) => c.fileId === named);
    if (best) {
      if (top.length >= k && top.length > 0) top.pop();
      top.push(best);
    }
  }
  if (top.length === 0) return { references: [], contexts: [] };

  const max = top[0].score || 1;
  // one reference per file (best chunk), but keep all top chunks as context
  const seen = new Set<string>();
  const references: RagReference[] = [];
  for (const c of top) {
    if (seen.has(c.fileId)) continue;
    seen.add(c.fileId);
    references.push({
      fileId: c.fileId,
      name: c.name,
      snippet: c.text.slice(0, 240).trim() + (c.text.length > 240 ? "…" : ""),
      score: Math.min(1, c.score / max),
    });
  }
  const contexts = top.map((c) => ({
    name: c.name,
    text: c.text,
    score: Math.min(1, c.score / max),
  }));
  return { references, contexts };
}

/**
 * A file's display name + extracted text, for the synthesis pipeline: table
 * profiles need the full content; `previewChars` bounds the map-step fallback
 * used when a generic query's tokens miss the file's content entirely.
 */
export async function docText(
  fileId: string,
  previewChars?: number,
): Promise<{ name: string; text: string } | null> {
  const node = walk(vaultDir()).find((n) => n.kind === "file" && n.id === fileId);
  if (!node) return null;
  const text = await readText(fileId, loadState());
  if (!text.trim()) return null;
  return { name: node.name, text: previewChars ? text.slice(0, previewChars) : text };
}

/**
 * The single INCLUDED vault file the question NAMES, if any — the synth
 * pipeline's single-document-focus detector. Same conservative matcher as the
 * in-retrieve named pin (ambiguity ⇒ null), over the same `nameTokensOf`
 * tokens. KEEP IN SYNC with vault.rs::named_file_target.
 */
export function namedFileTarget(
  question: string,
  includedFileIds: string[],
): [string, string] | null {
  const qtokens = tokenize(question);
  if (qtokens.length === 0) return null;
  const included = new Set(includedFileIds);
  const files = walk(vaultDir())
    .filter((n) => n.kind === "file" && included.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, toks: nameTokensOf(n.id, n.name) }));
  const id = pinnedNamedFile(qtokens, files);
  const hit = files.find((f) => f.id === id);
  return hit ? [hit.id, hit.name] : null;
}

/**
 * A document's display name + ORDERED chunk texts — the same byte-identical
 * chunker the index uses — for whole-document coverage in the synth pipeline
 * (doc-focus). Null when the file is missing or extracts empty. KEEP IN SYNC
 * with vault.rs::doc_chunks.
 */
export async function docChunks(fileId: string): Promise<[string, string[]] | null> {
  const doc = await docText(fileId);
  if (!doc) return null;
  const chunks = chunkTextsNamed(doc.name, doc.text);
  if (chunks.length === 0) return null;
  return [doc.name, chunks];
}
