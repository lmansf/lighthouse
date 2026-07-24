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
