/**
 * §33 §1: the feedback nudge becomes gentle on compact — a calm-moment modal
 * decided by a pure verdict — and never occludes navigation anywhere (the
 * desktop bubble rides the bug FAB's tab-bar/safe-area offset expression).
 * The verdict is unit-tested for real; the wiring and the pill are pinned
 * structurally against the sources (the chartIt.test.mjs house style).
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { NUDGE_DWELL_MS, nudgeCalm, nudgePresentVerdict } = await import(
  "../src/features/feedback/nudgeVerdict.ts"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const nudge = read("src/features/feedback/FeedbackNudge.tsx");

/** A gate that PASSES everything — each case below flips exactly one field. */
const calm = {
  compact: true,
  onChatTab: true,
  dwellMs: NUDGE_DWELL_MS,
  sheetOpen: false,
  dialogOpen: false,
  keyboardUp: false,
  tourActive: false,
  streaming: false,
};

test("the calm moment presents; every single disturbance holds it back", () => {
  assert.equal(nudgePresentVerdict(calm), true, "all conditions held → present");
  for (const [field, value] of [
    ["compact", false],
    ["onChatTab", false],
    ["sheetOpen", true],
    ["dialogOpen", true],
    ["keyboardUp", true],
    ["tourActive", true],
    ["streaming", true],
  ]) {
    assert.equal(
      nudgePresentVerdict({ ...calm, [field]: value }),
      false,
      `${field}=${value} must hold the nudge back`,
    );
  }
});

test("the dwell is a floor: calm must HOLD ~3s before presenting", () => {
  assert.equal(nudgePresentVerdict({ ...calm, dwellMs: 0 }), false);
  assert.equal(nudgePresentVerdict({ ...calm, dwellMs: NUDGE_DWELL_MS - 1 }), false);
  assert.equal(nudgePresentVerdict({ ...calm, dwellMs: NUDGE_DWELL_MS }), true);
  // nudgeCalm is the same conditions minus the dwell — the ticker's reset test.
  assert.equal(nudgeCalm({ ...calm, dwellMs: 0 }), true);
  assert.equal(nudgeCalm({ ...calm, dwellMs: 0, streaming: true }), false);
});

test("eligibility semantics are unchanged: the exact keys, timer, and snooze", () => {
  assert.match(nudge, /const NUDGE_AFTER_MS = 5 \* 60 \* 1000;/, "5-min visible-time timer");
  assert.match(nudge, /const SHOWN_KEY = "lighthouse\.feedbackNudge\.shown";/);
  assert.match(nudge, /const SNOOZED_UNTIL_KEY = "lighthouse\.feedbackNudge\.snoozedUntil";/);
  assert.match(nudge, /const SNOOZE_MS = 3 \* 24 \* 60 \* 60 \* 1000;/, "3-day snooze");
  // Engage = permanent flag + the one open-feedback event; dismiss = snooze.
  assert.match(nudge, /localStorage\.setItem\(SHOWN_KEY, "1"\);/);
  assert.match(nudge, /new CustomEvent\("lighthouse:open-feedback"\)/);
});

test("no nudge surface is position:fixed without the tab-bar offset", () => {
  // Exactly ONE fixed surface in the file (the desktop bubble) …
  const fixed = nudge.match(/position: "fixed"/g) ?? [];
  assert.equal(fixed.length, 1, "the bubble is the only fixed nudge surface");
  // … and its bottom carries the bug FAB's offset expression (0 on desktop).
  assert.match(
    nudge,
    /bottom: `calc\(var\(--lh-tabbar-h, 0px\) \+ var\(--lh-safe-bottom, 0px\) \+ \$\{tokens\.spacingVerticalL\}\)`/,
    "the bubble rides the FAB's tab-bar/safe-area offset",
  );
});

test("compact never renders the pill: modal-or-nothing behind the verdict", () => {
  // The compact branch returns before the bubble JSX can render …
  assert.match(nudge, /if \(shell\.compact\) \{\s*\n\s*if \(!modalOpen\) return null;/);
  // … presents through the pure verdict + the house Dialog …
  assert.match(nudge, /nudgePresentVerdict\(\{ \.\.\.gate, dwellMs \}\)/);
  assert.match(nudge, /<DialogTitle>What do you think so far\?<\/DialogTitle>/);
  assert.match(nudge, />\s*Not now\s*<\/Button>/);
  assert.match(nudge, />\s*Share feedback\s*<\/Button>/);
  // … and "Not now" is the SAME 3-day snooze (one function, both surfaces).
  assert.match(nudge, /onClick=\{snooze\}/);
});

test("the shell bus is published by its owners (AppShell + ChatPanel)", () => {
  const appShell = read("src/shell/AppShell.tsx");
  assert.match(
    appShell,
    /publishShellUi\(\{\s*\n\s*compact: layout\.compact,\s*\n\s*activeTab: compactTab,\s*\n\s*keyboardUp: keyboardInset > 0 \|\| editableFocused,\s*\n\s*\}\);/,
    "AppShell publishes the three signals it owns",
  );
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /publishChatStreaming\(streaming\);/, "ChatPanel mirrors streaming");
});
