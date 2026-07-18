/**
 * Unit tests for the multi-document synthesis trigger (src/server/synth.ts):
 * cross-document cue detection and document ranking from retrieval hits.
 * The Rust twins (lighthouse-core/src/synth.rs) mirror these cases — keep the
 * fixtures aligned so both engines trigger identically.
 *
 * Run: `node --test test/synth.cues.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { crossDocCue, rankDocsFromHits, multiFileSpan } = await import("../src/server/synth.ts");

// §3 cross-file span trigger. References are one-per-source, score-descending
// and normalized to the top = 1.0. KEEP ALIGNED with the Rust twin
// (lighthouse-core/src/synth.rs::multi_file_span, SECONDARY_FILE_MIN = 0.6).
test("span: two comparably-relevant sources trigger synthesis", () => {
  const ref = (score) => ({ fileId: `x${score}`, name: `f${score}`, snippet: "", score });
  assert.equal(multiFileSpan([ref(1.0), ref(0.7)]), true, "2nd within reach → cross-file");
  assert.equal(multiFileSpan([ref(1.0), ref(0.6)]), true, "boundary (>= 0.6) triggers");
  assert.equal(multiFileSpan([ref(1.0), ref(0.4)]), false, "weak 2nd → single-doc focus");
  assert.equal(multiFileSpan([ref(1.0)]), false, "single source never spans");
  assert.equal(multiFileSpan([]), false, "no sources");
});

test("cue: comparison words trigger", () => {
  assert.equal(crossDocCue("Compare the Q3 report with the Q2 report"), true);
  assert.equal(crossDocCue("q3 versus q2 revenue"), true);
  assert.equal(crossDocCue("Q3 vs. Q2 — what changed?"), true);
  assert.equal(crossDocCue("what's the overall trend across my invoices"), true);
  assert.equal(crossDocCue("synthesize the findings"), true);
});

test("cue: multi-document phrases trigger", () => {
  assert.equal(crossDocCue("summarize all my documents"), true);
  assert.equal(crossDocCue("what does each file say about late fees?"), true);
  assert.equal(crossDocCue("look at both reports and tell me the difference"), true);
  assert.equal(crossDocCue("what do these files have in common?"), true);
});

test("cue: ordinary single-doc questions do NOT trigger", () => {
  assert.equal(crossDocCue("what were 2017 sales?"), false);
  assert.equal(crossDocCue("summarize the onboarding doc"), false);
  assert.equal(crossDocCue("when is the invoice due?"), false);
  // "vs" must match as a word, not inside one ("canvas").
  assert.equal(crossDocCue("what is on the canvas layer?"), false);
  // "all"/"each"/"every" alone are too loose without a document noun.
  assert.equal(crossDocCue("list all caps words in the readme"), false);
});

test("rankDocsFromHits groups chunks by file, sums scores, normalizes", () => {
  const refs = [
    { fileId: "a", name: "a.md", snippet: "", score: 0.9 },
    { fileId: "b", name: "b.md", snippet: "", score: 0.8 },
    { fileId: "a", name: "a.md", snippet: "", score: 0.7 }, // second chunk of a
    { fileId: "c", name: "c.md", snippet: "", score: 0.2 },
  ];
  const docs = rankDocsFromHits(refs, 6);
  assert.deepEqual(docs.map((d) => d.id), ["a", "b", "c"]); // a: 1.6, b: 0.8, c: 0.2
  assert.equal(docs[0].score, 1); // top normalizes to 1
  assert.ok(docs[1].score === 0.5); // 0.8 / 1.6
});

test("rankDocsFromHits caps at max", () => {
  const refs = Array.from({ length: 10 }, (_, i) => ({
    fileId: `f${i}`,
    name: `f${i}.md`,
    snippet: "",
    score: 1 - i * 0.05,
  }));
  assert.equal(rankDocsFromHits(refs, 6).length, 6);
});
