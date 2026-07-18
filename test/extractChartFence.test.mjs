// §22.6: the meta-answer chart-fence extractor — the twin of
// synth.rs::extract_chart_fence (byte-pinned behavior in both suites).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { extractChartFence } = await import("../src/server/synth.ts");

test("splits an engine fence out of meta markdown", () => {
  const md = 'You have 12 files.\n```lighthouse-chart\n{"kind":"bar"}\n```\nMore text.';
  assert.deepEqual(extractChartFence(md), [
    "You have 12 files.\nMore text.",
    '{"kind":"bar"}',
  ]);
});

test("leaves fenceless, unclosed, and stat-fence input alone", () => {
  assert.deepEqual(extractChartFence("plain answer"), ["plain answer", null]);
  const unclosed = 'text\n```lighthouse-chart\n{"kind":';
  assert.deepEqual(extractChartFence(unclosed), [unclosed, null]);
  const stat = "```lighthouse-stat\n{}\n```";
  assert.deepEqual(extractChartFence(stat), [stat, null]);
});
