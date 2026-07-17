// "Chart it" heuristic (charts by default, 0.12.1) — the pure table→spec
// module (src/lib/chartFromTable.ts) exercised for real: label/series
// extraction through parsePinNumber, temporal kind choice, the top-N +
// “Other” bucketing that mirrors lighthouse-core analytics.rs bucket_top_n
// (subtitle pinned byte-for-byte against the Rust emitter's), and the
// engine-fence gate that keeps the chip off answers the engine already
// charted. Every returned spec has passed the REAL parseChartSpec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { chartSpecFromTable, hasEngineChartFence, looksTemporal } = await import(
  "../src/lib/chartFromTable.ts"
);
const { parseMarkdownTable } = await import("../src/features/boards/boardModel.ts");
const { parseChartSpec } = await import("../src/lib/chartSpec.ts");

const table = (header, rows) => ({ header, rows });

test("a categorical table charts as a bar, numbers read like a person reads them", () => {
  const spec = chartSpecFromTable(
    table(
      ["region", "total"],
      [
        ["NE", "$1,200"],
        ["NW", "300"],
        ["SE", "42.5%"],
      ],
    ),
  );
  assert.ok(spec);
  assert.equal(spec.kind, "bar");
  assert.deepEqual(spec.x, ["NE", "NW", "SE"]);
  assert.equal(spec.series[0].name, "total");
  assert.deepEqual(spec.series[0].values, [1200, 300, 42.5]);
  assert.equal(spec.subtitle, undefined, "no bucketing → no subtitle");
  // The returned object IS renderer-valid (already round-tripped, but pin it).
  assert.ok(parseChartSpec(JSON.stringify(spec)));
});

test("temporal labels choose area (1 series) / line (2-3 series)", () => {
  const area = chartSpecFromTable(
    table(
      ["month", "v"],
      [
        ["2024-01", "1"],
        ["2024-02", "2"],
      ],
    ),
  );
  assert.equal(area?.kind, "area");
  const line = chartSpecFromTable(
    table(
      ["month", "a", "b"],
      [
        ["2024-01", "1", "3"],
        ["2024-02", "2", "4"],
      ],
    ),
  );
  assert.equal(line?.kind, "line");
  assert.equal(line?.series.length, 2);
});

test("non-chartable tables hide the chip (null)", () => {
  // One data row explains nothing.
  assert.equal(chartSpecFromTable(table(["a", "b"], [["x", "1"]])), null);
  // No numeric column at all.
  assert.equal(
    chartSpecFromTable(
      table(
        ["a", "b"],
        [
          ["x", "hello"],
          ["y", "world"],
        ],
      ),
    ),
    null,
  );
  // An unlabeled point — the table tells it better.
  assert.equal(
    chartSpecFromTable(
      table(
        ["a", "b"],
        [
          ["", "1"],
          ["y", "2"],
        ],
      ),
    ),
    null,
  );
  // A single column can't pair labels with values.
  assert.equal(chartSpecFromTable(table(["a"], [["1"], ["2"]])), null);
});

test("mixed columns: text columns are skipped, series cap at 3, blanks are gaps", () => {
  const spec = chartSpecFromTable(
    table(
      ["region", "note", "q1", "q2", "q3", "q4"],
      [
        ["NE", "up", "1", "2", "3", "4"],
        ["NW", "down", "5", "", "7", "8"],
        ["SE", "flat", "9", "10", "11", "12"],
      ],
    ),
  );
  assert.ok(spec);
  // "note" never became a series; the numeric ones did, capped at 3 (q4 out).
  assert.deepEqual(
    spec.series.map((s) => s.name),
    ["q1", "q2", "q3"],
  );
  assert.deepEqual(spec.series[1].values, [2, null, 10], "empty cell = missing point");
  // A column with <2 finite values can't clear the floor — and when it is
  // the ONLY candidate, there is no chart at all.
  const sparse = chartSpecFromTable(
    table(
      ["region", "v"],
      [
        ["NE", "1"],
        ["NW", ""],
      ],
    ),
  );
  assert.equal(sparse, null, "one finite point is not a chart");
});

test("beyond-cap categorical tables fold into top-23 + “Other” (engine parity)", () => {
  const rows = [];
  for (let i = 1; i <= 40; i += 1) {
    rows.push([`cat${String(i).padStart(2, "0")}`, String(i * 10)]);
  }
  const spec = chartSpecFromTable(table(["cat", "total"], rows));
  assert.ok(spec);
  assert.equal(spec.kind, "bar");
  assert.equal(spec.x.length, 24);
  assert.equal(spec.x[0], "cat40", "ranked descending by the first series");
  assert.equal(spec.x[23], "Other");
  assert.equal(spec.series[0].values[0], 400);
  // “Other” = the exact sum of the 17 smallest rows: 10 + 20 + … + 170.
  assert.equal(spec.series[0].values[23], 1530);
  // The disclosure string, byte-identical to the Rust emitter's
  // (analytics.rs bucket_top_n — KEEP IN SYNC, pinned on both sides).
  assert.equal(spec.subtitle, "Top 23 of 40 by total — 17 smaller rows grouped as “Other”");
});

test("beyond-cap TEMPORAL tables decline — the chip stays hidden (engine rule)", () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) {
    const y = 2020 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, "0");
    rows.push([`${y}-${m}`, String(i)]);
  }
  assert.equal(chartSpecFromTable(table(["month", "v"], rows)), null);
});

test("looksTemporal mirrors the engine's looks_temporal", () => {
  for (const l of ["2024", "2024-07", "2024-07-08", "2024-07-08 12:00", "Q3 2024", "q1 2025"]) {
    assert.ok(looksTemporal(l), l);
  }
  // 4-digit identifiers outside the plausible-year range stay categorical.
  for (const l of ["NE", "widget-9000", "July", "20245", "2024-7", "1001", "4520"]) {
    assert.ok(!looksTemporal(l), l);
  }
});

test("hasEngineChartFence: chart fences gate the chip, request fences don't", () => {
  assert.ok(hasEngineChartFence('Answer.\n```lighthouse-chart\n{"kind":"bar"}\n```\n'));
  assert.ok(!hasEngineChartFence('Answer.\n```lighthouse-chart-request\n{"kind":"none"}\n```\n'));
  assert.ok(!hasEngineChartFence("plain prose, one | table | maybe |"));
});

test("end to end from answer markdown via the boards table parser", () => {
  const md =
    "NE leads [1].\n\n| region | total |\n| --- | ---: |\n| NE | 125 |\n| NW | 50 |\n\n*Query used:*\n```sql\nSELECT 1\n```\n";
  const parsed = parseMarkdownTable(md);
  assert.ok(parsed);
  const spec = chartSpecFromTable(parsed);
  assert.ok(spec);
  assert.equal(spec.kind, "bar");
  assert.deepEqual(spec.x, ["NE", "NW"]);
  assert.deepEqual(spec.series[0].values, [125, 50]);
});
