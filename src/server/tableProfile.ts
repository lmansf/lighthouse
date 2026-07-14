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
 */

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
 * Build the profile text for a delimiter file, or null when the content does
 * not look like a table (no header, <2 rows, or a lone column of prose).
 */
export function tableProfile(name: string, text: string): string | null {
  const delim = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const rows = parseDelimited(text, delim).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (rows.length < 3) return null; // header + at least two data rows
  const header = rows[0].map((h) => h.trim());
  if (header.length < 2 || header.some((h) => h === "")) return null;
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (data.length < 2) return null;

  // Column-major with type inference: a column is numeric/date when ≥80% of its
  // non-empty values parse as such (real data has stray blanks and totals rows).
  const cols: Col[] = header.map((h, i) => {
    const values = data.map((r) => (r[i] ?? "").trim());
    const nonEmpty = values.filter((v) => v !== "");
    const nums = nonEmpty.filter((v) => numOf(v) !== null).length;
    const dates = nonEmpty.filter((v) => yearOf(v) !== null).length;
    let kind: Col["kind"] = "text";
    if (nonEmpty.length > 0 && dates >= nonEmpty.length * 0.8) kind = "date";
    else if (nonEmpty.length > 0 && nums >= nonEmpty.length * 0.8) kind = "number";
    return { name: h, kind, values };
  });

  const numCols = cols.filter((c) => c.kind === "number");
  const lines: string[] = [];
  lines.push(
    `[TABLE PROFILE — computed exactly by Lighthouse from ${name}; these statistics are authoritative]`,
  );
  lines.push(`rows: ${data.length} (excluding header)`);

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

/** Whether a file name is profileable (delimiter files only in Phase 1). */
export function isProfileable(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".csv") || n.endsWith(".tsv");
}
