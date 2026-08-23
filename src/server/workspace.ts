/**
 * The session workspace (openspec: refocus-chat-attachments): the only
 * corpus the app has. Each conversation owns a manifest of up to
 * MAX_ATTACHMENTS files; bytes live once in a content-addressed blob store
 * shared by every conversation. Ids resolve through the manifest — a map
 * lookup — never a directory walk, and blobs are write-once, so every
 * downstream cache keyed by the blob path is effectively keyed by content
 * hash.
 *
 * PARITY: the byte-parallel twin of lighthouse-core/src/workspace.rs — id
 * minting, manifest layout, cap messages, and sweep rules are identical.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appStateDir, readJson, writeJson } from "./config";
import { extractRichText, isRichFile } from "./extract";

/**
 * The corpus cap — the product IS "a small group of files, done
 * exceptionally well". Attach #11 is refused, never silently dropped.
 * KEEP IN SYNC with workspace.rs::MAX_ATTACHMENTS.
 */
export const MAX_ATTACHMENTS = 10;
/** Per-file byte cap, unchanged from the vault-era upload routes.
 *  KEEP IN SYNC with workspace.rs::MAX_ATTACHMENT_BYTES. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Unreferenced blobs younger than this survive a sweep. */
const SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Manifest envelope version. A mismatch reads as empty (attach rewrites). */
const MANIFEST_V = 1;

/** One attached file as the manifest records it. */
export interface Attachment {
  id: string;
  name: string;
  hash: string;
  size: number;
  addedMs: number;
}

interface Manifest {
  v: number;
  files: Attachment[];
}

function workspaceDir(): string {
  const dir = path.join(appStateDir(), "workspace");
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  return dir;
}

/**
 * Blob filename for a content hash + the name it was attached under:
 * `<hash>.<ext>`, or the bare hash when the name has no extension. The
 * extension rides along because the entire format layer — extraction, table
 * profiling, workbook parsing — sniffs by file extension, and a bare content
 * hash would make every attachment look like an unreadable blob. Same bytes
 * under the same extension still share one blob.
 * KEEP IN SYNC with workspace.rs::blob_name.
 */
function blobName(hash: string, name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext ? `${hash}.${ext}` : hash;
}

/**
 * Blob path for an attachment. Blobs are written once and never renamed, so
 * `(path, mtime, size)`-keyed caches downstream are content-keyed by
 * construction.
 */
export function blobPath(hash: string, name: string): string {
  return path.join(workspaceDir(), "blobs", blobName(hash, name));
}

/**
 * Manifest filename for a conversation id. Ids come from the client, so the
 * filename keeps only [A-Za-z0-9_-]; when sanitization changed anything, a
 * short hash of the original id is appended so distinct ids can never
 * collide on their sanitized forms.
 */
function manifestPath(conversationId: string): string {
  const safe = [...conversationId]
    .filter((c) => /[A-Za-z0-9_-]/.test(c))
    .slice(0, 64)
    .join("");
  const name =
    safe === conversationId && safe !== ""
      ? safe
      : `${safe === "" ? "conv" : safe}-${sha256Hex(Buffer.from(conversationId)).slice(0, 8)}`;
  return path.join(workspaceDir(), `${name}.json`);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Engine-minted attachment id: `att-` + first 12 hex of sha256(hash + name)
 * (the pins/investigation-id precedent). The hash component is fixed-width
 * hex, so the concatenation is unambiguous. Same bytes under the same name
 * mint the same id in every conversation.
 * KEEP IN SYNC with workspace.rs::attachment_id.
 */
export function attachmentId(hash: string, name: string): string {
  return `att-${sha256Hex(Buffer.from(`${hash}${name}`, "utf8")).slice(0, 12)}`;
}

function load(conversationId: string): Manifest {
  const m = readJson<Manifest>(manifestPath(conversationId), { v: MANIFEST_V, files: [] });
  if (!m || m.v !== MANIFEST_V || !Array.isArray(m.files)) return { v: MANIFEST_V, files: [] };
  return m;
}

function store(conversationId: string, m: Manifest): void {
  writeJson(manifestPath(conversationId), m);
}

/**
 * Attach bytes to a conversation. Enforces both caps (the transports narrow,
 * the engine decides), writes the blob once, and records the manifest entry.
 * Re-attaching identical bytes under the same name is idempotent.
 */
export function attach(conversationId: string, name: string, bytes: Buffer): Attachment {
  if (bytes.length === 0) throw new Error("this file is empty");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("files are capped at 25 MB");
  const hash = sha256Hex(bytes);
  const id = attachmentId(hash, name);
  const m = load(conversationId);
  const existing = m.files.find((f) => f.id === id);
  if (existing) return existing;
  if (m.files.length >= MAX_ATTACHMENTS) {
    throw new Error(`a conversation holds at most ${MAX_ATTACHMENTS} files — remove one first`);
  }
  const blob = blobPath(hash, name);
  if (!fs.existsSync(blob)) {
    // Write-once via a temp neighbor + rename so a crashed write can never
    // leave a half blob under a valid hash name.
    const tmp = `${blob}.part`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, blob);
  }
  const att: Attachment = { id, name, hash, size: bytes.length, addedMs: Date.now() };
  m.files.push(att);
  store(conversationId, m);
  return att;
}

/** Remove one attachment. The blob stays for the sweep — another
 *  conversation may reference it. */
export function detach(conversationId: string, id: string): void {
  const m = load(conversationId);
  const before = m.files.length;
  m.files = m.files.filter((f) => f.id !== id);
  if (m.files.length !== before) store(conversationId, m);
}

/** The conversation's attachments, in attach order. */
export function list(conversationId: string): Attachment[] {
  return load(conversationId).files;
}

/**
 * Resolve an attachment id to its display name and blob path — the whole
 * replacement for the vault walk. `null` when the id isn't in the manifest
 * or its blob is gone: callers answer honestly about the gap.
 */
export function resolve(conversationId: string, id: string): { name: string; path: string } | null {
  const f = load(conversationId).files.find((x) => x.id === id);
  if (!f) return null;
  const p = blobPath(f.hash, f.name);
  if (!fs.existsSync(p)) return null;
  return { name: f.name, path: p };
}

/**
 * Eager ingestion (openspec: refocus-chat-attachments, "attach is the moment
 * of work"): warm the extraction cache for rich formats so the first ask
 * never pays it. PARITY: the Rust twin also warms its retrieval index and
 * column catalog — both Rust-only subsystems (the analytics precedent); this
 * twin's retrieval reads text live at ask time.
 */
export async function ingest(att: Attachment): Promise<void> {
  const abs = blobPath(att.hash, att.name);
  if (!fs.existsSync(abs)) return;
  if (isRichFile(att.name)) {
    const ext = path.extname(att.name).slice(1).toLowerCase();
    try {
      await extractRichText(abs, ext);
    } catch {
      /* best-effort: the ask degrades honestly over unreadable files */
    }
  }
}

/**
 * Drop blobs no manifest references any more, once they are older than the
 * grace window. Errors are ignored — a failed sweep retries next startup.
 */
export function sweep(): void {
  const dir = workspaceDir();
  const referenced = new Set<string>();
  for (const e of fs.readdirSync(dir)) {
    if (!e.endsWith(".json")) continue;
    const m = readJson<Manifest>(path.join(dir, e), { v: MANIFEST_V, files: [] });
    if (m && Array.isArray(m.files))
      for (const f of m.files) referenced.add(blobName(f.hash, f.name));
  }
  const cutoff = Date.now() - SWEEP_AGE_MS;
  const blobs = path.join(dir, "blobs");
  for (const name of fs.readdirSync(blobs)) {
    if (referenced.has(name)) continue;
    try {
      const st = fs.statSync(path.join(blobs, name));
      if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(blobs, name));
    } catch {
      /* sweep is best-effort */
    }
  }
}
