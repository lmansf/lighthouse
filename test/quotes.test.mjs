/**
 * §32 §5: the quote digest — TS-twin pins for the SAME cases the cargo tests
 * in native/crates/lighthouse-core/src/quotes.rs assert (splitter torture,
 * digest budgets, citation-contract preservation, neighbor dedupe), so twin
 * drift fails loud in either engine.
 *
 * Run: `node --test test/quotes.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { splitSentences, digestContexts, questionTokens } = await import("../src/server/quotes.ts");

// --- The splitter torture suite ---------------------------------------------

test("splitter handles plain prose", () => {
  const s = splitSentences("Revenue rose in Q3. The west region led. Margins held steady.");
  assert.equal(s.length, 3);
  assert.equal(s[0], "Revenue rose in Q3.");
  assert.equal(s[2], "Margins held steady.");
});

test("splitter never splits abbreviations, initials, or decimals", () => {
  const s = splitSentences(
    "The U.S. market grew 3.14 percent under Dr. Lee. Deals closed, e.g. the Acme one.",
  );
  assert.equal(s.length, 2, JSON.stringify(s));
  assert.ok(s[0].includes("U.S. market"));
  assert.ok(s[0].includes("3.14"));
  assert.ok(s[1].includes("e.g. the Acme"));
});

test("splitter keeps numbered lists and lowercase continuations whole", () => {
  assert.equal(splitSentences("Steps: 1. open the vault 2. ask a question and wait.").length, 1);
  assert.equal(
    splitSentences("It shipped v1.2 of the app. then everything changed.").length,
    1,
    "lowercase continuation refuses the split",
  );
});

test("splitter handles quotes, questions, and exclamations", () => {
  const s = splitSentences('"Did it work?" She said yes! The report agrees.');
  assert.equal(s.length, 3, JSON.stringify(s));
  assert.equal(s[0], '"Did it work?"');
});

test("unsplittable text rides whole", () => {
  assert.equal(splitSentences("no terminators here at all").length, 1);
  assert.equal(splitSentences("").length, 0);
});

// --- The digest ---------------------------------------------------------------

const ctx = (name, text) => ({ name, text, score: 1 });

test("digest preserves block count, order, and names (the [n] contract)", () => {
  const longA = `Revenue was 42 in the west. ${"Filler sentence here. ".repeat(40)}`;
  const out = digestContexts(
    [ctx("a.md", longA), ctx("b.md", "Short block stays whole.")],
    "west revenue",
    3_500,
    700,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "a.md");
  assert.equal(out[1].name, "b.md");
  assert.equal(out[1].text, "Short block stays whole.");
});

test("digest keeps question-relevant sentences verbatim with gap marks", () => {
  const text = `Intro fluff sentence first. Revenue was 42 in the west region. ${"Unrelated filler sentence. ".repeat(30)}The margin was 9 percent in the west. Tail fluff closes.`;
  const out = digestContexts([ctx("r.md", text)], "west region revenue margin", 3_500, 400);
  const t = out[0].text;
  assert.ok(t.includes("Revenue was 42 in the west region."), t);
  assert.ok(t.includes("…"), t);
  assert.ok(!t.includes("Intro fluff"), t);
  assert.ok(Array.from(t).length <= 420, `${Array.from(t).length}`);
});

test("neighbor overlap dedupes from the later block", () => {
  const shared = "The west region led all quarters this year with steady growth.";
  const a = `${shared} Alpha detail sentence follows. ${"Pad sentence here. ".repeat(30)}`;
  const b = `${shared} Beta detail sentence follows. ${"More padding text. ".repeat(30)}`;
  const out = digestContexts(
    [ctx("a.md", a), ctx("b.md", b)],
    "west region led quarters",
    3_500,
    600,
  );
  assert.ok(out[0].text.includes(shared));
  assert.ok(!out[1].text.includes(shared), out[1].text);
});

test("digest is deterministic and tokens are the ≥3-char lexical set", () => {
  const text = `Alpha 42 west. ${"Filler sentence. ".repeat(50)}`;
  const a = digestContexts([ctx("x", text)], "west", 3_500, 300);
  const b = digestContexts([ctx("x", text)], "west", 3_500, 300);
  assert.equal(a[0].text, b[0].text);
  assert.deepEqual(questionTokens("Total units by region?"), ["total", "units", "region"]);
});
