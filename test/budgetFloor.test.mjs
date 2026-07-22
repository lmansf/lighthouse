/**
 * §32 §8: the budget floor, TS twin — for each call type a maximally-packed
 * apple-fm prompt (compact system prompt + every segment budget at its cap +
 * question + framing overhead) fits the call's input budget, so the §1
 * output reserve is structurally guaranteed. Mirrors the cargo floor test;
 * the forced-tier rig re-proves it against a real model where one exists.
 *
 * Run: `node --test test/budgetFloor.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { inputCharBudget, segmentBudgets } = await import("../src/server/budget.ts");
const { systemPromptFor } = await import("../src/server/llm.ts");

test("a maximally-packed apple prompt fits every call type's input budget", () => {
  for (const tier of ["apple-fm-4096", "apple-fm-8192"]) {
    const b = segmentBudgets(tier);
    const sys = systemPromptFor(tier).length;
    const question = 500;
    const overhead = 600;
    for (const call of ["narration", "nl-to-sql", "report-framing"]) {
      const total = sys + b.ctxTotalMax + b.historyMax + question + overhead;
      assert.ok(
        total <= inputCharBudget(tier, call),
        `${tier}/${call}: packed ${total} chars exceeds ${inputCharBudget(tier, call)}`,
      );
    }
  }
});
