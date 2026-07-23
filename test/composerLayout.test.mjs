/**
 * §43 §1 (CONVENTIONS "Cross-feature structural floors"): the chat composer's
 * Ask/Stop button must never be crowded off its own text by a long draft. The
 * floor is two cooperating rules that are easy to silently regress in a style
 * refactor, so they are pinned structurally:
 *
 *   - the Ask/Stop button carries `composerAction` with flexShrink:0 (it never
 *     shrinks), and
 *   - the field (composerField) carries minWidth:0 (it yields instead).
 *
 * Together they guarantee that at 320pt with a long single-line draft — and in
 * the multi-line max-height state — the button stays whole and separated. The
 * reserved gutter (the composer's gap) keeps typed text off the button.
 *
 * Run: `node --test test/composerLayout.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(ROOT, "src/features/chat/ChatPanel.tsx"), "utf8");

test("the Ask/Stop button never shrinks (composerAction flexShrink:0)", () => {
  assert.match(
    chat,
    /composerAction:\s*\{\s*flexShrink:\s*0\s*\}/,
    "composerAction pins flexShrink:0 so the button stays whole",
  );
  // Both the streaming (Stop) and idle (Ask) buttons wear it.
  const usages = chat.match(/className=\{styles\.composerAction\}/g) ?? [];
  assert.ok(usages.length >= 2, "both Ask and Stop carry composerAction");
});

test("the field yields, not the button (composerField minWidth:0)", () => {
  // The composerField block declares minWidth:0 so a long draft shrinks the
  // textarea rather than the button.
  const block = chat.slice(chat.indexOf("composerField: {"));
  assert.match(
    block.slice(0, 400),
    /minWidth:\s*0/,
    "composerField yields via minWidth:0",
  );
});

test("the composer reserves a right gutter (gap M) and keeps the pill look", () => {
  const block = chat.slice(chat.indexOf("composer: {"), chat.indexOf("composerAction:"));
  assert.match(block, /gap:\s*tokens\.spacingHorizontalM/, "the reserved gutter is the M gap");
  // The 22px pill + shadow8 identity is unchanged.
  assert.match(block, /borderRadius\("22px"\)/);
  assert.match(block, /boxShadow:\s*tokens\.shadow8/);
});
