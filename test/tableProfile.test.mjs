/**
 * Unit tests for the deterministic table profiler (src/server/tableProfile.ts).
 *
 * THE PARITY FIXTURE: `SALES_CSV` → `SALES_PROFILE` below is asserted
 * byte-for-byte here AND in lighthouse-core/src/table_profile.rs's unit test.
 * If you change the profile format, update both expected strings together.
 *
 * Run: `node --test test/tableProfile.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { tableProfile, parseDelimited, isProfileable, fmtNum, profileChart, profileAnswer } =
  await import("../src/server/tableProfile.ts");

test("fmtNum rounds negatives away from zero (parity with the Rust twin)", () => {
  // Was Math.round (half toward +∞), which diverged from Rust's f64::round.
  assert.equal(fmtNum(-0.125), "-0.13"); // Math.round would give "-0.12"
  assert.equal(fmtNum(-0.375), "-0.38");
  assert.equal(fmtNum(0.125), "0.13");
  assert.equal(fmtNum(-300), "-300");
});

const SALES_CSV = [
  "Date,Region,Sales",
  "2016-01-05,NE,100.50",
  "2016-03-10,NW,200",
  "2016-11-20,NE,49.50",
  "2017-02-14,SE,300",
  "2017-06-30,NE,150.25",
  "2017-09-01,NW,174.75",
].join("\n");

const SALES_PROFILE = [
  "[TABLE PROFILE — computed exactly by Lighthouse from sales.csv; these statistics are authoritative]",
  "rows: 6 (excluding header)",
  "columns: Date (date: years 2016–2017); Region (text: 3 distinct); Sales (number: sum 975, mean 162.5, min 49.5, max 300)",
  "sum of Sales by year(Date): 2016: 350 · 2017: 625",
  "sum of Sales by Region: NE: 300.25 · NW: 374.75 · SE: 300",
].join("\n");

test("PARITY FIXTURE: sales.csv profile matches the pinned string exactly", () => {
  assert.equal(tableProfile("sales.csv", SALES_CSV), SALES_PROFILE);
});

test("§44 §1b: profileAnswer promotes the profile with a shown computation (parity)", () => {
  // Byte-identical to table_profile.rs::profile_answer_promotes_the_profile_…:
  // a first-class lead, the "Computed exactly by Lighthouse" label, and the
  // exact profile carried verbatim inside the fence (so the shown numbers are
  // precisely the ones the §2 guard trusts).
  const ans = profileAnswer("sales.csv", SALES_CSV);
  assert.ok(
    ans.startsWith("Here are the exact figures Lighthouse computed from **sales.csv** — read "),
    "byte-pinned first-class lead",
  );
  assert.ok(ans.includes("*Computed exactly by Lighthouse:*"), "the shown-computation label");
  assert.ok(ans.includes(SALES_PROFILE), "the fence carries tableProfile() verbatim");
  // A non-table yields null — the caller falls through to the guarded path.
  assert.equal(profileAnswer("notes.csv", "just prose\nno table here"), null);
});

test("parseDelimited handles quoted fields, escaped quotes, CRLF", () => {
  const rows = parseDelimited('a,"b,1","say ""hi"""\r\nx,y,z\n', ",");
  assert.deepEqual(rows, [
    ["a", "b,1", 'say "hi"'],
    ["x", "y", "z"],
  ]);
});

test("currency symbols, thousands separators, and (negatives) parse", () => {
  const csv = ["Item,Amount", "a,$1,200.50".replace("$1,200", '"$1,200'), "b,(300)", "c,€99"].join(
    "\n",
  );
  // Row a's amount is quoted "$1,200.50" so the comma stays inside the field.
  const fixed = 'Item,Amount\na,"$1,200.50"\nb,(300)\nc,€99';
  const p = tableProfile("m.csv", fixed);
  assert.ok(p);
  assert.match(p, /sum 999\.5, mean 333\.17, min -300, max 1200\.5/);
});

test("non-tables return null (prose, single column, too few rows)", () => {
  assert.equal(tableProfile("notes.csv", "just some prose\nwithout structure"), null);
  assert.equal(tableProfile("one.csv", "header\n1\n2\n3"), null);
  assert.equal(tableProfile("tiny.csv", "a,b\n1,2"), null);
});

test("tsv delimiter honored via file name", () => {
  const tsv = "Name\tQty\nx\t1\ny\t2\nz\t3";
  const p = tableProfile("data.tsv", tsv);
  assert.ok(p);
  assert.match(p, /rows: 3/);
  assert.match(p, /Qty \(number: sum 6, mean 2, min 1, max 3\)/);
});

test("high-cardinality text columns get no group-by; years outside 2..6 skip rollup", () => {
  const rows = ["Id,Val"];
  for (let i = 0; i < 20; i += 1) rows.push(`id-${i},1`);
  const p = tableProfile("ids.csv", rows.join("\n"));
  assert.ok(p);
  assert.ok(!p.includes("by Id"), "20-distinct text column must not group");
});

test("profile is capped", () => {
  const rows = ["K,V"];
  for (let i = 0; i < 8; i += 1) rows.push(`key-with-a-rather-long-name-${i},${i}`);
  const p = tableProfile("k.csv", rows.join("\n"));
  assert.ok(p && p.length <= 1200);
});

test("isProfileable gates by extension", () => {
  assert.equal(isProfileable("a.csv"), true);
  assert.equal(isProfileable("b.TSV"), true);
  assert.equal(isProfileable("c.xlsx"), false);
  assert.equal(isProfileable("d.md"), false);
});

// --- §2 chartable aggregates (mirrors table_profile.rs) --------------------

test("profileChart prefers the widest group-by (the region bar)", () => {
  // The parity fixture profiles a 2-year rollup AND a 3-region group-by; the
  // wider comparison wins and charts as a bar of the profile's OWN sums.
  const spec = JSON.parse(profileChart("sales.csv", SALES_CSV));
  assert.equal(spec.kind, "bar");
  assert.deepEqual(spec.x, ["NE", "NW", "SE"]);
  assert.equal(spec.series[0].name, "Sales");
  assert.deepEqual(spec.series[0].values, [300.25, 374.75, 300]);
});

test("profileChart of a dated series is a trend (area)", () => {
  const csv = "Date,Sales\n2016-01-05,100\n2017-02-14,300\n2016-03-10,200\n2017-06-30,150\n";
  const spec = JSON.parse(profileChart("trend.csv", csv));
  assert.equal(spec.kind, "area");
  assert.deepEqual(spec.x, ["2016", "2017"]);
  assert.deepEqual(spec.series[0].values, [300, 450]);
});

test("prose and thin tables grow NO chart (constitution guard)", () => {
  // A number that lives only in prose is not chartable — the profiler finds no
  // aggregate, so nothing is drawn.
  assert.equal(profileChart("notes.csv", "just some prose\nwithout any structure"), null);
  assert.equal(profileChart("one.csv", "header\n1\n2\n3"), null);
  assert.equal(profileChart("tiny.csv", "a,b\n1,2"), null);
  const rows = ["Id,Val"];
  for (let i = 0; i < 20; i += 1) rows.push(`id-${i},${i}`);
  assert.equal(profileChart("ids.csv", rows.join("\n")), null);
});

// --- mutation hardening: boundary/guard pins (see scratchpad mutation run) ---

test("parseDelimited: escaped-quote consumes BOTH quotes; a trailing empty field flushes", () => {
  // The `i += 1` after an escaped quote must skip the second quote — otherwise
  // the closing state machine re-reads it and swallows the rest of the line.
  assert.deepEqual(parseDelimited('"a""b",c\n', ","), [['a"b', "c"]]);
  // EOF right after a delimiter: field is "" but the row has cells — both the
  // `||` and the `row.length > 0` matter for the final flush.
  assert.deepEqual(parseDelimited("a,b\nc,", ","), [
    ["a", "b"],
    ["c", ""],
  ]);
});

test("parseDelimited: MAX_ROWS stops AFTER row 50 001 (strictly-greater bail)", () => {
  // The guard is `rows.length > MAX_ROWS` — the early return fires only once
  // 50 001 rows have been pushed, so exactly 50 001 come back.
  const rows = parseDelimited("a,b\n".repeat(50_010), ",");
  assert.equal(rows.length, 50_001);
});

test("numOf guards: half-parenthesized values and scientific notation stay text", () => {
  // "(300" starts with "(" but doesn't end with ")" — the accountant-negative
  // path needs BOTH parens. "1e3" fails the strict digits regex even though
  // Number() would coerce it. Either leniency would flip these columns numeric.
  const p = tableProfile("m.csv", "Name,Paren,Sci\na,(300,1e3\nb,(150,2e3\nc,(50,3e5");
  assert.ok(p);
  assert.match(p, /Paren \(text: 3 distinct\)/);
  assert.match(p, /Sci \(text: 3 distinct\)/);
});

test("slashed dates yield the CAPTURED year, not the whole match", () => {
  // m/d/yyyy → the 4-digit capture group. Taking m[0] would Number() the whole
  // date to NaN — "years NaN–NaN" and no rollup.
  const p = tableProfile("d.csv", "Date,Sales\n1/5/2016,100\n2/14/2017,300\n3/10/2016,200");
  assert.ok(p);
  assert.ok(p.includes("Date (date: years 2016–2017)"));
  assert.ok(p.includes("sum of Sales by year(Date): 2016: 300 · 2017: 300"));
});

test("smallest possible table profiles: header + exactly 2 data rows (3 lines total)", () => {
  // Pins the `rows.length < 3` and `data.length < 2` gates AT their boundary.
  assert.equal(
    tableProfile("min.csv", "a,b\n1,2\n3,4"),
    [
      "[TABLE PROFILE — computed exactly by Lighthouse from min.csv; these statistics are authoritative]",
      "rows: 2 (excluding header)",
      "columns: a (number: sum 4, mean 2, min 1, max 3); b (number: sum 6, mean 3, min 2, max 4)",
    ].join("\n"),
  );
});

test("row filtering: empty-FIRST-cell rows are data; a blank line before the header is not", () => {
  // Only rows that are a SINGLE empty field are junk. A row like ",1" (empty
  // first cell, real second cell) must count.
  const p1 = tableProfile("e.csv", "A,B\n,1\n,2\nx,3");
  assert.ok(p1);
  assert.match(p1, /rows: 3 \(excluding header\)/);
  // A leading blank line parses as a lone-empty-field row; the filter must drop
  // it so the REAL header is row 0 (else header=[""] and the profile dies).
  const p2 = tableProfile("lead.csv", "\nA,B\n1,2\n3,4");
  assert.ok(p2);
  assert.match(p2, /rows: 2 \(excluding header\)/);
  assert.match(p2, /columns: A \(number: sum 4/);
});

test("type inference at the 80% boundary, single-value columns, and all-empty columns", () => {
  // Empty: 0 non-empty → text (the `nonEmpty.length > 0` guard, not date/number).
  // D1/N1: exactly ONE non-empty value still types the column (the `> 0` bound).
  // D45/N45: exactly 4 of 5 non-empty parse → 4 >= 5*0.8 is AT the >= boundary.
  const csv = [
    "K,Empty,D1,N1,D45,N45",
    "a,,2016-01-05,5,2016-01-05,1",
    "b,,,,2016-02-05,2",
    "c,,,,2017-03-05,3",
    "d,,,,2017-04-05,4",
    "e,,,,n/a,x",
  ].join("\n");
  assert.equal(
    tableProfile("mix.csv", csv),
    [
      "[TABLE PROFILE — computed exactly by Lighthouse from mix.csv; these statistics are authoritative]",
      "rows: 5 (excluding header)",
      "columns: K (text: 5 distinct); Empty (text: 0 distinct); D1 (date: years 2016–2016); N1 (number: sum 5, mean 5, min 5, max 5); D45 (date: years 2016–2017); N45 (number: sum 10, mean 2.5, min 1, max 4)",
      "sum of N45 by year(D45): 2016: 3 · 2017: 7",
      "sum of N45 by K: a: 1 · b: 2 · c: 3 · d: 4",
    ].join("\n"),
  );
});

test("per-year rollups: 1 year skips, 6 years roll up, 7 years skip; empty cells stay OUT", () => {
  // A single year is no comparison — no rollup, no chart.
  const y1 = "Date,Sales\n2016-01-05,100\n2016-03-10,200";
  const p1 = tableProfile("y1.csv", y1);
  assert.ok(p1 && !p1.includes("by year"), "1-year rollup must not render");
  assert.equal(profileChart("y1.csv", y1), null);
  // Exactly MAX_YEARS (6) distinct years is still within bounds.
  const y6 =
    "Date,Sales\n2016-01-05,1\n2017-01-05,2\n2018-01-05,3\n2019-01-05,4\n2020-01-05,5\n2021-01-05,6";
  const p6 = tableProfile("y6.csv", y6);
  assert.ok(p6);
  assert.ok(
    p6.includes("sum of Sales by year(Date): 2016: 1 · 2017: 2 · 2018: 3 · 2019: 4 · 2020: 5 · 2021: 6"),
  );
  const s6 = JSON.parse(profileChart("y6.csv", y6));
  assert.equal(s6.kind, "area");
  assert.deepEqual(s6.x, ["2016", "2017", "2018", "2019", "2020", "2021"]);
  // 7 distinct years exceeds MAX_YEARS — no rollup line, and (with no other
  // aggregate) no chart at all.
  const y7 = `${y6}\n2022-01-05,7`;
  const p7 = tableProfile("y7.csv", y7);
  assert.ok(p7 && !p7.includes("by year"), "7-year rollup must not render");
  assert.equal(profileChart("y7.csv", y7), null);
  // A dated row whose numeric cell is EMPTY contributes nothing: 2018 appears
  // in the data but must not appear in the rollup (not even as "2018: 0").
  const gap = "Date,Sales\n2016-01-05,100\n2016-03-10,200\n2017-02-14,300\n2018-05-01,";
  const pg = tableProfile("gap.csv", gap);
  assert.ok(pg);
  assert.ok(pg.includes("sum of Sales by year(Date): 2016: 300 · 2017: 300"));
  assert.ok(!pg.includes("2018:"), "the empty-Sales year must stay out of the rollup");
  const sg = JSON.parse(profileChart("gap.csv", gap));
  assert.deepEqual(sg.x, ["2016", "2017"]);
  assert.deepEqual(sg.series[0].values, [300, 300]);
});

test("group-by sums: 2-key groups render; keys whose numeric cell is empty stay OUT", () => {
  // Region C exists only on a row with an empty Sales cell — it must not
  // appear in the group-by (both `k !== ""` and `n !== null` are required),
  // and the surviving 2 keys are exactly at the `byKey.size < 2` boundary.
  const reg = "Region,Sales\nA,100\nB,200\nC,";
  const p = tableProfile("r.csv", reg);
  assert.ok(p);
  assert.ok(p.includes("sum of Sales by Region: A: 100 · B: 200"));
  assert.ok(!p.includes("C:"), "the empty-Sales key must stay out of the group-by");
  const s = JSON.parse(profileChart("r.csv", reg));
  assert.equal(s.kind, "bar");
  assert.deepEqual(s.x, ["A", "B"]);
  assert.deepEqual(s.series[0].values, [100, 200]);
  // Exactly 2 DISTINCT text values is the minimum categorical column.
  const two = "Reg,Val\nA,1\nB,2\nA,3";
  const p2 = tableProfile("t.csv", two);
  assert.ok(p2);
  assert.ok(p2.includes("sum of Val by Reg: A: 4 · B: 2"));
  const s2 = JSON.parse(profileChart("t.csv", two));
  assert.deepEqual(s2.x, ["A", "B"]);
  assert.deepEqual(s2.series[0].values, [4, 2]);
});

test("cardinality bound: 8 distinct keys group, 9 do not (MAX_GROUP_KEYS)", () => {
  const mk = (n) => ["K,V", ...Array.from({ length: n }, (_, i) => `k${i + 1},1`)].join("\n");
  const p8 = tableProfile("k8.csv", mk(8));
  assert.ok(p8);
  assert.ok(p8.includes("sum of V by K: k1: 1 · k2: 1 · k3: 1 · k4: 1 · k5: 1 · k6: 1 · k7: 1 · k8: 1"));
  const s8 = JSON.parse(profileChart("k8.csv", mk(8)));
  assert.deepEqual(s8.x, ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"]);
  const p9 = tableProfile("k9.csv", mk(9));
  assert.ok(p9 && !p9.includes("by K"), "9 distinct keys must not group");
  assert.equal(profileChart("k9.csv", mk(9)), null);
});

test("MAX_GROUP_COLS: only the FIRST TWO numeric columns roll up", () => {
  const csv = "K,N1,N2,N3\na,1,10,100\nb,2,20,200\na,3,30,300";
  const p = tableProfile("g.csv", csv);
  assert.ok(p);
  assert.ok(p.includes("sum of N1 by K: a: 4 · b: 2"));
  assert.ok(p.includes("sum of N2 by K: a: 40 · b: 20"));
  assert.ok(!p.includes("sum of N3 by K"), "the third numeric column must not group");
});

test("rollup/group-by entries sort by KEY ascending, not by insertion or sum", () => {
  // Keys arrive b, a, c with sums that would order differently by value —
  // the rendered line (and the chart labels) must be alphabetical.
  const keys = "Reg,Val\nb,9\na,5\nc,1";
  const pk = tableProfile("s.csv", keys);
  assert.ok(pk);
  assert.ok(pk.includes("sum of Val by Reg: a: 5 · b: 9 · c: 1"));
  const sk = JSON.parse(profileChart("s.csv", keys));
  assert.deepEqual(sk.x, ["a", "b", "c"]);
  assert.deepEqual(sk.series[0].values, [5, 9, 1]);
  // Years arrive 2018, 2016, 2017 with sums in yet another order — the line
  // and the trend axis must be chronological.
  const years = "Date,Val\n2018-03-01,1\n2016-03-01,9\n2017-03-01,5";
  const py = tableProfile("sy.csv", years);
  assert.ok(py);
  assert.ok(py.includes("sum of Val by year(Date): 2016: 9 · 2017: 5 · 2018: 1"));
  const sy = JSON.parse(profileChart("sy.csv", years));
  assert.deepEqual(sy.x, ["2016", "2017", "2018"]);
  assert.deepEqual(sy.series[0].values, [9, 5, 1]);
});

test("cap mechanics: exactly-1200 stays whole; longer truncates to EXACTLY 1200 ending …", () => {
  const rows = ["K,V"];
  for (let i = 0; i < 8; i += 1) rows.push(`key-with-a-rather-long-name-${i},${i}`);
  const csv = rows.join("\n");
  const base = tableProfile("k.csv", csv);
  assert.ok(base && base.length < 1200);
  // The file name rides in the header line, so padding it tunes the raw
  // profile length precisely: "k" + pad×"x" + ".csv" is `pad` chars longer
  // than "k.csv", giving a raw profile of exactly 1200 chars.
  const pad = 1200 - base.length;
  const exact = tableProfile(`k${"x".repeat(pad)}.csv`, csv);
  assert.ok(exact);
  assert.equal(exact.length, 1200);
  assert.ok(!exact.endsWith("…"), "an exactly-at-cap profile must NOT be truncated");
  // 50 chars over the cap: sliced to 1199 + "…" = exactly 1200, head intact.
  const over = tableProfile(`k${"x".repeat(pad + 50)}.csv`, csv);
  assert.ok(over);
  assert.equal(over.length, 1200);
  assert.ok(over.endsWith("…"));
  assert.ok(over.startsWith("[TABLE PROFILE — computed exactly by Lighthouse"));
});

test("bestAggregate tie-break: equal widths keep the FIRST aggregate (rollup beats group-by)", () => {
  // Both the 2-year rollup and the 2-region group-by have 2 labels; the tie
  // resolves to the profile's own order — the rollup — so the chart is a
  // TREND of years, not a bar of regions.
  const csv = "Date,Region,Sales\n2016-01-05,A,100\n2017-02-14,B,200\n2016-03-10,A,50";
  const spec = JSON.parse(profileChart("tie.csv", csv));
  assert.equal(spec.kind, "area");
  assert.deepEqual(spec.x, ["2016", "2017"]);
  assert.deepEqual(spec.series[0].values, [150, 200]);
});

test("group-by rollups switch ON at exactly two categories and sort keys the data never sorted", () => {
  // Two distinct regions, fed zeta-FIRST: the alphabetical output order can
  // only come from the comparator, and the rollup itself sits exactly at the
  // `distinct.size < 2` boundary.
  const two = "Region,Sales\nzeta,3\nalpha,1\nzeta,2\nalpha,4";
  const p = tableProfile("t.csv", two);
  assert.ok(p.includes("sum of Sales by Region: alpha: 5 · zeta: 5"), p);
  // The chartable aggregate mirrors the same comparator (profileAggregates).
  const spec = JSON.parse(profileChart("t.csv", two));
  assert.deepEqual(spec.x, ["alpha", "zeta"]);
  assert.deepEqual(spec.series[0].values, [5, 5]);
});

test("group-by rollups cap at MAX_GROUP_KEYS: present at 8 categories, absent at 9", () => {
  const mk = (n) =>
    "Region,Sales\n" +
    Array.from({ length: n }, (_, i) => `r${String(i).padStart(2, "0")},1`).join("\n");
  assert.ok(tableProfile("t.csv", mk(8)).includes("sum of Sales by Region:"));
  assert.ok(!tableProfile("t.csv", mk(9)).includes("sum of Sales by Region:"));
});
