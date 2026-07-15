// Chart-spec math + validation (src/lib/chartSpec.ts) — the pure half of the
// Phase C charts-in-chat feature. The Rust engine emits the spec; these tests
// pin the acceptance rules and the axis math the SVG renderer builds on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  parseChartSpec,
  niceTicks,
  scaleLinear,
  formatTick,
  formatGrouped,
  detectGranularity,
  formatXTick,
  tableToCsv,
} = await import("../src/lib/chartSpec.ts");

const good = JSON.stringify({
  kind: "bar",
  x: ["NE", "NW", "SE"],
  series: [{ name: "total", values: [150, 200, 300] }],
});

test("parseChartSpec accepts the engine shape and rejects malformed specs", () => {
  const spec = parseChartSpec(good);
  assert.ok(spec);
  assert.equal(spec.kind, "bar");
  assert.equal(spec.x.length, 3);
  assert.equal(spec.series[0].values[2], 300);

  // "area" is an accepted kind (single-series time-series); "pie" is not.
  const area = parseChartSpec(
    JSON.stringify({ kind: "area", x: ["2024-01", "2024-02"], series: [{ name: "v", values: [1, 2] }] }),
  );
  assert.ok(area);
  assert.equal(area.kind, "area");

  assert.equal(parseChartSpec("not json"), null);
  assert.equal(parseChartSpec(JSON.stringify({ kind: "pie", x: ["a", "b"], series: [] })), null);
  // series length must match x
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "bar", x: ["a", "b"], series: [{ name: "v", values: [1] }] }),
    ),
    null,
  );
  // one finite point is not a chart
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "line", x: ["a", "b"], series: [{ name: "v", values: [1, null] }] }),
    ),
    null,
  );
  // NaN/strings rejected
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "bar", x: ["a", "b"], series: [{ name: "v", values: [1, "2"] }] }),
    ),
    null,
  );
  // caps: 25 points is too many
  const big = {
    kind: "bar",
    x: Array.from({ length: 25 }, (_, i) => `x${i}`),
    series: [{ name: "v", values: Array.from({ length: 25 }, (_, i) => i) }],
  };
  assert.equal(parseChartSpec(JSON.stringify(big)), null);
});

test("niceTicks lands on round numbers and covers the domain", () => {
  const t = niceTicks(0, 300);
  assert.equal(t[0] <= 0, true);
  assert.equal(t[t.length - 1] >= 300, true);
  for (const v of t) assert.equal(Number.isFinite(v), true);
  // Round steps: consecutive gaps are equal and "nice".
  const step = t[1] - t[0];
  assert.ok([1, 2, 5].includes(step / 10 ** Math.floor(Math.log10(step))), `step ${step}`);

  // Degenerate domain still yields a usable axis.
  const flat = niceTicks(5, 5);
  assert.ok(flat.length >= 2);
  assert.ok(flat[0] <= 5 && flat[flat.length - 1] >= 5);

  // Inverted domain (min > max) is normalized, not blanked (was []).
  const inv = niceTicks(300, 0);
  assert.ok(inv.length >= 2, "inverted domain must still produce ticks");
  assert.equal(inv[0] <= 0, true);
  assert.equal(inv[inv.length - 1] >= 300, true);
});

test("scaleLinear maps domain to range (and survives zero-width domains)", () => {
  const s = scaleLinear(0, 100, 0, 200);
  assert.equal(s(0), 0);
  assert.equal(s(50), 100);
  assert.equal(s(100), 200);
  const flat = scaleLinear(5, 5, 0, 10);
  assert.equal(flat(5), 5);
});

test("formatTick compacts big values and trims trailing zeros", () => {
  assert.equal(formatTick(1_200_000), "1.2M");
  assert.equal(formatTick(4_500), "4.5k");
  assert.equal(formatTick(300), "300");
  assert.equal(formatTick(0.25), "0.25");
  assert.equal(formatTick(2_000_000_000), "2B");
});

test("tableToCsv quotes exactly what needs quoting", () => {
  const csv = tableToCsv([
    ["region", "amount", "note"],
    ["NE", "1,200", 'said "hi"'],
    ["SE", "300", "plain"],
  ]);
  assert.equal(csv, 'region,amount,note\nNE,"1,200","said ""hi"""\nSE,300,plain');
});

// --- G4: scatter + stacked parsing --------------------------------------------

test("parseChartSpec accepts a scatter with aligned xValues", () => {
  const spec = parseChartSpec(
    JSON.stringify({
      kind: "scatter",
      x: ["10", "22", "30"],
      xValues: [10, 22, 30],
      series: [{ name: "price", values: [1, 4, 9] }],
    }),
  );
  assert.ok(spec);
  assert.equal(spec.kind, "scatter");
  assert.deepEqual(spec.xValues, [10, 22, 30]);
});

test("parseChartSpec rejects malformed scatter", () => {
  const base = { kind: "scatter", x: ["1", "2"], series: [{ name: "y", values: [3, 4] }] };
  // missing xValues
  assert.equal(parseChartSpec(JSON.stringify(base)), null);
  // xValues length mismatch
  assert.equal(parseChartSpec(JSON.stringify({ ...base, xValues: [1] })), null);
  // scatter with >1 series
  assert.equal(
    parseChartSpec(
      JSON.stringify({
        kind: "scatter",
        x: ["1", "2"],
        xValues: [1, 2],
        series: [
          { name: "a", values: [1, 2] },
          { name: "b", values: [3, 4] },
        ],
      }),
    ),
    null,
  );
  // xValues on a non-scatter is rejected
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "bar", x: ["a", "b"], xValues: [1, 2], series: [{ name: "v", values: [1, 2] }] }),
    ),
    null,
  );
});

test("parseChartSpec accepts stacked bar, rejects stacked non-bar", () => {
  const stacked = parseChartSpec(
    JSON.stringify({
      kind: "bar",
      x: ["NE", "NW"],
      stacked: true,
      series: [
        { name: "a", values: [60, 40] },
        { name: "b", values: [40, 60] },
      ],
    }),
  );
  assert.ok(stacked);
  assert.equal(stacked.stacked, true);
  // stacked on a line is a shape violation
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "line", x: ["1", "2"], stacked: true, series: [{ name: "v", values: [1, 2] }] }),
    ),
    null,
  );
  // a bar WITHOUT stacked parses with no stacked field (grouped)
  const grouped = parseChartSpec(good);
  assert.ok(grouped);
  assert.equal(grouped.stacked, undefined);
});

// --- G4: axis-formatting helpers ----------------------------------------------

test("formatGrouped inserts thousands separators (parity with commafy)", () => {
  assert.equal(formatGrouped(1200), "1,200");
  assert.equal(formatGrouped(1234567), "1,234,567");
  assert.equal(formatGrouped(300), "300");
  assert.equal(formatGrouped(-1500), "-1,500");
  assert.equal(formatGrouped(12.5), "12.5");
});

test("detectGranularity reads the label convention", () => {
  assert.equal(detectGranularity(["2024-01", "2024-02"]), "month");
  assert.equal(detectGranularity(["2024-07-08", "2024-07-09"]), "day");
  assert.equal(detectGranularity(["2019", "2020", "2021"]), "year");
  assert.equal(detectGranularity(["Q1 2024", "Q2 2024"]), "quarter");
  assert.equal(detectGranularity(["10", "22.5", "30"]), "numeric");
  assert.equal(detectGranularity(["NE", "NW"]), "category");
});

test("formatXTick abbreviates by granularity", () => {
  assert.equal(formatXTick("2024-07", "month"), "Jul");
  assert.equal(formatXTick("2024-07-08", "day"), "07-08");
  assert.equal(formatXTick("4500", "numeric"), "4.5k");
  assert.equal(formatXTick("NE", "category"), "NE");
});
