/**
 * Read-from-the-top chat scroll (openspec: add-investigations §5.1).
 *
 * When an answer begins streaming, the top of its message row anchors to the
 * top of the chat viewport and holds there; any manual scroll cancels the
 * hold; jumps are instant (reduced-motion safe); reference cards append below
 * without displacing the anchored start; the widget pill is unaffected.
 *
 * The behavior is DOM wiring inside ChatPanel.tsx — a JSX module the node
 * runner cannot import — so, like firstRunTour.test.mjs, the guarantees are
 * asserted structurally against the source: they are properties of WHERE the
 * scroll writes happen and WHAT cancels them. The live scroll behavior itself
 * is covered by the E2E pass (tasks.md §6.1), not here.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const chat = read("src/features/chat/ChatPanel.tsx");

test("streaming no longer bottom-follows: the ask arms a top-anchor for its answer", () => {
  // The old [messages] effect pinned scrollTop = scrollHeight while streaming.
  assert.doesNotMatch(
    chat,
    /pinnedRef\.current\)\s*el\.scrollTop\s*=\s*el\.scrollHeight/,
    "the pinned bottom-follow is gone",
  );
  assert.match(
    chat,
    /anchorRef\.current = \{ id: asstId, phase: "armed" \}/,
    "sending a question arms the hold for the upcoming answer (no unconditional re-pin)",
  );
  // First content flips armed → holding; the row is found by its stable id
  // attribute and the target position goes through the pure clamp helper.
  assert.match(chat, /anchor\.phase = "holding"/, "first content starts the hold");
  assert.match(
    chat,
    /querySelector<HTMLElement>\(`\[data-lh-turn="\$\{anchor\.id\}"\]`\)/,
    "the anchored element is the answer's own turn row",
  );
  assert.match(chat, /computeAnchorScrollTop\(anchorTop, paddingTop,/, "anchor math is the pure helper");
});

test("anchor jumps are instant scrollTop writes — reduced-motion needs no special case", () => {
  // Every programmatic transcript scroll funnels through writeScrollTop's one
  // plain assignment (which also records the echo position). A second raw
  // assignment or a new smooth scroll would bypass both guarantees.
  assert.equal(
    (chat.match(/\.scrollTop\s*=[^=]/g) ?? []).length,
    1,
    "exactly one raw scrollTop assignment (inside writeScrollTop)",
  );
  assert.match(
    chat,
    /el\.scrollTop = top;\s*\n\s*programmaticScrollTopRef\.current = el\.scrollTop;/,
    "writeScrollTop records the applied (post-clamp) position",
  );
  // The single smooth scroll in the file is the pre-existing, user-initiated
  // citation-chip card reveal — not part of the streaming anchor machinery.
  assert.equal(
    (chat.match(/\.scrollIntoView\(/g) ?? []).length,
    1,
    "no new scrollIntoView beside the citation-chip reveal",
  );
  assert.equal(
    (chat.match(/behavior:\s*"smooth"/g) ?? []).length,
    1,
    "no new smooth scrolling beside the citation-chip reveal",
  );
});

test("the user wins: any scroll we didn't write releases the hold", () => {
  // handleBodyScroll treats a scroll event away from the recorded programmatic
  // position as user intent and drops the anchor.
  assert.match(
    chat,
    /const expected = programmaticScrollTopRef\.current;\s*\n\s*if \(expected === null \|\| Math\.abs\(el\.scrollTop - expected\) > 1\) \{\s*\n\s*anchorRef\.current = null;/,
    "non-programmatic scroll positions cancel the hold",
  );
  // Belt-and-braces: wheel/touch are user intent even when clamped at an edge.
  assert.match(chat, /onWheel=\{cancelHoldOnUserInput\}/, "wheel cancels");
  assert.match(chat, /onTouchMove=\{cancelHoldOnUserInput\}/, "touch cancels");
  // Native scroll anchoring would adjust scrollTop on reflow and masquerade as
  // a user scroll (spuriously cancelling the hold): it stays disabled.
  assert.match(chat, /overflowAnchor: "none"/, "native scroll anchoring is off in the transcript");
  // Jump-to-latest is explicit user intent: it drops the hold, then bottoms.
  assert.match(
    chat,
    /function jumpToLatest\(\) \{\s*\n[^\n]*\n\s*anchorRef\.current = null;[\s\S]{0,120}writeScrollTop\(el, el\.scrollHeight\);/,
    "jumpToLatest cancels the hold and scrolls to the bottom",
  );
  // The pill keeps its meaning: visible while streaming away from the bottom.
  assert.match(chat, /\{streaming && !pinned && \(/, "Jump-to-latest pill still gated on !pinned");
});

test("stream end stops anchoring without jumping; opening a conversation still lands at the bottom", () => {
  // The settle path clears the hold before React flushes the settle updates,
  // so the effect goes dormant (it scrolls only while a hold is active).
  assert.match(
    chat,
    /flushStreamNow\(\);[\s\S]{0,500}anchorRef\.current = null;\s*\n\s*abortRef\.current = null;/,
    "the finally block releases the hold when the turn settles",
  );
  // Conversation switches (open / undo / delete-fallback / initial mount) keep
  // the pre-feature landing: clear any hold, bottom the transcript.
  assert.match(
    chat,
    /anchorRef\.current = null;\s*\n\s*const el = bodyRef\.current;\s*\n\s*if \(!el\) return;\s*\n\s*writeScrollTop\(el, el\.scrollHeight\);\s*\n\s*derivePinned\(el\);\s*\n\s*\}, \[currentId, writeScrollTop, derivePinned\]\);/,
    "the [currentId] landing effect bottoms the transcript",
  );
});

test("the widget pill is unaffected: none of the anchor machinery leaks into WidgetBar", () => {
  assert.doesNotMatch(
    read("src/features/widget/WidgetBar.tsx"),
    /anchorRef|computeAnchorScrollTop|programmaticScroll|data-lh-turn|writeScrollTop/,
    "WidgetBar carries no read-from-the-top machinery",
  );
});
