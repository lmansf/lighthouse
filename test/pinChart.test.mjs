// Pin before/after mini-chart parsing (src/lib/pinChart.ts) — the pure half of
// the Phase 2 changed-pin mini-charts. These pin the fail-closed rules: only a
// clean list of "<label> <number>" segments charts; anything else degrades to
// the text tooltip, and a mismatched prior is dropped rather than mispaired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { parsePinNumber, parsePinSummary, pinChartData, MAX_PIN_POINTS } = await import(
  "../src/lib/pinChart.ts"
);

test("parsePinNumber reads money/percent/thousands and rejects prose", () => {
  assert.equal(parsePinNumber("125"), 125);
  assert.equal(parsePinNumber("1,250"), 1250);
  assert.equal(parsePinNumber("$1,250"), 1250);
  assert.equal(parsePinNumber("12.5%"), 12.5);
  assert.equal(parsePinNumber("-3.5"), -3.5);
  assert.equal(parsePinNumber(".5"), 0.5);
  assert.equal(parsePinNumber("n/a"), null);
  assert.equal(parsePinNumber("12x"), null);
  assert.equal(parsePinNumber(""), null);
});

test("parsePinSummary parses the engine's compact render", () => {
  const pts = parsePinSummary("NE 125 · NW 50 · SE 10");
  assert.ok(pts);
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], { label: "NE", value: 125 });
  assert.deepEqual(pts[2], { label: "SE", value: 10 });

  // Multi-word labels: the value is the last token, the rest is the label.
  const spaced = parsePinSummary("North East 1,200 · South 300");
  assert.ok(spaced);
  assert.deepEqual(spaced[0], { label: "North East", value: 1200 });
});

test("parsePinSummary fails closed on anything not a clean label+number list", () => {
  assert.equal(parsePinSummary(""), null); // empty
  assert.equal(parsePinSummary("just some prose"), null); // no numeric tail
  assert.equal(parsePinSummary("125"), null); // value with no label
  assert.equal(parsePinSummary("NE 125 · NW"), null); // one segment lacks a value
  // Too many categories to be a glanceable accent.
  const many = Array.from({ length: MAX_PIN_POINTS + 1 }, (_, i) => `c${i} ${i}`).join(" · ");
  assert.equal(parsePinSummary(many), null);
});

test("pinChartData pairs before/after only when labels align", () => {
  const aligned = pinChartData("NE 100 · NW 40", "NE 125 · NW 50");
  assert.ok(aligned);
  assert.deepEqual(aligned.labels, ["NE", "NW"]);
  assert.deepEqual(aligned.after, [125, 50]);
  assert.deepEqual(aligned.before, [100, 40]);

  // Prior with different labels (schema drift) → drop it, keep the after series.
  const drifted = pinChartData("EAST 100 · WEST 40", "NE 125 · NW 50");
  assert.ok(drifted);
  assert.equal(drifted.before, null);
  assert.deepEqual(drifted.after, [125, 50]);

  // No prior at all → single series.
  const fresh = pinChartData(undefined, "NE 125 · NW 50");
  assert.ok(fresh);
  assert.equal(fresh.before, null);

  // A non-chartable after summary → null (caller shows text).
  assert.equal(pinChartData("NE 100", "answer is 42 widgets total"), null);
});
