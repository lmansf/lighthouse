/**
 * "What the AI sees" — the TS twin of the read-only file inspector (openspec:
 * add-file-inspector). Mirrors lighthouse-core inspect.rs for the SHARED fields
 * and OMITS the Rust-engine-only ones.
 *
 * PARITY: the twin returns { name, included, localOnly, extractPreview,
 * chunkMode, ocrAvailability?, testSearch? } and deliberately OMITS { fromOcr,
 * chunkCount, columns, indexedAt, fresh } — OCR, the persistent chunk index,
 * and the column catalog are Rust-engine-only (docs/ts-twin.md). It never
 * fabricates a value: an omitted field is simply absent, and `ocrAvailability`
 * carries this engine's own honest constant ("unsupported"), not a fake of the
 * Rust engine's live verdict.
 *
 * PURE READ: it calls listNodes / docText / retrieve — never a setter.
 */
import type { FileInspection, PreviewTable } from "@/contracts";
import { docText, inclusionAttribution, listNodes, localOnlyAttribution, retrieve } from "./vault";

/** A glance at the extracted text, not the whole document. */
const PREVIEW_CHARS = 600;
/** Test-search top-K (bounded — the panel is a glance). */
const TEST_SEARCH_K = 5;
/** Per-hit text cap (matches the retrieval snippet cap). */
const HIT_CHARS = 240;
/** CSV/TSV parsed-preview bounds — a glance at the table's shape. KEEP IN SYNC
 *  with inspect.rs PREVIEW_TABLE_ROWS / _COLS / _CHARS. */
const PREVIEW_TABLE_ROWS = 5;
const PREVIEW_TABLE_COLS = 8;
const PREVIEW_TABLE_CHARS = 2000;

/** Parse the head of a delimited file into a bounded (header, rows) preview —
 *  the SAME shape inspect.rs::parse_preview_table produces, so the shared
 *  `previewTable` field is alike across engines. Undefined unless there's at
 *  least a 2-column header plus one data row. */
function parsePreviewTable(text: string, delim: string): PreviewTable | undefined {
  // The bounded slice may end mid-line; keep only whole lines so a partial
  // trailing row never shows (the caller still flags `truncated`).
  const sourceTruncated = text.length >= PREVIEW_TABLE_CHARS;
  const whole = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (sourceTruncated && whole.length > 1) whole.pop();
  const lines = whole.filter((l) => l.trim() !== "");
  if (lines.length === 0) return undefined;
  const split = (line: string): string[] =>
    line.split(delim).slice(0, PREVIEW_TABLE_COLS).map((c) => c.trim());
  const header = split(lines[0]);
  if (header.length < 2) return undefined;
  const width = header.length;
  const rows: string[][] = [];
  let moreRows = false;
  for (const line of lines.slice(1)) {
    if (rows.length >= PREVIEW_TABLE_ROWS) {
      moreRows = true;
      break;
    }
    const cells = split(line);
    while (cells.length < width) cells.push(""); // align every row to header width
    rows.push(cells.slice(0, width));
  }
  if (rows.length === 0) return undefined;
  const wide = lines[0].split(delim).length > PREVIEW_TABLE_COLS;
  return { header, rows, truncated: sourceTruncated || moreRows || wide };
}

/** The tabular set the chunker keys on. KEEP IN SYNC with chunkTextsNamed. */
const TABULAR_EXT = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"];
const isTabular = (name: string): boolean => {
  const lower = name.toLowerCase();
  return TABULAR_EXT.some((e) => lower.endsWith(e));
};

/** Files OCR could ever be involved in extracting: raster images + PDFs.
 *  KEEP IN SYNC with extract.rs `ocr_could_apply` (OCR_IMAGE_EXT + ".pdf"). */
const OCR_RELEVANT_EXT = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf"];
const ocrCouldApply = (name: string): boolean => {
  const lower = name.toLowerCase();
  return OCR_RELEVANT_EXT.some((e) => lower.endsWith(e));
};

export async function inspect(fileId: string, query?: string): Promise<FileInspection> {
  // Name + effective inclusion + local-only come from the SAME painted walk the
  // explorer renders, so the panel's labels match the file's row exactly.
  const node = listNodes().find((n) => n.kind === "file" && n.id === fileId);
  if (!node) return {}; // unknown / removed id: nothing to inspect

  const out: FileInspection = {
    name: node.name,
    included: node.ragIncluded,
    localOnly: node.localOnly === true,
    chunkMode: isTabular(node.name) ? "tabular" : "prose",
    // Attribution ("included by rule 'spreadsheets in /reports'", openspec:
    // add-curation-rules) — the same decision layer the walk above resolved,
    // reported as WHY. Shared field: this twin computes it with full fidelity.
    includedBy: inclusionAttribution(fileId),
    localOnlyBy: localOnlyAttribution(fileId),
  };

  // OCR availability (iOS field patch 3 §1): a SHARED field with per-engine
  // honest values. This engine has no OCR at all, so for the files OCR could
  // apply to (images + PDFs) it reports the constant "unsupported" — a true
  // statement, not a fake of the Rust engine's live verdict ("ready" | "off" |
  // "missing-models"). PARITY: inspect.rs fills the same field via
  // ocr::availability(), gated on the same extension set.
  if (ocrCouldApply(node.name)) out.ocrAvailability = "unsupported";

  // Extract preview — the bounded slice of text the model would read. Null for a
  // rich format the twin can't parse (images, .doc, .pptx, .odt, .rtf) or a
  // genuinely empty file: it stays findable by name only.
  const doc = await docText(fileId, PREVIEW_CHARS);
  if (doc) out.extractPreview = doc.text;

  // CSV/TSV also get a small parsed table preview (header + first rows) so the
  // panel shows the table's SHAPE, not just a raw text slice. A pure parse of a
  // bounded head — SHARED with the Rust engine (both parse delimited text the
  // same way). Non-delimited tabular files (xlsx) keep the text preview only.
  const lowerName = node.name.toLowerCase();
  if (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv")) {
    const delim = lowerName.endsWith(".tsv") ? "\t" : ",";
    const table = await docText(fileId, PREVIEW_TABLE_CHARS);
    if (table) out.previewTable = parsePreviewTable(table.text, delim);
  }

  // File-scoped test-search — the EXISTING lexical scorer over ONLY this file id,
  // on the device path (a local preview, never sent to a provider, so local-only
  // stays searchable). `contexts` are all scoped to the one file, so this is that
  // file's top chunks with scores.
  const q = query?.trim();
  if (q) {
    const { contexts } = await retrieve(q, [fileId], TEST_SEARCH_K, [], [], false);
    out.testSearch = contexts.map((c) => ({ text: c.text.slice(0, HIT_CHARS), score: c.score }));
  }

  // PARITY: fromOcr, chunkCount, columns, indexedAt, and fresh are intentionally
  // NOT set — OCR, the persistent index, and the column catalog are Rust-engine-
  // only (docs/ts-twin.md). Omitting beats faking; the UI degrades to "desktop
  // only" for each.
  return out;
}
