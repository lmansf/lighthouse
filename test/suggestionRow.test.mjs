/**
 * §48 §2: suggestions reach beyond the empty hero — a calm, validated, ≤3 chip
 * row above the follow-up composer mid-conversation, gated so there's no row
 * unless a chip would succeed. Source-pinned (ChatPanel is JSX the node runner
 * can't import); live behavior is the E2E / simulator pass.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(ROOT, "src/features/chat/ChatPanel.tsx"), "utf8");

test("the mid-conversation suggestion row renders above the follow-up composer, gated on validated chips", () => {
  // The affordance is gated so there's no row unless a validated chip would
  // succeed — the same ≤3 combined list the hero uses (calm, no dead row).
  assert.match(
    chat,
    /\{mergedChips\.length > 0 && \(\s*\n\s*<div className=\{styles\.followUpSuggestRow\} data-lh-followup-suggest>/,
    "no row when nothing is valid; the mid-conversation row is its own calm style",
  );
  // …and it sits directly above the follow-up composer.
  assert.match(
    chat,
    /data-lh-followup-suggest>[\s\S]{0,200}\{composer\("Ask a follow-up/,
    "the mid-conversation chip row precedes the follow-up composer",
  );
  // The SAME merged ≤3 list feeds BOTH the hero and the mid-conversation row —
  // one validated source, one cap, two mount points.
  assert.equal(
    (chat.match(/<SuggestionChips chips=\{mergedChips\}/g) ?? []).length,
    2,
    "the merged list feeds the hero and the mid-conversation row",
  );
});
