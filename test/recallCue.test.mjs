// G6 recall cue + source-kind classifier — byte-parity with the Rust twins
// (lighthouse-core::synth::recall_cue and vault::source_kind_of). Mirrors the
// Rust tests synth::tests::recall_cue_triggers_on_self_reference_only and
// source_kind_is_path_based_and_exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// vault.ts uses TypeScript's extensionless relative imports; register the hook.
register("./_ts-extensionless-hook.mjs", import.meta.url);

const { recallCue, sourceKindOf } = await import("../src/server/vault.ts");

test("recallCue triggers on self-reference frames only (Rust parity)", () => {
  for (const q of [
    "what did I conclude about churn?",
    "What did we conclude on pricing",
    "did I ask about Q3 revenue?",
    "have I asked about the refund policy",
    "what did I decide regarding vendors",
    "what did I find in the audit",
  ]) {
    assert.equal(recallCue(q), true, `should trigger: ${q}`);
  }
  for (const q of [
    "what is churn?",
    "conclude the report",
    "what did the memo say?",
    "summarize my invoices",
    "what were 2017 sales?",
  ]) {
    assert.equal(recallCue(q), false, `should NOT trigger: ${q}`);
  }
});

test("sourceKindOf is path-based and exact (Rust parity)", () => {
  assert.equal(sourceKindOf("Lighthouse Notes/Chats/My chat [ab12cd34].md"), "conversation");
  assert.equal(sourceKindOf("Lighthouse Notes/x.md"), "file");
  assert.equal(sourceKindOf("a/b.md"), "file");
  assert.equal(sourceKindOf(""), "file");
  // The trailing slash is required — a sibling folder is NOT a conversation.
  assert.equal(sourceKindOf("Lighthouse Notes/Chatsz/x.md"), "file");
});
