/**
 * "What the AI sees" — the TS twin of the read-only file inspector (openspec:
 * add-file-inspector). Mirrors lighthouse-core inspect.rs for the SHARED fields
 * and OMITS the Rust-engine-only ones.
 *
 * PARITY: the twin returns { name, included, localOnly, extractPreview,
 * chunkMode, testSearch? } and deliberately OMITS { fromOcr, chunkCount,
 * columns, indexedAt, fresh } — OCR, the persistent chunk index, and the column
 * catalog are Rust-engine-only (docs/ts-twin.md). It never fabricates a value:
 * an omitted field is simply absent, and the UI renders it as "desktop only".
 *
 * PURE READ: it calls listNodes / docText / retrieve — never a setter.
 */
import type { FileInspection } from "@/contracts";
import { docText, listNodes, retrieve } from "./vault";

/** A glance at the extracted text, not the whole document. */
const PREVIEW_CHARS = 600;
/** Test-search top-K (bounded — the panel is a glance). */
const TEST_SEARCH_K = 5;
/** Per-hit text cap (matches the retrieval snippet cap). */
const HIT_CHARS = 240;

/** The tabular set the chunker keys on. KEEP IN SYNC with chunkTextsNamed. */
const TABULAR_EXT = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"];
const isTabular = (name: string): boolean => {
  const lower = name.toLowerCase();
  return TABULAR_EXT.some((e) => lower.endsWith(e));
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
  };

  // Extract preview — the bounded slice of text the model would read. Null for a
  // rich format the twin can't parse (images, .doc, .pptx, .odt, .rtf) or a
  // genuinely empty file: it stays findable by name only.
  const doc = await docText(fileId, PREVIEW_CHARS);
  if (doc) out.extractPreview = doc.text;

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
