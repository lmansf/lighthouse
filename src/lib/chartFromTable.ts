/**
 * "Chart it" heuristic (charts by default, 0.12.1): build a ChartSpec from a
 * GFM table already rendered in an answer — for answers the ENGINE didn't
 * chart (prose-model tables, twin answers, truncated results). Zero model
 * calls, zero network: everything here reads the table's own cells, exactly
 * as displayed, through the same forgiving number reader the boards/pins
 * features already trust (parsePinNumber).
 *
 * The rules deliberately mirror the engine heuristic
 * (lighthouse-core analytics.rs chart_spec_from_batches):
 *   - first column = labels; every row must carry one (an unlabeled point —
 *     the table tells it better), capped at 40 chars like the engine's x;
 *   - remaining columns that coerce numeric become series (cap MAX_SERIES),
 *     each needing ≥2 finite values;
 *   - temporal-looking labels → area (1 series) / line (2-3); else bar;
 *   - beyond MAX_POINTS rows: TEMPORAL tables decline (ranking a time axis
 *     by value would destroy it — the chip simply stays hidden), CATEGORICAL
 *     tables fold into top-N + “Other” with the same disclosing subtitle the
 *     engine computes.
 *
 * Everything is pure and DOM-free (unit-tested in test/chartFromTable.test.mjs),
 * and the built spec is round-tripped through the REAL parseChartSpec before
 * being offered — the chip can never render a spec the renderer would reject.
 */

import { parsePinNumber } from "./pinChart";
import {
  parseChartSpec,
  MAX_POINTS,
  MAX_SERIES,
  type ChartSeries,
  type ChartSpec,
} from "./chartSpec";

/** The shape boardModel.parseMarkdownTable returns (structural, so this lib
 *  module doesn't reach into the boards feature). */
export interface TableLike {
  header: string[];
  rows: string[][];
}

/** PARITY: the engine caps x labels at 40 chars (chart_spec_from_batches). */
const MAX_LABEL_CHARS = 40;

/**
 * Date-ish labels: 2024 (plausible-year range only), 2024-07,
 * 2024-07-08 (optional time tail), Q3 2024.
 * KEEP IN SYNC: lighthouse-core analytics.rs `looks_temporal` — same rules,
 * including the 1900..=2100 gate that keeps 4-digit identifiers categorical.
 */
export function looksTemporal(label: string): boolean {
  const l = label.trim();
  if (/^\d{4}$/.test(l)) {
    const year = Number(l);
    return year >= 1900 && year <= 2100;
  }
  // YYYY-MM, optionally followed by "-", " " or "T" and anything after.
  if (/^\d{4}-\d{2}([- T]|$)/.test(l)) return true;
  return /^q\d+ \d+$/.test(l.toLowerCase());
}

/**
 * True when the answer already carries an ENGINE chart fence
 * (```lighthouse-chart) — then the chip has nothing to add. The request fence
 * (```lighthouse-chart-request) never matches: it is scrubbed model prose,
 * not an engine chart.
 */
export function hasEngineChartFence(text: string): boolean {
  return /```lighthouse-chart[ \t]*(\r?\n|$)/.test(text);
}

/**
 * Fold a beyond-cap categorical table into the top MAX_POINTS-1 rows plus one
 * final “Other” row: ranked DESCENDING by the first series (missing values
 * last; stable, so ties keep table order), tail aggregated as per-series sums
 * (nulls skipped; an all-null tail stays null).
 * KEEP IN SYNC: lighthouse-core analytics.rs `bucket_top_n` — same fold, and
 * the subtitle below is byte-identical to the engine's (pinned by unit tests
 * on both sides).
 */
function bucketTopN(
  x: string[],
  series: ChartSeries[],
): { x: string[]; series: ChartSeries[]; subtitle: string } {
  const n = x.length;
  const keep = MAX_POINTS - 1;
  const first = series[0].values;
  const order = x.map((_, i) => i);
  order.sort((a, b) => {
    const va = first[a];
    const vb = first[b];
    if (va !== null && vb !== null) return vb - va;
    if (va !== null) return -1;
    if (vb !== null) return 1;
    return 0;
  });
  const kept = order.slice(0, keep);
  const tail = order.slice(keep);
  const newX = kept.map((i) => x[i]);
  newX.push("Other");
  const newSeries = series.map((s) => {
    const values = kept.map((i) => s.values[i]);
    let sum: number | null = null;
    for (const i of tail) {
      const v = s.values[i];
      if (v !== null) sum = (sum ?? 0) + v;
    }
    values.push(sum);
    return { name: s.name, values };
  });
  const subtitle = `Top ${keep} of ${n} by ${series[0].name} — ${n - keep} smaller rows grouped as “Other”`;
  return { x: newX, series: newSeries, subtitle };
}

/**
 * Build a renderer-valid ChartSpec from a parsed GFM table, or null when the
 * table isn't honestly chartable (the "Chart it" chip stays hidden). The
 * result has passed the REAL parseChartSpec, so callers can hand it straight
 * to AnalyticsChart.
 */
export function chartSpecFromTable(table: TableLike): ChartSpec | null {
  const { header, rows } = table;
  if (header.length < 2 || rows.length < 2) return null;

  const x: string[] = [];
  for (const row of rows) {
    const label = (row[0] ?? "").trim();
    if (!label) return null; // unlabeled point — the table tells it better
    x.push([...label].slice(0, MAX_LABEL_CHARS).join(""));
  }

  // Numeric columns become series: every non-empty cell must coerce via
  // parsePinNumber (empty cells are missing points), ≥2 finite values each.
  const series: ChartSeries[] = [];
  for (let c = 1; c < header.length && series.length < MAX_SERIES; c += 1) {
    const name = (header[c] ?? "").trim();
    if (!name) continue;
    const values: (number | null)[] = [];
    let finite = 0;
    let numeric = true;
    for (const row of rows) {
      const cell = (row[c] ?? "").trim();
      if (cell === "") {
        values.push(null);
        continue;
      }
      const v = parsePinNumber(cell);
      if (v === null) {
        numeric = false;
        break;
      }
      values.push(v);
      finite += 1;
    }
    if (numeric && finite >= 2) series.push({ name, values });
  }
  if (series.length === 0) return null;

  const temporal = x.every((l) => looksTemporal(l));
  let labels = x;
  let outSeries = series;
  let subtitle: string | undefined;
  if (labels.length > MAX_POINTS) {
    // Mirror the engine rule: beyond-cap TEMPORAL tables decline — ranking a
    // time axis by value would destroy it (chip hidden, no bucketing).
    if (temporal) return null;
    const bucketed = bucketTopN(labels, outSeries);
    labels = bucketed.x;
    outSeries = bucketed.series;
    subtitle = bucketed.subtitle;
  }
  const kind = temporal ? (outSeries.length === 1 ? "area" : "line") : "bar";
  const spec: Record<string, unknown> = { kind, x: labels, series: outSeries };
  if (subtitle !== undefined) spec.subtitle = subtitle;
  // Only offer what the renderer will accept: round-trip through the real
  // parser (this also re-enforces the ≥2-finite floor on a bucketed view).
  return parseChartSpec(JSON.stringify(spec));
}
