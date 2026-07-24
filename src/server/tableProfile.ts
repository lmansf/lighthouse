/**
 * Deterministic table profiles for delimiter files (.csv / .tsv).
 *
 * The model must never do arithmetic: for numeric questions over tables the
 * engine computes exact statistics — row count, per-column types and ranges,
 * numeric sums/means, per-year rollups for date columns, and group-by sums for
 * low-cardinality text columns — and injects them as a context block labeled
 * as computed-by-Lighthouse. The Rust twin (lighthouse-core/src/table_profile.rs)
 * must produce byte-identical output for the same input; the shared fixture in
 * test/tableProfile.test.mjs and the core unit test pin that parity.
 *
 * §2 (visual-first answers): a profiled table is also a CHARTABLE surface. Its
 * already-computed group-by / per-year aggregates route back through the client
 * chart heuristic (chartFromTable — the same one the "Chart it" chip uses) as a
 * tiny table of the profile's OWN summed values; see `profileChart`. PARITY:
 * lighthouse-core table_profile.rs::profile_chart mirrors the decision (the Rust
 * side feeds a RecordBatch to chart_spec_from_batches; the JSON differs only in
 * float formatting). A relative import keeps this node-testable (the test hook
 * resolves `../lib/…`, not the `@/` alias).
 */

import { chartSpecFromTable } from "../lib/chartFromTable";

/** Bounds — keep profiles compact enough to ride along as one context block. */
const MAX_PROFILE_CHARS = 1200;
const MAX_GROUP_KEYS = 8; // a text column is "categorical" up to this many distinct values
const MAX_YEARS = 6;
const MAX_GROUP_COLS = 2; // group-by rollups for at most this many numeric columns
const MAX_ROWS = 50_000; // hard stop so a huge file can't stall an answer

/** Minimal CSV/TSV parser: quoted fields, escaped quotes, CR/LF rows. */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) return rows;
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse a number, tolerating currency symbols, thousands separators, and (n). */
function numOf(raw: string): number | null {
  let s = raw.trim();
  if (s === "") return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$€£¥]/g, "").replace(/,/g, "").replace(/%$/, "").trim();
  if (s === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Extract a 4-digit year from ISO (yyyy-mm-dd) or slashed (m/d/yyyy) dates. */
function yearOf(raw: string): number | null {
  const s = raw.trim();
  let m = /^(\d{4})-\d{1,2}-\d{1,2}/.exec(s);
  if (m) return Number(m[1]);
  m = /^\d{1,2}[/.]\d{1,2}[/.](\d{4})$/.exec(s);
  if (m) return Number(m[1]);
  return null;
}

/** Format with up to 2 decimals, trailing zeros trimmed — no locale, for parity. */
export function fmtNum(n: number): string {
  // Round half AWAY FROM ZERO to match the Rust twin's `f64::round`. JS
  // `Math.round` rounds half toward +∞, so it diverged on negative .xx5 sums
  // (e.g. -0.125 → "-0.12" here vs "-0.13" in Rust) — a byte-parity break in
  // the "authoritative" profile. Applying the sign after rounding the
  // magnitude makes both engines round symmetrically.
  const r = (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100;
  if (Number.isInteger(r)) return String(r);
  return String(r);
}

interface Col {
  name: string;
  kind: "number" | "date" | "text";
  values: string[];
}

/**
 * Parse a delimiter file into typed, column-major `Col`s, or null when the
 * content does not look like a table (same gates as the profile). Shared by
 * `tableProfile` (text) and `profileAggregates` (chartable) so the two can never
 * disagree about a column's kind or values. Mirrors table_profile.rs::profile_cols.
 */
function profileCols(name: string, text: string): Col[] | null {
  const delim = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const rows = parseDelimited(text, delim).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (rows.length < 3) return null; // header + at least two data rows
  const header = rows[0].map((h) => h.trim());
  if (header.length < 2 || header.some((h) => h === "")) return null;
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (data.length < 2) return null;

  // Column-major with type inference: a column is numeric/date when ≥80% of its
  // non-empty values parse as such (real data has stray blanks and totals rows).
  return header.map((h, i) => {
    const values = data.map((r) => (r[i] ?? "").trim());
    const nonEmpty = values.filter((v) => v !== "");
    const nums = nonEmpty.filter((v) => numOf(v) !== null).length;
    const dates = nonEmpty.filter((v) => yearOf(v) !== null).length;
    let kind: Col["kind"] = "text";
    if (nonEmpty.length > 0 && dates >= nonEmpty.length * 0.8) kind = "date";
    else if (nonEmpty.length > 0 && nums >= nonEmpty.length * 0.8) kind = "number";
    return { name: h, kind, values };
  });
}

/**
 * Build the profile text for a delimiter file, or null when the content does
 * not look like a table (no header, <2 rows, or a lone column of prose).
 */
export function tableProfile(name: string, text: string): string | null {
  const cols = profileCols(name, text);
  if (!cols) return null;
  // The data-row count == every column's value count (one cell per row).
  const dataLen = cols[0]?.values.length ?? 0;

  const numCols = cols.filter((c) => c.kind === "number");
  const lines: string[] = [];
  lines.push(
    `[TABLE PROFILE — computed exactly by Lighthouse from ${name}; these statistics are authoritative]`,
  );
  lines.push(`rows: ${dataLen} (excluding header)`);

  // Per-column summary line.
  const colDescs = cols.map((c) => {
    if (c.kind === "number") {
      const ns = c.values.map(numOf).filter((n): n is number => n !== null);
      const sum = ns.reduce((a, b) => a + b, 0);
      const mean = ns.length ? sum / ns.length : 0;
      const min = ns.length ? Math.min(...ns) : 0;
      const max = ns.length ? Math.max(...ns) : 0;
      return `${c.name} (number: sum ${fmtNum(sum)}, mean ${fmtNum(mean)}, min ${fmtNum(min)}, max ${fmtNum(max)})`;
    }
    if (c.kind === "date") {
      const ys = c.values.map(yearOf).filter((y): y is number => y !== null);
      const min = ys.length ? Math.min(...ys) : 0;
      const max = ys.length ? Math.max(...ys) : 0;
      return `${c.name} (date: years ${min}–${max})`;
    }
    const distinct = new Set(c.values.filter((v) => v !== ""));
    return `${c.name} (text: ${distinct.size} distinct)`;
  });
  lines.push(`columns: ${colDescs.join("; ")}`);

  // Per-year rollups: every date column × every numeric column (bounded).
  for (const dc of cols.filter((c) => c.kind === "date")) {
    for (const nc of numCols.slice(0, MAX_GROUP_COLS)) {
      const byYear = new Map<number, number>();
      for (let i = 0; i < dc.values.length; i += 1) {
        const y = yearOf(dc.values[i]);
        const n = numOf(nc.values[i] ?? "");
        if (y !== null && n !== null) byYear.set(y, (byYear.get(y) ?? 0) + n);
      }
      if (byYear.size < 2 || byYear.size > MAX_YEARS) continue;
      const parts = [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([y, s]) => `${y}: ${fmtNum(s)}`);
      lines.push(`sum of ${nc.name} by year(${dc.name}): ${parts.join(" · ")}`);
    }
  }

  // Group-by sums: low-cardinality text columns × numeric columns (bounded).
  for (const tc of cols.filter((c) => c.kind === "text")) {
    const distinct = new Set(tc.values.filter((v) => v !== ""));
    if (distinct.size < 2 || distinct.size > MAX_GROUP_KEYS) continue;
    for (const nc of numCols.slice(0, MAX_GROUP_COLS)) {
      const byKey = new Map<string, number>();
      for (let i = 0; i < tc.values.length; i += 1) {
        const k = tc.values[i];
        const n = numOf(nc.values[i] ?? "");
        if (k !== "" && n !== null) byKey.set(k, (byKey.get(k) ?? 0) + n);
      }
      if (byKey.size < 2) continue;
      const parts = [...byKey.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, s]) => `${k}: ${fmtNum(s)}`);
      lines.push(`sum of ${nc.name} by ${tc.name}: ${parts.join(" · ")}`);
    }
  }

  let out = lines.join("\n");
  if (out.length > MAX_PROFILE_CHARS) out = `${out.slice(0, MAX_PROFILE_CHARS - 1)}…`;
  return out;
}

/**
 * §44 §1b: the table profile promoted from advisory CONTEXT to a first-class
 * ANSWER. When on-device NL→SQL produces no executed query, a numeric or
 * statistical ask over a CSV/TSV is answered from THESE exact figures — every
 * one computed by Lighthouse from the file, never written by the model —
 * introduced by a byte-pinned lead and shown inside a "Computed exactly by
 * Lighthouse" fence that reads like the SQL "Query used" disclosure (§3). The
 * verified digits the §2 guard trusts are exactly the ones displayed, because
 * the fence carries tableProfile()'s output verbatim. Returns null for a
 * non-profileable / non-tabular file (the tableProfile gate).
 * KEEP IN SYNC with table_profile.rs::profile_answer (byte-identical).
 */
export function profileAnswer(name: string, text: string): string | null {
  const profile = tableProfile(name, text);
  if (profile === null) return null;
  return (
    `Here are the exact figures Lighthouse computed from **${name}** — read ` +
    `straight from the file, not written by the model:\n\n` +
    `*Computed exactly by Lighthouse:*\n\`\`\`\n${profile}\n\`\`\`\n`
  );
}

/** Whether a file name is profileable (delimiter files only in Phase 1). */
export function isProfileable(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".csv") || n.endsWith(".tsv");
}

// --- Chartable aggregates (openspec: field-patch-0.12.5 §2) -----------------------

/** One already-computed aggregate from the profile: a categorical group-by or a
 *  per-year rollup, as aligned label/value pairs. Every value is a sum the
 *  engine computed over the file's cells — NEVER a number lifted from prose.
 *  Mirrors table_profile.rs::ProfileAggregate. */
interface ProfileAggregate {
  by: string;
  value: string;
  labels: string[];
  values: number[];
}

/** The aggregates the profile text lists, in the SAME order (per-year rollups
 *  first, then group-by sums), recomputed from the engine-typed `cols`. Kept in
 *  lock-step with `tableProfile`'s rendering loops. Mirrors profile_aggregates. */
function profileAggregates(cols: Col[]): ProfileAggregate[] {
  const numCols = cols.filter((c) => c.kind === "number");
  const out: ProfileAggregate[] = [];

  // Per-year rollups: every date column × the first numeric columns.
  for (const dc of cols.filter((c) => c.kind === "date")) {
    for (const nc of numCols.slice(0, MAX_GROUP_COLS)) {
      const byYear = new Map<number, number>();
      for (let i = 0; i < dc.values.length; i += 1) {
        const y = yearOf(dc.values[i]);
        const n = numOf(nc.values[i] ?? "");
        if (y !== null && n !== null) byYear.set(y, (byYear.get(y) ?? 0) + n);
      }
      if (byYear.size < 2 || byYear.size > MAX_YEARS) continue;
      const entries = [...byYear.entries()].sort((a, b) => a[0] - b[0]);
      out.push({
        by: dc.name,
        value: nc.name,
        labels: entries.map(([y]) => String(y)),
        values: entries.map(([, s]) => s),
      });
    }
  }

  // Group-by sums: low-cardinality text columns × the first numeric columns.
  for (const tc of cols.filter((c) => c.kind === "text")) {
    const distinct = new Set(tc.values.filter((v) => v !== ""));
    if (distinct.size < 2 || distinct.size > MAX_GROUP_KEYS) continue;
    for (const nc of numCols.slice(0, MAX_GROUP_COLS)) {
      const byKey = new Map<string, number>();
      for (let i = 0; i < tc.values.length; i += 1) {
        const k = tc.values[i];
        const n = numOf(nc.values[i] ?? "");
        if (k !== "" && n !== null) byKey.set(k, (byKey.get(k) ?? 0) + n);
      }
      if (byKey.size < 2) continue;
      const entries = [...byKey.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      out.push({
        by: tc.name,
        value: nc.name,
        labels: entries.map(([k]) => k),
        values: entries.map(([, s]) => s),
      });
    }
  }
  return out;
}

/** The richest aggregate to chart: the one with the most distinct labels, ties
 *  resolved by the profile's own order (rollups precede group-bys). Mirrors
 *  table_profile.rs::best_aggregate. */
function bestAggregate(aggs: ProfileAggregate[]): ProfileAggregate | null {
  let best: ProfileAggregate | null = null;
  for (const a of aggs) {
    if (best === null || a.labels.length > best.labels.length) best = a;
  }
  return best;
}

/**
 * An engine-built chart spec (the fence body JSON) for a profiled table, or null
 * when the content is not a chartable table.
 *
 * CONSTITUTION (§14): materialized ONLY from the profile's own aggregated values
 * — the best aggregate becomes a tiny table of the engine's OWN sums, fed to the
 * SAME `chartSpecFromTable` heuristic the "Chart it" chip uses (which round-trips
 * through the real parser). A number that appears only in narration is never
 * chartable: this reads the file's cells and sums them itself. PARITY:
 * table_profile.rs::profile_chart mirrors the decision; the Rust JSON prints a
 * trailing `.0` on integral floats, this does not — both parse identically.
 */
export function profileChart(name: string, text: string): string | null {
  const cols = profileCols(name, text);
  if (!cols) return null;
  const agg = bestAggregate(profileAggregates(cols));
  if (!agg) return null;
  const spec = chartSpecFromTable({
    header: [agg.by, agg.value],
    rows: agg.labels.map((l, i) => [l, String(agg.values[i])]),
  });
  return spec ? JSON.stringify(spec) : null;
}
