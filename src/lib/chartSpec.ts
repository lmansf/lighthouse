/**
 * Chart specs for analytics answers (docs/analytics-genie.md, Phase C).
 *
 * The Rust engine renders a ```lighthouse-chart fenced block containing a small
 * JSON spec built from the VERIFIED query result (the model never touches it);
 * the chat renderer parses it here and draws a theme-aware SVG. Everything in
 * this module is pure and dependency-free so the math is unit-testable in
 * node (test/chartSpec.test.mjs) without a DOM.
 */

export interface ChartSeries {
  name: string;
  /** One value per x label; null = missing point (skipped in line, zero-height in bar). */
  values: (number | null)[];
}

export interface ChartSpec {
  kind: "bar" | "line";
  x: string[];
  series: ChartSeries[];
}

/** Bounds the renderer trusts; anything outside is rejected as "not a chart". */
export const MAX_POINTS = 24;
export const MAX_SERIES = 3;

/**
 * Parse + validate the fenced JSON. Returns null on ANY shape violation —
 * callers fall back to showing the fence as plain code, so a malformed spec
 * degrades visibly instead of drawing garbage.
 */
export function parseChartSpec(raw: string): ChartSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.kind !== "bar" && o.kind !== "line") return null;
  if (!Array.isArray(o.x) || o.x.length < 2 || o.x.length > MAX_POINTS) return null;
  if (!o.x.every((l) => typeof l === "string")) return null;
  if (!Array.isArray(o.series) || o.series.length < 1 || o.series.length > MAX_SERIES) return null;
  const x = o.x as string[];
  const series: ChartSeries[] = [];
  for (const s of o.series) {
    if (typeof s !== "object" || s === null) return null;
    const so = s as Record<string, unknown>;
    if (typeof so.name !== "string") return null;
    if (!Array.isArray(so.values) || so.values.length !== x.length) return null;
    const values: (number | null)[] = [];
    let finite = 0;
    for (const v of so.values) {
      if (v === null) {
        values.push(null);
      } else if (typeof v === "number" && Number.isFinite(v)) {
        values.push(v);
        finite += 1;
      } else {
        return null;
      }
    }
    if (finite < 2) return null; // a chart of one real point explains nothing
    series.push({ name: so.name, values });
  }
  return { kind: o.kind, x, series };
}

/**
 * "Nice" axis ticks covering [min, max] — the classic nice-number algorithm,
 * so gridlines land on 0/5/10/…, not 0/4.7/9.4. Always includes 0 for bar
 * charts (callers pass min 0), returns ~`count` ticks, ascending.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    // Degenerate domain: pad around the value so the line isn't on an edge.
    const pad = Math.abs(min) || 1;
    return niceTicks(min - pad / 2, max + pad / 2, count);
  }
  const span = niceNum(max - min, false);
  const step = niceNum(span / Math.max(1, count), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  // Float-drift guard: iterate by index, round to the step's precision.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let i = 0; lo + i * step <= hi + step / 2; i++) {
    out.push(Number((lo + i * step).toFixed(decimals)));
  }
  return out;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / 10 ** exp;
  let nice: number;
  if (round) {
    nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return nice * 10 ** exp;
}

/** Linear scale mapping domain → range (no clamping; domains are pre-niced). */
export function scaleLinear(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  const dd = d1 - d0;
  if (dd === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / dd) * (r1 - r0);
}

/** Compact value labels for ticks: 1200000 → "1.2M", 4500 → "4.5k", 0.25 → "0.25". */
export function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${trimNum(v / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimNum(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimNum(v / 1_000)}k`;
  return trimNum(v);
}

function trimNum(v: number): string {
  const s = Math.abs(v) < 10 ? v.toFixed(2) : Math.abs(v) < 100 ? v.toFixed(1) : v.toFixed(0);
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/**
 * Serialize a rendered table (array of rows, first row = header) to CSV with
 * RFC-4180-ish quoting — backs the "Copy as CSV" affordance on chat tables.
 */
export function tableToCsv(rows: string[][]): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}
