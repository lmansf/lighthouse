/**
 * §32 §1: the tiered token budgeter — TS-twin pins for the SAME cases the
 * cargo tests in native/crates/lighthouse-core/src/budget.rs assert, so a
 * table edit in one engine fails loud in the other:
 *   - tier resolution (force → cloud → advertised → on-device default → llama);
 *   - the llama arm IS the legacy 0.6.x constants byte-for-byte;
 *   - the apple arms carry the 0.13.10 v1 numbers this commit;
 *   - input budget = 90% of window minus the call's output reserve, ×4 chars;
 *   - the deterministic drop order and the refinement kernel (prior SQL
 *     drops dead last on refine asks).
 *
 * Run: `node --test test/budget.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const {
  parseTier,
  tierWindow,
  isAppleFm,
  outputReserve,
  CHARS_PER_TOKEN,
  inputCharBudget,
  segmentBudgets,
  docSegmentBudget,
  resolveTierWith,
  planKeep,
} = await import("../src/server/budget.ts");

test("resolution table is pinned (mirrors budget.rs)", () => {
  // Forced tier wins over everything (the device-free rig).
  assert.equal(resolveTierWith("apple-fm-4096", true, false, 200_000), "apple-fm-4096");
  // Unknown force strings fall through, never throw.
  assert.equal(resolveTierWith("nonsense", true, false, null), "remote-large");
  // Cloud → remote-large.
  assert.equal(resolveTierWith(null, true, false, null), "remote-large");
  // Advertised context sizes pick the apple tier (§7 /health).
  assert.equal(resolveTierWith(null, false, true, 8_192), "apple-fm-8192");
  assert.equal(resolveTierWith(null, false, true, 4_096), "apple-fm-4096");
  // On-device with no advertisement (today's bridge) → 4096.
  assert.equal(resolveTierWith(null, false, true, null), "apple-fm-4096");
  // A silent local server (desktop llama, Ollama, LM Studio) → llama.
  assert.equal(resolveTierWith(null, false, false, null), "llama-6144");
});

test("llama arm is the legacy constants byte-for-byte (desktop unchanged)", () => {
  assert.deepEqual(segmentBudgets("llama-6144"), {
    ctxBlockMax: 6_000,
    ctxTotalMax: 11_000,
    historyMax: 6_000,
  });
  // And today's fixed local answer room + the 0.11 sweep segment.
  assert.equal(outputReserve("llama-6144", "narration"), 1_024);
  assert.equal(docSegmentBudget("llama-6144"), 5_500);
});

test("apple arms carry the v1 on-device numbers this commit", () => {
  for (const t of ["apple-fm-4096", "apple-fm-8192"]) {
    assert.deepEqual(segmentBudgets(t), { ctxBlockMax: 3_500, ctxTotalMax: 5_000, historyMax: 2_000 });
    assert.equal(docSegmentBudget(t), 3_000);
    assert.ok(isAppleFm(t));
  }
  assert.ok(outputReserve("apple-fm-4096", "narration") >= 900, "§1: ≥900 on the 4k tier");
});

test("input budget is 90% of the window minus the call's reserve, in chars", () => {
  // apple-fm-4096 narration: (⌊4096×0.9⌋ − 900) × 4 = 11,144 chars.
  assert.equal(inputCharBudget("apple-fm-4096", "narration"), 11_144);
  // NL→SQL keeps a smaller reserve → more input room.
  assert.equal(inputCharBudget("apple-fm-4096", "nl-to-sql"), 13_544);
  assert.equal(inputCharBudget("remote-large", "narration"), Infinity);
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(tierWindow("llama-6144"), 6_144);
  assert.equal(parseTier("apple-fm-8192"), "apple-fm-8192");
  assert.equal(parseTier("gpt-oss"), null);
});

test("fresh drop order is deterministic: few-shots first, schema samples last", () => {
  const segs = [
    { segment: "few-shots", chars: 1_000 },
    { segment: "history-middle", chars: 1_000 },
    { segment: "semantic-unmatched", chars: 1_000 },
    { segment: "evidence-lowest", chars: 1_000 },
    { segment: "schema-samples", chars: 1_000 },
  ];
  // Budget forces exactly two drops: few-shots then history-middle go.
  assert.deepEqual(planKeep(500, segs, 3_600, false), [
    "semantic-unmatched",
    "evidence-lowest",
    "schema-samples",
  ]);
  // Everything fits → nothing drops.
  assert.equal(planKeep(0, segs, 10_000, false).length, 5);
});

test("the refinement kernel protects prior SQL to the last", () => {
  const segs = [
    { segment: "prior-sql", chars: 800 },
    { segment: "evidence-lowest", chars: 2_000 },
    { segment: "semantic-unmatched", chars: 1_000 },
    { segment: "schema-samples", chars: 700 },
  ];
  // Tight budget: evidence AND semantic AND schema all drop before the
  // prior SQL is even considered — the refinement keeps its query.
  assert.deepEqual(planKeep(400, segs, 1_300, true), ["prior-sql"]);
});
