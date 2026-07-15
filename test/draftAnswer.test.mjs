/**
 * Unit tests for the G2 draft-then-verify extractive draft (src/server/llm.ts).
 * The Rust twin (lighthouse-core/src/llm.rs::draft_answer) mirrors these cases —
 * keep the rendered shape byte-identical so a private-path draft reads the same
 * on both engines.
 *
 * Run: `node --test test/draftAnswer.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { draftAnswer } = await import("../src/server/llm.ts");

test("renders the top 3 passages, trimmed and clamped", () => {
  const ctxs = [
    { name: "q3.csv", text: "  north east revenue up  ", score: 3.0 },
    { name: "q2.csv", text: "y".repeat(500), score: 2.0 },
    { name: "notes.md", text: "third", score: 1.0 },
    { name: "extra.md", text: "fourth — dropped", score: 0.5 },
  ];
  const out = draftAnswer("what changed?", ctxs);
  const blocks = out.split("\n\n");
  assert.equal(blocks.length, 3, "only the top 3 passages");
  assert.ok(blocks[0].startsWith("[1] **q3.csv** — north east revenue up…"));
  assert.ok(blocks[1].startsWith("[2] **q2.csv** — "));
  assert.ok(blocks[2].startsWith("[3] **notes.md** — third…"));
  assert.ok(!out.includes("extra.md"), "the 4th passage is dropped");
  // 300-char snippet clamp on the long one (+ the trailing ellipsis char).
  const snippetLen = [...blocks[1]].length - "[2] **q2.csv** — ".length - 1;
  assert.equal(snippetLen, 300, "snippet clamped to 300 chars");
});

test("empty contexts render an empty draft", () => {
  assert.equal(draftAnswer("anything", []), "");
});
