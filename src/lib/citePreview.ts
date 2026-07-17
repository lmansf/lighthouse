/**
 * [TEAM: chat] Citation → in-app preview (time-savers, feature 4).
 *
 * Clicking a citation chip, a related-file card, or a widget citation button
 * opens the read-only file inspector ("What the AI sees") ON the cited chunk
 * instead of cold-opening the file in its OS app and leaving the user to hunt
 * for the passage. References deliberately carry NO chunk id (adding one would
 * touch the whole retrieval wire on both engines); instead the inspector's
 * file-scoped test-search IS the chunk locator: it re-runs the real per-file
 * retrieval scorer with a query DERIVED from the citation's snippet, and the
 * best-scored hit that still contains that query is the cited chunk.
 *
 * Pure module — no React, no server imports — shared by the chat panel, the
 * widget, the file inspector host, the desktop transport, and the node tests
 * (test/citePreview.test.mjs).
 */

/** DOM CustomEvent that opens the app-wide file-preview inspector. Dispatched
 *  by chat citations; listened for by the FileInspectorHost (app/page.tsx). */
export const INSPECT_FILE_EVENT = "lighthouse:inspect-file";

/** Tauri (cross-window) event the widget emits to the MAIN window for its
 *  citation handoff; the desktop transport re-broadcasts it in that window as
 *  INSPECT_FILE_EVENT. Mirrors the "ask-question" hand-off pattern. */
export const INSPECT_FILE_SHELL_EVENT = "inspect-file";

export interface InspectFileDetail {
  fileId: string;
  /** Display name, shown in the dialog title while the payload loads. */
  name: string;
  /** Prefilled test-search query that locates the cited chunk. Empty/absent ⇒
   *  the plain inspector opens with no auto-search. */
  query?: string;
}

/** Open the in-app preview (same-window path). No-op outside a browser. */
export function requestFileInspect(detail: InspectFileDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(INSPECT_FILE_EVENT, { detail }));
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** True when the retrieval tokenizer would score at least one token of `s`
 *  ([a-z0-9]{2,} — see vault.ts tokenize). */
const hasQueryTokens = (s: string): boolean => /[a-zA-Z0-9]{2}/.test(s);

/** Trailing clip mark the reference builder appends ("…"; tolerate "..."). */
const CLIP_MARK = /(…|\.{3})$/;

/**
 * Derive the inspector's test-search query from a citation's snippet.
 *
 * The snippet is the cited chunk's first 240 chars, so as a query it is a
 * near-perfect fingerprint of that chunk — but it needs cleaning first:
 * newlines collapse to spaces (tabular snippets are multi-line), and when the
 * chunk was clipped (trailing "…") the final, possibly mid-word fragment is
 * dropped so no half-token dilutes the match. A snippet with nothing the
 * scorer can tokenize (listing answers cite files with EMPTY snippets) falls
 * back to `fallback` — the turn's question; "" means "open with no search".
 */
export function citationQuery(snippet: string, fallback = ""): string {
  let s = collapse(snippet);
  if (CLIP_MARK.test(s)) {
    s = s.replace(CLIP_MARK, "").trimEnd().replace(/\S+$/, "").trimEnd();
  }
  if (!hasQueryTokens(s)) s = collapse(fallback);
  return hasQueryTokens(s) ? s : "";
}

/**
 * Which test-search hit is the cited chunk. Hits arrive sorted by score, and
 * the top hit is almost always it — but chunk windows OVERLAP (25 words /
 * 5 rows), so a neighboring window that carries the cited text at its far end
 * can near-tie the true chunk. The tell: the cited chunk holds the snippet at
 * its START, inside the per-hit 240-char text cap; the neighbor holds it
 * beyond the cap. So prefer the best-scored hit whose bounded text still
 * CONTAINS the derived query, falling back to the top hit. -1 ⇔ no hits.
 */
export function citedChunkIndex(hits: { text: string }[], query: string): number {
  if (hits.length === 0) return -1;
  const q = collapse(query);
  if (q) {
    const idx = hits.findIndex((h) => collapse(h.text).includes(q));
    if (idx >= 0) return idx;
  }
  return 0;
}
