// Chart-spec math + validation (src/lib/chartSpec.ts) — the pure half of the
// Phase C charts-in-chat feature. The Rust engine emits the spec; these tests
// pin the acceptance rules and the axis math the SVG renderer builds on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  parseChartSpec,
  parseChartDirective,
  validateDirective,
  stripChartRequestFences,
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

// --- Chart directive (chart-directive) ------------------------------------------
// PARITY: fixtures shared byte-for-byte with the Rust validator tests
// (analytics.rs::directive_* / parity_columns) so the grammar cannot drift.

test("parseChartDirective reads the first fence and ignores fabricated values", () => {
  const narration =
    'NW leads [1].\n\n```lighthouse-chart-request\n{"kind":"bar","label_column":"region","series_columns":["total"],"x":["fake"],"values":[999]}\n```\ntail\n```lighthouse-chart-request\n{"kind":"none"}\n```';
  const d = parseChartDirective(narration);
  assert.ok(d);
  assert.equal(d.kind, "bar");
  assert.equal(d.labelColumn, "region");
  assert.deepEqual(d.seriesColumns, ["total"]);
  assert.equal(d.title, undefined);
  assert.equal(d.sort, undefined);
  // Only the five fields exist on the parsed directive — fabricated data
  // keys are ignored wholesale.
  assert.ok(!("x" in d) && !("values" in d));

  const none = parseChartDirective('```lighthouse-chart-request\n{"kind":"none"}\n```');
  assert.ok(none);
  assert.equal(none.kind, "none");

  const full = parseChartDirective(
    '```lighthouse-chart-request\n{"kind":"line","label_column":"month","series_columns":["a","b"],"title":"Trend","sort":"asc"}\n```',
  );
  assert.ok(full);
  assert.equal(full.title, "Trend");
  assert.equal(full.sort, "asc");
});

test("parseChartDirective rejects malformed directives", () => {
  assert.equal(parseChartDirective("plain prose, no request"), null);
  // Unterminated fence.
  assert.equal(parseChartDirective('```lighthouse-chart-request\n{"kind":"bar"'), null);
  // Non-JSON body.
  assert.equal(parseChartDirective("```lighthouse-chart-request\nbar of region\n```"), null);
  // Unknown kind.
  assert.equal(
    parseChartDirective(
      '```lighthouse-chart-request\n{"kind":"pie","label_column":"a","series_columns":["b"]}\n```',
    ),
    null,
  );
  // Missing label_column.
  assert.equal(
    parseChartDirective('```lighthouse-chart-request\n{"kind":"bar","series_columns":["b"]}\n```'),
    null,
  );
  // series_columns not an array of strings.
  assert.equal(
    parseChartDirective(
      '```lighthouse-chart-request\n{"kind":"bar","label_column":"a","series_columns":[1]}\n```',
    ),
    null,
  );
  // sort outside the whitelist.
  assert.equal(
    parseChartDirective(
      '```lighthouse-chart-request\n{"kind":"bar","label_column":"a","series_columns":["b"],"sort":"sideways"}\n```',
    ),
    null,
  );
  // Non-string title.
  assert.equal(
    parseChartDirective(
      '```lighthouse-chart-request\n{"kind":"bar","label_column":"a","series_columns":["b"],"title":7}\n```',
    ),
    null,
  );
});

// Same column fixture as analytics.rs::parity_columns.
const parityColumns = [
  { name: "region", numeric: false },
  { name: "total", numeric: true },
  { name: "pct", numeric: true },
  { name: "note", numeric: false },
];

test("validateDirective mirrors the Rust rules and messages", () => {
  const d = (kind, labelColumn, seriesColumns) => ({ kind, labelColumn, seriesColumns });
  // Happy path + "none" trivially valid.
  assert.equal(validateDirective(d("bar", "region", ["total"]), parityColumns), null);
  assert.equal(validateDirective(d("line", "region", ["total", "pct"]), parityColumns), null);
  assert.equal(validateDirective(d("none", "", []), parityColumns), null);
  // Unknown label column (exact, case-sensitive).
  assert.equal(
    validateDirective(d("bar", "Region", ["total"]), parityColumns),
    'unknown label_column "Region"',
  );
  // Over-limit series.
  assert.equal(
    validateDirective(d("bar", "region", ["total", "pct", "total", "pct"]), parityColumns),
    "series_columns must name 1-3 columns",
  );
  // Empty series.
  assert.equal(
    validateDirective(d("bar", "region", []), parityColumns),
    "series_columns must name 1-3 columns",
  );
  // Unknown series column.
  assert.equal(
    validateDirective(d("bar", "region", ["revenue"]), parityColumns),
    'unknown series column "revenue"',
  );
  // Non-numeric series column.
  assert.equal(
    validateDirective(d("bar", "region", ["note"]), parityColumns),
    'series column "note" is not numeric',
  );
});

// --- add-quant-depth: the band chart kind (PARITY with analytics.rs) ----------

test("parseChartSpec accepts a band with lower/upper bounds; rejects bounds off a band", () => {
  // A forecast band: a line plus a sparse interval (null on historical rows).
  const band = parseChartSpec(
    JSON.stringify({
      kind: "band",
      x: ["2026-01", "2026-02", "2026-03", "2026-04"],
      series: [
        {
          name: "value",
          values: [100, 200, 300, 400],
          lower: [null, null, 280, 360],
          upper: [null, null, 320, 440],
        },
      ],
    }),
  );
  assert.ok(band);
  assert.equal(band.kind, "band");
  assert.deepEqual(band.series[0].lower, [null, null, 280, 360]);
  assert.deepEqual(band.series[0].upper, [null, null, 320, 440]);

  const base = { x: ["a", "b"], series: [{ name: "v", values: [1, 2] }] };
  // Band bounds must be present and length-aligned.
  assert.equal(parseChartSpec(JSON.stringify({ ...base, kind: "band" })), null); // no bounds
  assert.equal(
    parseChartSpec(
      JSON.stringify({ kind: "band", x: ["a", "b"], series: [{ name: "v", values: [1, 2], lower: [0], upper: [3, 4] }] }),
    ),
    null, // lower length ≠ x
  );
  // A band is single-series, like a scatter.
  assert.equal(
    parseChartSpec(
      JSON.stringify({
        kind: "band",
        x: ["a", "b"],
        series: [
          { name: "v", values: [1, 2], lower: [0, 1], upper: [2, 3] },
          { name: "w", values: [3, 4], lower: [2, 3], upper: [4, 5] },
        ],
      }),
    ),
    null,
  );
  // lower/upper are meaningless off a band → reject.
  assert.equal(
    parseChartSpec(JSON.stringify({ ...base, kind: "line", series: [{ name: "v", values: [1, 2], lower: [0, 1] }] })),
    null,
  );
});

test("band directive parses bound columns and validates like the Rust engine", () => {
  const d = parseChartDirective(
    '```lighthouse-chart-request\n{"kind":"band","label_column":"period","series_columns":["value"],"lower_column":"lo","upper_column":"hi"}\n```',
  );
  assert.ok(d);
  assert.equal(d.kind, "band");
  assert.equal(d.lowerColumn, "lo");
  assert.equal(d.upperColumn, "hi");

  const cols = [
    { name: "period", numeric: false },
    { name: "value", numeric: true },
    { name: "lo", numeric: true },
    { name: "hi", numeric: true },
    { name: "note", numeric: false },
  ];
  const band = (over) => ({
    kind: "band",
    labelColumn: "period",
    seriesColumns: ["value"],
    lowerColumn: "lo",
    upperColumn: "hi",
    ...over,
  });
  // Happy path.
  assert.equal(validateDirective(band(), cols), null);
  // Exactly one series.
  assert.equal(
    validateDirective(band({ seriesColumns: ["value", "lo"] }), cols),
    "a band names exactly one series column",
  );
  // Both bounds required.
  assert.equal(validateDirective(band({ lowerColumn: undefined }), cols), "band requires lower_column");
  assert.equal(validateDirective(band({ upperColumn: undefined }), cols), "band requires upper_column");
  // Bounds must exist and be numeric.
  assert.equal(validateDirective(band({ upperColumn: "nope" }), cols), 'unknown upper_column "nope"');
  assert.equal(validateDirective(band({ lowerColumn: "note" }), cols), 'lower_column "note" is not numeric');
});

test("parseChartSpec accepts an engine-capped title on directed specs", () => {
  const titled = parseChartSpec(
    JSON.stringify({
      kind: "bar",
      x: ["NE", "NW"],
      series: [{ name: "total", values: [150, 200] }],
      title: "Revenue by region",
    }),
  );
  assert.ok(titled);
  assert.equal(titled.title, "Revenue by region");
  // Absent title stays absent (heuristic specs are unchanged).
  const plain = parseChartSpec(good);
  assert.ok(plain);
  assert.equal(plain.title, undefined);
  // Shape violations: non-string, empty, or over the engine's 80-char cap.
  const withTitle = (title) =>
    JSON.stringify({ kind: "bar", x: ["a", "b"], series: [{ name: "v", values: [1, 2] }], title });
  assert.equal(parseChartSpec(withTitle(7)), null);
  assert.equal(parseChartSpec(withTitle("")), null);
  assert.equal(parseChartSpec(withTitle("x".repeat(81))), null);
  assert.ok(parseChartSpec(withTitle("x".repeat(80))));
});

test("parseChartSpec accepts the emitter's bucketing subtitle (charts by default)", () => {
  const withSubtitle = (subtitle) =>
    JSON.stringify({ kind: "bar", x: ["a", "b"], series: [{ name: "v", values: [1, 2] }], subtitle });
  // The engine-computed disclosure, byte-for-byte (analytics.rs bucket_top_n).
  const pinned = "Top 23 of 40 by total — 17 smaller rows grouped as “Other”";
  const spec = parseChartSpec(withSubtitle(pinned));
  assert.ok(spec);
  assert.equal(spec.subtitle, pinned);
  // Absent subtitle stays absent (≤24-row specs are byte-identical to before).
  const plain = parseChartSpec(good);
  assert.ok(plain);
  assert.equal(plain.subtitle, undefined);
  // Shape violations: non-string, empty/blank, over the 140-char cap.
  assert.equal(parseChartSpec(withSubtitle(7)), null);
  assert.equal(parseChartSpec(withSubtitle("")), null);
  assert.equal(parseChartSpec(withSubtitle("   ")), null);
  assert.equal(parseChartSpec(withSubtitle("x".repeat(141))), null);
  assert.ok(parseChartSpec(withSubtitle("x".repeat(140))));
  // Display copy is trimmed, mirroring the title discipline.
  assert.equal(parseChartSpec(withSubtitle("  padded  "))?.subtitle, "padded");
});

test("stripChartRequestFences removes directive fences from displayed prose", () => {
  const fenced =
    'Before.\n\n```lighthouse-chart-request\n{"kind":"none"}\n```\nAfter.';
  assert.equal(stripChartRequestFences(fenced), "Before.\n\n\nAfter.");
  // Unterminated fences (mid-stream) are dropped to the end of the text.
  assert.equal(
    stripChartRequestFences('Before. ```lighthouse-chart-request\n{"kind":'),
    "Before. ",
  );
  // Chart SPECS are untouched — they render as charts, not prose.
  const chart = "```lighthouse-chart\n{}\n```";
  assert.equal(stripChartRequestFences(chart), chart);
  // No fence, no change.
  assert.equal(stripChartRequestFences("plain prose"), "plain prose");
});
