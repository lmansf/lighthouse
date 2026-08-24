/**
 * Survivor-killing bound pins for chartSpecFromTable.
 *
 * chartFromTable.test.mjs beside it covers the shapes — bar vs area vs line,
 * the top-N fold, the temporal decline. The harness still scored the module
 * 67.1% because the DECISIONS inside those shapes were unpinned: the
 * plausible-year gate, the minimum table size, the ≥2-finite-values rule, the
 * series cap's loop condition, and the tie-break in the top-N sort.
 *
 * Each of these is a cross-engine parity rule (analytics.rs draws the same
 * chart from the same batch), and each decides whether a chart appears at all
 * — a chip that shows when the engine's would not, or hides when it would, is
 * a visible disagreement between the two engines over one answer.
 *
 * Run: `node --test test/chartFromTableBounds.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { chartSpecFromTable, looksTemporal } = await import("../src/lib/chartFromTable.ts");
const { MAX_POINTS, MAX_SERIES } = await import("../src/lib/chartSpec.ts");

const table = (header, rows) => ({ header, rows });
const numRows = (n, label = (i) => `r${i}`) =>
  Array.from({ length: n }, (_, i) => [label(i), String(i + 1)]);

// --- looksTemporal: the plausible-year gate ---------------------------------

test("a bare 4-digit label is temporal ONLY inside 1900..2100", () => {
  // The gate exists so 4-digit identifiers (order numbers, SKUs) stay
  // categorical. Both ends must be inclusive and both must bite.
  assert.equal(looksTemporal("1900"), true, "1900 is in range");
  assert.equal(looksTemporal("2100"), true, "2100 is in range");
  assert.equal(looksTemporal("1899"), false, "one below is not");
  assert.equal(looksTemporal("2101"), false, "one above is not");
  assert.equal(looksTemporal("0042"), false, "an identifier stays categorical");
});

test("YYYY-MM is temporal, with or without a day/time tail", () => {
  assert.equal(looksTemporal("2024-07"), true);
  assert.equal(looksTemporal("2024-07-08"), true);
  assert.equal(looksTemporal("2024-07-08T10:00:00"), true);
  assert.equal(looksTemporal("2024-07 08"), true, "a space tail counts");
});

test("near-miss date shapes are NOT temporal", () => {
  assert.equal(looksTemporal("2024-7"), false, "a one-digit month does not match");
  assert.equal(looksTemporal("20240708"), false, "no separators");
  assert.equal(looksTemporal("2024/07"), false, "a slash is not a dash");
});

test("quarter labels are temporal, case-insensitively", () => {
  assert.equal(looksTemporal("Q3 2024"), true);
  assert.equal(looksTemporal("q3 2024"), true);
  assert.equal(looksTemporal("Q3-2024"), false, "the space is part of the grammar");
});

test("surrounding whitespace never changes the verdict", () => {
  assert.equal(looksTemporal("  2024-07  "), true);
  assert.equal(looksTemporal("  1899  "), false);
});

// --- the minimum table --------------------------------------------------------

test("a chart needs at least 2 columns AND at least 2 rows", () => {
  assert.equal(chartSpecFromTable(table(["only"], [["a"], ["b"]])), null, "1 column");
  assert.equal(chartSpecFromTable(table(["x", "y"], [["a", "1"]])), null, "1 row");
  assert.ok(chartSpecFromTable(table(["x", "y"], [["a", "1"], ["b", "2"]])), "2x2 charts");
});

test("an unlabeled row declines the whole chart rather than guessing a label", () => {
  assert.equal(chartSpecFromTable(table(["x", "y"], [["", "1"], ["b", "2"]])), null);
  assert.equal(chartSpecFromTable(table(["x", "y"], [["   ", "1"], ["b", "2"]])), null);
});

// --- the ≥2-finite rule -------------------------------------------------------

test("a column with only ONE numeric value is not a series", () => {
  // `finite >= 2`: a single point cannot be a trend, and the engine agrees.
  const one = chartSpecFromTable(table(["x", "y"], [["a", "1"], ["b", ""], ["c", ""]]));
  assert.equal(one, null, "one finite value is not enough");
  const two = chartSpecFromTable(table(["x", "y"], [["a", "1"], ["b", "2"], ["c", ""]]));
  assert.ok(two, "two is");
  assert.deepEqual(two.series[0].values, [1, 2, null], "the blank stays a gap, not a zero");
});

test("one non-numeric cell disqualifies its whole column", () => {
  const t = chartSpecFromTable(
    table(["x", "num", "mixed"], [["a", "1", "1"], ["b", "2", "n/a"], ["c", "3", "3"]]),
  );
  assert.equal(t.series.length, 1, "only the clean column became a series");
  assert.equal(t.series[0].name, "num");
});

test("a column with a blank HEADER is skipped without ending the scan", () => {
  // `if (!name) continue` — a mutant using `break` would lose every later
  // column instead of just the unnamed one.
  const t = chartSpecFromTable(
    table(["x", "", "after"], [["a", "1", "10"], ["b", "2", "20"]]),
  );
  assert.equal(t.series.length, 1);
  assert.equal(t.series[0].name, "after", "the column after the blank still counts");
});

// --- the series cap -----------------------------------------------------------

test("series stop at MAX_SERIES, keeping the FIRST ones", () => {
  const header = ["x", "s1", "s2", "s3", "s4"];
  const rows = [["a", "1", "1", "1", "1"], ["b", "2", "2", "2", "2"]];
  const t = chartSpecFromTable(table(header, rows));
  assert.equal(t.series.length, MAX_SERIES);
  assert.deepEqual(t.series.map((s) => s.name), ["s1", "s2", "s3"], "the cap keeps the first");
});

// --- the point cap and the temporal decline ----------------------------------

test("exactly MAX_POINTS rows chart as-is; one more folds into top-N + Other", () => {
  const at = chartSpecFromTable(table(["x", "y"], numRows(MAX_POINTS)));
  assert.equal(at.x.length, MAX_POINTS, "at the cap nothing is folded");
  assert.ok(!at.x.includes("Other"));

  const over = chartSpecFromTable(table(["x", "y"], numRows(MAX_POINTS + 1)));
  assert.equal(over.x.length, MAX_POINTS, "one past the cap folds to exactly the cap");
  assert.equal(over.x[over.x.length - 1], "Other", "with Other last");
});

test("a beyond-cap TEMPORAL table declines rather than ranking its time axis", () => {
  const rows = Array.from({ length: MAX_POINTS + 1 }, (_, i) => [
    `2024-${String((i % 12) + 1).padStart(2, "0")}-01`,
    String(i + 1),
  ]);
  assert.equal(chartSpecFromTable(table(["month", "amount"], rows)), null);
});

test("the temporal decline needs EVERY label temporal, not merely most", () => {
  // `x.every(looksTemporal)`: with `some`, one date among 24 categories would
  // suppress a perfectly good bar chart.
  const rows = Array.from({ length: MAX_POINTS + 1 }, (_, i) =>
    i === 0 ? ["2024-01-01", "1"] : [`cat-${i}`, String(i + 1)],
  );
  const t = chartSpecFromTable(table(["x", "y"], rows));
  assert.ok(t, "one temporal label among categories still charts");
  assert.equal(t.x[t.x.length - 1], "Other");
});

// --- the top-N ranking --------------------------------------------------------

test("the fold keeps the LARGEST values and sums the rest into Other", () => {
  const rows = Array.from({ length: MAX_POINTS + 2 }, (_, i) => [`c${i}`, String(i + 1)]);
  const t = chartSpecFromTable(table(["x", "y"], rows));
  const otherIdx = t.x.indexOf("Other");
  assert.equal(otherIdx, t.x.length - 1);
  assert.equal(t.x[0], `c${rows.length - 1}`, "the biggest value leads");
  const kept = t.series[0].values.slice(0, otherIdx);
  assert.ok(kept.every((v, i) => i === 0 || v <= kept[i - 1]), "kept values descend");
});

test("rows with a MISSING value sort last but are not dropped", () => {
  // The comparator's null arms (`va !== null` → -1, `vb !== null` → 1) decide
  // this; inverting either would rank gaps above real data.
  const rows = [
    ["gap", ""],
    ...Array.from({ length: MAX_POINTS + 1 }, (_, i) => [`c${i}`, String(i + 1)]),
  ];
  const t = chartSpecFromTable(table(["x", "y"], rows));
  assert.ok(t, "still charts");
  assert.equal(t.x[0], `c${MAX_POINTS}`, "the largest real value still leads");
});

// --- the label cap ------------------------------------------------------------

test("x labels are capped at 40 characters, counted by CODE POINT", () => {
  const long = "z".repeat(60);
  const t = chartSpecFromTable(table(["x", "y"], [[long, "1"], ["b", "2"]]));
  assert.equal(t.x[0].length, 40, "PARITY: the engine caps at 40");

  // [...label] is a code-point split, so an emoji label must not be cut in
  // half into a lone surrogate.
  const emoji = "🙂".repeat(60);
  const e = chartSpecFromTable(table(["x", "y"], [[emoji, "1"], ["b", "2"]]));
  assert.equal([...e.x[0]].length, 40, "40 code points, not 40 UTF-16 units");
  assert.equal(e.x[0].length, 80, "which is 80 UTF-16 units — proof it was NOT a .slice(0,40)");
  // The real hazard is a SPLIT character, not a trailing low surrogate (a
  // complete emoji ends on one). Every code point must still be whole.
  assert.ok([...e.x[0]].every((c) => c === "🙂"), "no half-emoji anywhere");
});

// --- the top-N comparator, with fixtures where nulls change the KEPT set ----

test("gaps sort last even against NEGATIVE values, and land in Other", async () => {
  // The comparator's three arms only show themselves when a null could
  // plausibly outrank a real value. With `&&` mutated to `||` the null arm
  // computes `vb - va`, which coerces null to 0 — so gaps would outrank every
  // negative row and displace them from the kept set. Negative values are
  // what make that visible.
  const positives = Array.from({ length: 13 }, (_, i) => [`p${i}`, String(13 - i)]);
  const negatives = Array.from({ length: 10 }, (_, i) => [`n${i}`, String(-1 - i)]);
  const gaps = [["gapA", ""], ["gapB", ""], ["gapC", ""]];
  // Interleave so the ROW order is not the value order — that way a
  // comparator that stops discriminating shows up as a wrong top label too.
  const rows = [];
  for (let i = 0; i < 13; i += 1) {
    rows.push(positives[i]);
    if (negatives[i]) rows.push(negatives[i]);
    if (gaps[i]) rows.push(gaps[i]);
  }
  assert.equal(rows.length, MAX_POINTS + 2);

  const t = chartSpecFromTable(table(["x", "y"], rows));
  assert.ok(t, "the table charts");
  assert.equal(t.x[0], "p0", "the largest value leads");
  assert.equal(t.x[t.x.length - 1], "Other");
  for (const g of ["gapA", "gapB", "gapC"]) {
    assert.ok(!t.x.includes(g), `${g} is a gap and must fold into Other, not outrank a negative`);
  }
});

// --- the numeric-column guards ----------------------------------------------

test("a column whose LAST cell is non-numeric is not a partial series", () => {
  // `numeric = false` before the break: with the flag left true, the two good
  // values above the bad cell would ship as a series and the chart would show
  // a trend the data does not support.
  const t = chartSpecFromTable(
    table(
      ["x", "clean", "mixed"],
      [["a", "1", "10"], ["b", "2", "20"], ["c", "3", "bad"]],
    ),
  );
  assert.equal(t.series.length, 1, "only the clean column");
  assert.equal(t.series[0].name, "clean");
});

test("a column of only blanks is not a series of nulls", () => {
  // `numeric && finite >= 2` → `||` would admit an all-empty column, drawing
  // an empty line across the chart.
  const t = chartSpecFromTable(
    table(["x", "real", "blank"], [["a", "1", ""], ["b", "2", ""], ["c", "3", ""]]),
  );
  assert.equal(t.series.length, 1);
  assert.equal(t.series[0].name, "real");
});

test("the LABEL column never becomes a series, even when its labels are numeric", () => {
  // The series scan starts at column 1. Starting at 0 would turn a year axis
  // into a data series plotted against itself.
  const rows = [["2021", "10"], ["2022", "20"], ["2023", "30"]];
  const t = chartSpecFromTable(table(["year", "amount"], rows));
  assert.equal(t.series.length, 1, "one series, not two");
  assert.equal(t.series[0].name, "amount");
  assert.deepEqual(t.x, ["2021", "2022", "2023"], "the years stayed the axis");
});
