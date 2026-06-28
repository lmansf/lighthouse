/**
 * Text extraction for "rich" document formats (PDF, Word, Excel).
 *
 * The vault reads plain-text files directly (see readText in vault.ts); this
 * module covers binary formats that need a parser to recover their text. Each
 * format is decoded lazily — the parser is imported only when a file of that
 * type is first read, so a vault of only text files pays nothing for these deps.
 *
 * Extraction is comparatively expensive (a multi-page PDF can take a moment), so
 * results are cached on disk keyed by the file's mtime+size. A given file is
 * parsed once; later queries reuse the cached text until the file changes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir } from "./config";

/** Document formats we recover text from beyond plain UTF-8 files. */
export const RICH_EXT = new Set([".pdf", ".docx", ".xlsx", ".xls"]);

export const isRichFile = (name: string): boolean =>
  RICH_EXT.has(path.extname(name).toLowerCase());

/** Cap extracted text so one huge document can't dominate memory or the index. */
const MAX_EXTRACT_BYTES = 1_000_000;
/**
 * Refuse to parse a source file larger than this. Uploads are capped at 25 MB,
 * but a *referenced* file (linked in place) can be arbitrarily large; this keeps
 * a giant PDF from blowing up memory during a parse.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Byte-cap (not char-cap) so multi-byte text can't slip past the budget. */
function clamp(text: string): string {
  const buf = Buffer.from(text, "utf8");
  return buf.length <= MAX_EXTRACT_BYTES
    ? text
    : buf.subarray(0, MAX_EXTRACT_BYTES).toString("utf8");
}

async function extractPdf(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

async function extractXlsx(buf: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  // Flatten every sheet to CSV under its name, so cell text is searchable and
  // the sheet a hit came from is recoverable.
  return wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    return `# ${name}\n${csv}`;
  }).join("\n\n");
}

async function extractByExt(abs: string, ext: string): Promise<string> {
  const buf = await fs.promises.readFile(abs);
  switch (ext) {
    case ".pdf":
      return extractPdf(buf);
    case ".docx":
      return extractDocx(buf);
    case ".xlsx":
    case ".xls":
      return extractXlsx(buf);
    default:
      return "";
  }
}

// --- on-disk cache (parse once per file version) ---

/**
 * Cache schema version. Bump this whenever the extraction logic changes in a
 * way that could alter output (or to discard entries written by a buggy older
 * build). Entries tagged with a different version are ignored, forcing a
 * one-time re-extraction — this is how a user recovers from PDFs that an
 * earlier version cached as empty.
 */
const CACHE_VERSION = 2;

interface CacheRecord {
  v: number;
  key: string;
  text: string;
}

function cacheDir(): string {
  const dir = path.join(stateDir(), "cache", "extract");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(abs: string): string {
  return path.join(cacheDir(), crypto.createHash("sha1").update(abs).digest("hex") + ".json");
}

/**
 * Return a rich file's extracted text, parsing it only on a cache miss. The
 * cache key is the file's mtime+size, so editing the file re-extracts it. Any
 * failure (corrupt / password-protected / unsupported variant) yields "" — the
 * file still appears in the vault and is findable by name; it just contributes
 * no content to retrieval.
 */
export async function extractRichText(abs: string, ext: string): Promise<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return "";
  }
  if (stat.size > MAX_SOURCE_BYTES) return "";

  const key = `${stat.mtimeMs}:${stat.size}`;
  const cp = cachePath(abs);
  try {
    const hit = JSON.parse(fs.readFileSync(cp, "utf8")) as Partial<CacheRecord>;
    if (hit && hit.v === CACHE_VERSION && hit.key === key && typeof hit.text === "string") {
      return hit.text;
    }
    // A miss here (no file, stale key, or older schema version) falls through
    // to a fresh parse below — older entries that may have cached an empty
    // result are intentionally re-extracted.
  } catch {
    // no cache yet, or it's corrupt — parse fresh below.
  }

  let text: string;
  try {
    text = clamp((await extractByExt(abs, ext)).trim());
  } catch (err) {
    // Degrade gracefully — one unreadable file must never break a vault scan —
    // but do NOT swallow the cause silently and do NOT cache the failure: log
    // it so empty results are diagnosable, and leave the cache empty so the
    // next scan retries (a transient parse error shouldn't pin "" forever).
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`extract: failed to read ${path.basename(abs)} (${ext}): ${reason}`);
    return "";
  }
  // Only successful extractions are cached. An empty string here is a genuine
  // result (e.g. a scanned/image-only PDF with no text layer), safe to cache.
  try {
    const record: CacheRecord = { v: CACHE_VERSION, key, text };
    fs.writeFileSync(cp, JSON.stringify(record));
  } catch {
    // Cache write is best-effort; a read-only state dir just means re-parsing.
  }
  return text;
}
