/**
 * Chart specs for analytics answers (docs/analytics-beam.md, Phase C).
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

export type ChartKind = "bar" | "line" | "area" | "scatter";

export interface ChartSpec {
  kind: ChartKind;
  x: string[];
  series: ChartSeries[];
  /** bar only, present ONLY when true: draw stacked (proven part-of-whole) vs grouped. */
  stacked?: boolean;
  /** scatter only: numeric x position per point, aligned index-for-index with series[0].values. */
  xValues?: number[];
  /**
   * Optional heading, present ONLY on a directed chart (chart-directive): the
   * one model-chosen string the engine lets through — display copy, capped and
   * sanitized engine-side, never data.
   */
  title?: string;
  /**
   * Optional disclosure line, present ONLY when the emitter bucketed a
   * beyond-cap categorical result into top-N + “Other” (charts by default,
   * 0.12.1). Engine-computed (analytics.rs bucket_top_n) or client-computed
   * (chartFromTable.ts) — never model text.
   */
  subtitle?: string;
}

/** Bounds the renderer trusts; anything outside is rejected as "not a chart". */
export const MAX_POINTS = 24;
export const MAX_SERIES = 3;
/** PARITY: lighthouse-core analytics.rs CHART_TITLE_MAX_CHARS. */
export const MAX_TITLE_CHARS = 80;
/** Cap on the bucketing-disclosure subtitle — generous headroom over the
 *  longest string the emitters actually compute. */
export const MAX_SUBTITLE_CHARS = 140;

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
  if (o.kind !== "bar" && o.kind !== "line" && o.kind !== "area" && o.kind !== "scatter")
    return null;
  if (!Array.isArray(o.x) || o.x.length < 2 || o.x.length > MAX_POINTS) return null;
  if (!o.x.every((l) => typeof l === "string")) return null;
  if (!Array.isArray(o.series) || o.series.length < 1 || o.series.length > MAX_SERIES) return null;
  // Scatter is a single (x, y) relationship, never multi-series.
  if (o.kind === "scatter" && o.series.length !== 1) return null;
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
  const spec: ChartSpec = { kind: o.kind, x, series };
  // Stacked is a bar-only hint; reject it anywhere else to keep the union tight.
  if (o.stacked !== undefined) {
    if (typeof o.stacked !== "boolean") return null;
    if (o.stacked && o.kind !== "bar") return null;
    if (o.stacked) spec.stacked = true;
  }
  if (o.kind === "scatter") {
    // xValues MUST be finite, aligned to x, with ≥2 index positions carrying
    // both a finite x and a finite y — else the scatter is too sparse to read.
    if (!Array.isArray(o.xValues) || o.xValues.length !== x.length) return null;
    const xv: number[] = [];
    for (const v of o.xValues) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      xv.push(v);
    }
    const paired = xv.filter((v, i) => Number.isFinite(v) && series[0].values[i] !== null).length;
    if (paired < 2) return null;
    spec.xValues = xv;
  } else if (o.xValues !== undefined) {
    return null; // xValues is meaningless off a scatter
  }
  // Directed-chart title: engine-capped display copy. Anything outside the
  // emitter's own bounds (non-string, empty, over-length) is a shape violation.
  if (o.title !== undefined) {
    if (typeof o.title !== "string") return null;
    const t = o.title;
    if (t.length === 0 || [...t].length > MAX_TITLE_CHARS) return null;
    spec.title = t;
  }
  // Bucketing-disclosure subtitle: emitter-computed display copy, validated
  // like the title (string, trimmed, bounded) — anything else is a shape
  // violation and the whole spec degrades to visible code.
  if (o.subtitle !== undefined) {
    if (typeof o.subtitle !== "string") return null;
    const s = o.subtitle.trim();
    if (s.length === 0 || [...s].length > MAX_SUBTITLE_CHARS) return null;
    spec.subtitle = s;
  }
  return spec;
}

// --- Chart directive (chart-directive) -----------------------------------------------
//
// PARITY: the grammar and validation rules below mirror lighthouse-core
// analytics.rs (parse_chart_directive / validate_directive) byte-for-byte —
// same fence, same five fields, same rejection rules and messages — and are
// pinned against the same fixtures in test/chartSpec.test.mjs. The narrating
// model may emit ONE such fenced block; the ENGINE materializes the chart from
// its own result batches, so a directive can steer a chart but never supply a
// value. This module only parses/validates; nothing here reads data.

export type ChartDirectiveKind = "bar" | "line" | "area" | "none";

export interface ChartDirective {
  kind: ChartDirectiveKind;
  /** Must name a real result column (exact, case-sensitive). Empty for "none". */
  labelColumn: string;
  /** 1..=3 names; each must exist and be numeric in the result. */
  seriesColumns: string[];
  /** Optional display title — capped/sanitized by the engine, never data. */
  title?: string;
  sort?: "asc" | "desc";
}

/** PARITY: lighthouse-core analytics.rs CHART_DIRECTIVE_FENCE. */
export const CHART_DIRECTIVE_FENCE = "```lighthouse-chart-request";

/**
 * Parse the FIRST lighthouse-chart-request fence out of a narration (later
 * ones are ignored). Returns null for no fence, an unterminated fence, or any
 * grammar violation — callers fall back to the heuristic chart, exactly like
 * the engine. Only the five directive fields are read; extra keys (fabricated
 * x/values/anything) are ignored wholesale.
 */
export function parseChartDirective(text: string): ChartDirective | null {
  const start = text.indexOf(CHART_DIRECTIVE_FENCE);
  if (start < 0) return null;
  const after = text.slice(start + CHART_DIRECTIVE_FENCE.length);
  const end = after.indexOf("```");
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(after.slice(0, end).trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.kind === "none") return { kind: "none", labelColumn: "", seriesColumns: [] };
  if (o.kind !== "bar" && o.kind !== "line" && o.kind !== "area") return null;
  if (typeof o.label_column !== "string") return null;
  if (!Array.isArray(o.series_columns) || !o.series_columns.every((s) => typeof s === "string"))
    return null;
  const d: ChartDirective = {
    kind: o.kind,
    labelColumn: o.label_column,
    seriesColumns: o.series_columns as string[],
  };
  if (o.title !== undefined) {
    if (typeof o.title !== "string") return null;
    d.title = o.title;
  }
  if (o.sort !== undefined) {
    if (o.sort !== "asc" && o.sort !== "desc") return null;
    d.sort = o.sort;
  }
  return d;
}

/**
 * Validate a directive against the actual result columns. Returns null when
 * valid, else the SAME reason string the Rust validator produces (shared test
 * fixtures keep the two from drifting).
 */
export function validateDirective(
  d: ChartDirective,
  columns: { name: string; numeric: boolean }[],
): string | null {
  if (d.kind === "none") return null;
  if (!columns.some((c) => c.name === d.labelColumn))
    return `unknown label_column ${JSON.stringify(d.labelColumn)}`;
  if (d.seriesColumns.length < 1 || d.seriesColumns.length > MAX_SERIES)
    return `series_columns must name 1-${MAX_SERIES} columns`;
  for (const s of d.seriesColumns) {
    const col = columns.find((c) => c.name === s);
    if (!col) return `unknown series column ${JSON.stringify(s)}`;
    if (!col.numeric) return `series column ${JSON.stringify(s)} is not numeric`;
  }
  return null;
}

/**
 * Belt-and-braces UI strip: the engine already withholds chart-request fences
 * from streamed deltas (analytics.rs DirectiveScrubber); displayed prose
 * strips any residue too, unterminated tails included.
 */
export function stripChartRequestFences(text: string): string {
  return text.replace(/```lighthouse-chart-request[\s\S]*?(```|$)/g, "");
}

/** Thousands-grouped exact value ("1200" → "1,200", "0.25" → "0.25"), for
 *  tooltips and small-integer axes. PARITY: matches lighthouse-core `commafy`. */
export function formatGrouped(v: number): string {
  if (!Number.isFinite(v)) return "";
  const neg = v < 0;
  const abs = Math.abs(v);
  const [intPart, fracPart] = trimNum(abs).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${fracPart ? `.${fracPart}` : ""}`;
}

export type Granularity = "year" | "month" | "quarter" | "day" | "category" | "numeric";

/**
 * Soft parity with lighthouse-core `looks_temporal`: read a granularity from the
 * x labels so the renderer can thin/format date ticks. This is RENDERER-side
 * (not on the wire), so the label conventions must match the Rust emitter's, but
 * it is deliberately not a schema field. Not a hard byte-parity.
 */
export function detectGranularity(labels: string[]): Granularity {
  if (labels.length === 0) return "category";
  const every = (re: RegExp) => labels.every((l) => re.test(l.trim()));
  if (every(/^\d{4}-\d{2}-\d{2}/)) return "day";
  if (every(/^\d{4}-\d{2}$/)) return "month";
  if (every(/^[Qq][1-4]\s+\d{4}$/)) return "quarter";
  if (every(/^\d{4}$/)) return "year";
  if (every(/^-?\d+(\.\d+)?$/)) return "numeric";
  return "category";
}

/** Format one x-axis tick for its detected granularity (e.g. "2024-07" → "Jul"). */
export function formatXTick(label: string, granularity: Granularity): string {
  const l = label.trim();
  if (granularity === "month") {
    const m = /^\d{4}-(\d{2})$/.exec(l);
    if (m) {
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const idx = Number(m[1]) - 1;
      if (idx >= 0 && idx < 12) return months[idx];
    }
  }
  if (granularity === "day") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(l);
    if (m) return `${m[2]}-${m[3]}`;
  }
  if (granularity === "numeric") {
    const n = Number(l);
    if (Number.isFinite(n)) return formatTick(n);
  }
  return l;
}

/**
 * "Nice" axis ticks covering [min, max] — the classic nice-number algorithm,
 * so gridlines land on 0/5/10/…, not 0/4.7/9.4. Always includes 0 for bar
 * charts (callers pass min 0), returns ~`count` ticks, ascending.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  // Inverted domain (min > max) would make niceNum(max-min) NaN and return an
  // empty tick array — a blank axis. Normalize so a future caller can't blank it.
  if (max < min) [min, max] = [max, min];
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
