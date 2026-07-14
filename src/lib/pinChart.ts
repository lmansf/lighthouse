/**
 * Before/after mini-charts for changed-pin alerts (openspec: add-pinned-questions,
 * Phase 2 richer results). A pin's `lastSummary` — and the `before`/`after` on a
 * ChangedPin — is the engine's compact "NE 125 · NW 50 · SE 10" render, built
 * from the VERIFIED DataFusion result (never model text), so the numbers are
 * trustworthy. This module parses that summary back into a labeled series so the
 * alert can draw a tiny before→after comparison.
 *
 * Everything here is pure and DOM-free (unit-tested in test/pinChart.test.mjs).
 * It FAILS CLOSED: any summary that isn't a clean list of "<label> <number>"
 * segments returns null, and the alert falls back to the plain text tooltip —
 * a mini-chart is only ever drawn from cleanly parseable engine numbers.
 */

export interface PinPoint {
  label: string;
  value: number;
}

export interface PinChartData {
  labels: string[];
  /** The current (post-change) value per label. Always present. */
  after: number[];
  /** Aligned prior value per label, or null when there is no comparable prior. */
  before: number[] | null;
}

/** Small enough to stay a glanceable alert accent, not a dashboard. */
export const MAX_PIN_POINTS = 6;

/**
 * Parse a numeric cell the way a person reads it: strip a leading currency
 * mark, thousands separators, and a trailing percent. Returns null for
 * anything that isn't a plain number so mixed text never charts.
 */
export function parsePinNumber(raw: string): number | null {
  const cleaned = raw.replace(/^[$£€¥]/, "").replace(/,/g, "").replace(/%$/, "");
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an engine pin summary ("NE 125 · NW 50") into labeled points. Each
 * "·"-separated segment must end in a single numeric token (the value); the
 * rest is the label. Returns null on ANY deviation — an empty summary, a
 * segment with no number, or more points than we'll draw — so callers degrade
 * to text instead of charting a guess.
 */
export function parsePinSummary(summary: string): PinPoint[] | null {
  const segs = summary
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0 || segs.length > MAX_PIN_POINTS) return null;
  const points: PinPoint[] = [];
  for (const seg of segs) {
    const toks = seg.split(/\s+/);
    if (toks.length < 2) return null; // need a label AND a value
    const value = parsePinNumber(toks[toks.length - 1]);
    if (value === null) return null;
    const label = toks.slice(0, -1).join(" ");
    if (!label) return null;
    points.push({ label, value });
  }
  return points;
}

/**
 * Build the before/after series for a changed-pin alert. The `after` summary
 * must parse; `before` is folded in only when it parses AND its labels line up
 * with `after` one-for-one (a schema change between rechecks makes the columns
 * incomparable, so we drop the prior rather than pair mismatched bars).
 * Returns null when `after` isn't cleanly chartable.
 */
export function pinChartData(before: string | undefined, after: string): PinChartData | null {
  const a = parsePinSummary(after);
  if (!a) return null;
  const labels = a.map((p) => p.label);
  const afterVals = a.map((p) => p.value);
  let beforeVals: number[] | null = null;
  if (before) {
    const b = parsePinSummary(before);
    if (b && b.length === a.length && b.every((p, i) => p.label === labels[i])) {
      beforeVals = b.map((p) => p.value);
    }
  }
  return { labels, after: afterVals, before: beforeVals };
}
