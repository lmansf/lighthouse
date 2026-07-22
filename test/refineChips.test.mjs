// §22.3: deterministic refinement-chip eligibility — a chip that cannot
// succeed must not render, and an unknown shape must not hide chips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { refineEligibility } = await import("../src/lib/refineChips.ts");

const table = (labels, extra = []) => ({
  header: ["label", "value"],
  rows: labels.map((l, i) => [l, String(100 - i), ...extra]),
});

test("no parseable table → everything stays available (unknown, not known-bad)", () => {
  assert.deepEqual(refineEligibility(null), { topN: true, monthly: true, asPercent: true });
});

test("Top 10 needs more than ten rows to rank", () => {
  const few = table(["a", "b", "c", "d"]);
  assert.equal(refineEligibility(few).topN, false);
  const many = table(Array.from({ length: 12 }, (_, i) => `cat-${i}`));
  assert.equal(refineEligibility(many).topN, true);
});

test("Monthly needs a temporal label axis", () => {
  const categorical = table(["North", "South", "East", "West"]);
  assert.equal(refineEligibility(categorical).monthly, false);
  const dated = table(["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.equal(refineEligibility(dated).monthly, true);
  // Daily axis re-buckets to monthly just fine.
  const daily = table(["2026-01-03", "2026-01-04", "2026-01-05"]);
  assert.equal(refineEligibility(daily).monthly, true);
  // 4-digit identifiers are categorical, not years (looksTemporal's 1900–2100 gate).
  const ids = table(["8321", "9911", "7005"]);
  assert.equal(refineEligibility(ids).monthly, false);
});

test("As % needs at least two rows to apportion", () => {
  assert.equal(refineEligibility(table(["only"])).asPercent, false);
  assert.equal(refineEligibility(table(["a", "b"])).asPercent, true);
});

// --- §22.3 wiring: the ChatPanel gates each canned chip through this module ---
// (structural pin — the JSX can't load in node; the chartIt.test.mjs style).
test("RefineChips renders only chips whose eligibility holds for the answer's own table", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const chat = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/features/chat/ChatPanel.tsx"),
    "utf8",
  );
  assert.match(
    chat,
    /const refine = useMemo\(\s*\(\) => refineEligibility\(answerTable\(\{ content, meta: \{ table: metaTable \} \}\)\),\s*\[content, metaTable\],\s*\);/,
    "eligibility = this lib over the §3b accessor's table (meta.table preferred, parse fallback — pure, no service)",
  );
  assert.match(
    chat,
    /REFINE_CHIPS\.filter\(\(c\) => c\.applies\(refine\)\)\.map\(/,
    "an ineligible chip does not render",
  );
  // Each canned chip maps to its own eligibility axis.
  assert.match(chat, /applies: \(e\) => e\.topN/);
  assert.match(chat, /applies: \(e\) => e\.monthly/);
  assert.match(chat, /applies: \(e\) => e\.asPercent/);
});
