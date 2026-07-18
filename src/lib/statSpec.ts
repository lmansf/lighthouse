/**
 * Inline stat tiles for engine answers (openspec: field-patch-0.12.5 §2).
 *
 * A single engine-verified number — a meta/catalog count, a one-value result —
 * renders as a compact tile instead of a bare sentence. The Rust engine (and the
 * TS twin) emit a ```lighthouse-stat fenced JSON block carrying the number and
 * its caption, exactly as the ```lighthouse-chart fence carries a chart spec;
 * this module parses it. The number is the ENGINE's — never re-derived from the
 * surrounding prose — so a tile can only ever show a figure the engine computed.
 *
 * Pure and dependency-free so it unit-tests in node (test/statSpec.test.mjs)
 * without a DOM. PARITY: the fence body is built byte-identically by
 * meta.rs::stat_fence and meta.ts::statFence (fixed key order, no float
 * formatting — the value is an integer count).
 */

export interface StatSpec {
  /** The value exactly as the engine printed it ("3", "$1,200"). */
  raw: string;
  /** Numeric reading of the value (finite), for aria and any delta. */
  value: number;
  /** Short caption naming the value ("PDFs", "spreadsheets"), or null. */
  label: string | null;
}

/** PARITY: lighthouse-core analytics.rs CHART_DIRECTIVE_FENCE family. */
export const STAT_FENCE_LANG = "lighthouse-stat";

/**
 * Parse + validate a ```lighthouse-stat fence body. Returns null on ANY shape
 * violation — a non-object, a missing/blank `raw`, a non-finite `value`, or a
 * non-string `label` — so a malformed spec degrades to visible code (the code
 * renderer's fallback) instead of a broken tile.
 */
export function parseStatSpec(raw: string): StatSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.raw !== "string" || o.raw.length === 0) return null;
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) return null;
  let label: string | null = null;
  if (o.label !== undefined && o.label !== null) {
    if (typeof o.label !== "string") return null;
    label = o.label;
  }
  return { raw: o.raw, value: o.value, label };
}
