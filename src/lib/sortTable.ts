/**
 * Sortable result tables (src/features/chat/ChatPanel.tsx).
 *
 * A data analyst's answer often lands as a Markdown result table; clicking a
 * column header sorts by it. The pure comparison + row-reordering lives here so
 * it's unit-testable in node (test/sortTable.test.mjs) without a DOM, exactly
 * like the chart math in chartSpec.ts. The chat renderer owns only the React
 * sort state and the header affordance; this module owns "what order the rows
 * go in". Kept dependency-free — and deliberately separate from chartSpec.ts,
 * which is being edited in parallel for another feature.
 */

export type SortDir = "asc" | "desc";

/**
 * Cells that carry no comparable value — an empty cell, a dash placeholder
 * (`-`, `–`, `—`), or a literal "null". These always sink to the bottom,
 * regardless of sort direction, so a sort surfaces real values first.
 */
function isBlankCell(raw: string): boolean {
  const s = raw.trim();
  if (s === "") return true;
  if (/^[-–—]+$/.test(s)) return true; // -, en dash, em dash placeholders
  return s.toLowerCase() === "null";
}

/**
 * Parse a cell as a number, tolerating the punctuation analysts' tables carry:
 * a currency symbol, thousands separators (commas or spaces — including the
 * non-breaking / thin spaces some locales use, which \s matches), and a
 * trailing percent sign. Returns null when what's left isn't a finite number,
 * so callers fall back to text comparison. Percent values keep their face value
 * (3.5% -> 3.5), which orders them correctly both among themselves and against
 * plain numbers.
 */
export function parseNumericCell(raw: string): number | null {
  let s = raw.trim();
  if (s === "") return null;
  if (s.endsWith("%")) s = s.slice(0, -1);
  s = s
    .replace(/[$€£¥₩₹¢₽¤]/g, "") // currency symbols
    .replace(/[,\s]/g, ""); // thousands separators / spaces (\s covers nbsp, thin space)
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ascending comparison of two cells. Numeric when BOTH parse as finite numbers
 * (so "$1,200", "1200" and "3.5%" sort by value, not by their text); otherwise
 * a case-insensitive, numeric-aware locale compare ("item2" before "item10").
 * Blank / dash / "null" cells compare greater than any real value, so they sort
 * last — matching how sortRows pins them in either direction.
 */
export function compareCells(a: string, b: string): number {
  const aBlank = isBlankCell(a);
  const bBlank = isBlankCell(b);
  if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;
  const na = parseNumericCell(a);
  const nb = parseNumericCell(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Return a NEW table with the DATA rows reordered by `colIndex` in `dir`. The
 * header row (rows[0]) stays pinned at the top; blank / dash / "null" cells sink
 * to the bottom in BOTH directions (so a sort always surfaces real values). The
 * sort is stable — rows that compare equal keep their original relative order —
 * and the input is never mutated (a fresh outer array of fresh row copies is
 * returned). A header-only or empty table is returned as a safe copy unchanged.
 */
export function sortRows(rows: string[][], colIndex: number, dir: SortDir): string[][] {
  if (rows.length <= 1) return rows.map((r) => r.slice());
  const header = rows[0];
  const sign = dir === "desc" ? -1 : 1;
  const decorated = rows.slice(1).map((row, i) => ({ row, i }));
  decorated.sort((a, b) => {
    const av = a.row[colIndex] ?? "";
    const bv = b.row[colIndex] ?? "";
    const aBlank = isBlankCell(av);
    const bBlank = isBlankCell(bv);
    // Blanks last in either direction — decided BEFORE the asc/desc flip, so a
    // descending sort can't drag them to the top.
    if (aBlank || bBlank) {
      if (aBlank && bBlank) return a.i - b.i;
      return aBlank ? 1 : -1;
    }
    const c = compareCells(av, bv);
    return c !== 0 ? sign * c : a.i - b.i; // stable tiebreak on original index
  });
  return [header.slice(), ...decorated.map((d) => d.row.slice())];
}
