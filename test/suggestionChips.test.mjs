/**
 * §48 §1: the ONE combined suggestion cap — total ≤3 across asks + report +
 * recipe, priority asks > report > recipe, de-duplicated. Pins the invariant
 * on the pure merge fn so a regression that lets the row grow back to 7+ goes
 * red here, not in someone's face.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { mergeSuggestionChips, SUGGESTION_CAP } = await import(
  "../src/features/chat/suggestionChips.ts"
);

const ask = (n) => ({ label: `ask${n}`, question: `q${n}` });
const recipe = (id, table) => ({ id, table, name: `${id}`, summary: "s" });

test("the cap is 3", () => {
  assert.equal(SUGGESTION_CAP, 3);
});

test("worst case (4 asks + 2 reports + 5 recipes) is 3 chips, all the top-priority asks", () => {
  const chips = mergeSuggestionChips(
    [ask(1), ask(2), ask(3), ask(4)],
    ["sales", "orders"],
    [recipe("trend", "sales"), recipe("audit", "sales"), recipe("x", "y"), recipe("z", "w"), recipe("p", "q")],
  );
  assert.equal(chips.length, 3, "never more than 3 total");
  assert.deepEqual(
    chips.map((c) => c.kind),
    ["ask", "ask", "ask"],
    "asks win the whole budget",
  );
});

test("priority order fills asks > report > recipe when the budget spans types", () => {
  const chips = mergeSuggestionChips([ask(1)], ["sales"], [recipe("trend", "sales"), recipe("audit", "sales")]);
  assert.deepEqual(chips.map((c) => c.kind), ["ask", "report", "recipe"]);
  assert.equal(chips[1].table, "sales");
});

test("report is reachable even with no asks; recipes fill the tail", () => {
  const chips = mergeSuggestionChips([], ["sales"], [recipe("trend", "sales"), recipe("audit", "sales"), recipe("x", "y")]);
  assert.deepEqual(chips.map((c) => c.kind), ["report", "recipe", "recipe"]);
});

test("recipes alone fill up to the cap", () => {
  const chips = mergeSuggestionChips([], [], [recipe("a", "t"), recipe("b", "t"), recipe("c", "t"), recipe("d", "t")]);
  assert.equal(chips.length, 3);
  assert.ok(chips.every((c) => c.kind === "recipe"));
});

test("empty in, empty out (no row when nothing is valid)", () => {
  assert.deepEqual(mergeSuggestionChips([], [], []), []);
});

test("a duplicate ask label is de-duplicated, freeing the slot", () => {
  const chips = mergeSuggestionChips([ask(1), ask(1)], ["sales"], [recipe("a", "t")]);
  assert.deepEqual(chips.map((c) => c.kind), ["ask", "report", "recipe"]);
});
