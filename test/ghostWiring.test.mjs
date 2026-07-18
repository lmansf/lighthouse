// §22.1 ghost autocomplete WIRING — the ChatPanel side of the inline greyed
// continuation. The pure ranker (ghostCompletion / GHOST_MIN_CHARS) is
// exercised for real in test/askTypeahead.test.mjs; the composer JSX can't
// load in node, so the wiring guarantees are asserted structurally against
// the source — the chartIt.test.mjs house style. Pinned here: the ranker is
// CONSUMED (not reimplemented), the Right-Arrow accept guard (collapsed caret
// at the very end), the mention/type-ahead/IME suppression, the ~120ms
// debounce, Esc-dismiss-for-this-draft, Tab staying untouched, and the
// mirror's paint-only nature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const chat = read("src/features/chat/ChatPanel.tsx");

test("the ghost consumes the tested ranker with history + pins + engine extras", () => {
  assert.match(
    chat,
    /import \{ askSuggestions, ghostCompletion, lastAsk, type AskHistoryItem \} from "@\/lib\/askTypeahead";/,
    "ghostCompletion is imported, never reimplemented",
  );
  assert.match(
    chat,
    /ghostCompletion\(ghostDraft, \{\s*history: askHistoryItems,\s*pins: pinQuestions,\s*extras: ghostExtras,\s*\}\)/,
    "sources = past asks + pinned questions + extras",
  );
  // Extras are the §22.3 validated engine asks — ALL of them, ghost-only.
  assert.match(chat, /validatedChips\.asks\.map\(\(a\) => a\.question\)/);
});

test("Right Arrow accepts ONLY from a collapsed caret at the very end of the draft", () => {
  assert.match(chat, /if \(e\.key === "ArrowRight" && ghostText !== null\) \{/);
  assert.match(
    chat,
    /el\.selectionStart === el\.selectionEnd && el\.selectionEnd === el\.value\.length/,
    "the caret-at-end guard — → elsewhere keeps moving the caret",
  );
  assert.match(
    chat,
    /applySuggestion\(question \+ ghostText\)/,
    "accepting splices the suffix through the standard fill path (never auto-send)",
  );
  // The ghost branch sits AFTER the mention/type-ahead blocks — their
  // precedence ladder stays intact above it.
  const mentionAt = chat.indexOf('if (mentionShown) {');
  const suggestAt = chat.indexOf("if (suggestsShown) {");
  const ghostAt = chat.indexOf('if (e.key === "ArrowRight" && ghostText !== null) {');
  assert.ok(mentionAt >= 0 && suggestAt > mentionAt && ghostAt > suggestAt, "picker guards come first");
});

test("the ghost hides while either picker is open, and during IME composition", () => {
  assert.match(
    chat,
    /ghostDraft === question &&\s*!mentionShown &&\s*!suggestsShown &&\s*!composing &&\s*ghostDismissed !== question/,
    "the visibility gate covers pickers, composition, and the Esc park",
  );
  assert.match(chat, /onCompositionStart=\{\(\) => setComposing\(true\)\}/);
  assert.match(chat, /onCompositionEnd=\{\(\) => setComposing\(false\)\}/);
});

test("the ghost derives from a ~120ms debounced draft (no per-keystroke flicker)", () => {
  assert.match(chat, /const GHOST_DEBOUNCE_MS = 120;/);
  assert.match(
    chat,
    /window\.setTimeout\(\(\) => setGhostDraft\(question\), GHOST_DEBOUNCE_MS\)/,
    "the draft settles through the debounce",
  );
  // While the live draft runs ahead of the debounced one, no ghost renders.
  assert.match(chat, /ghostDraft === question/);
});

test("Esc parks the ghost for the CURRENT draft; Tab stays with the pickers", () => {
  assert.match(chat, /if \(e\.key === "Escape" && ghostText !== null\) \{/);
  assert.match(chat, /setGhostDismissed\(question\)/, "dismissal is keyed to this exact draft");
  // Tab is claimed in exactly two places — the @-mention accept and the
  // type-ahead accept — the ghost never touches it.
  assert.equal(
    (chat.match(/e\.key === "Tab"/g) ?? []).length,
    2,
    "no new Tab handling anywhere in the composer",
  );
});

test("the mirror is pure paint: aria-hidden, pointer-transparent, gone when there is no ghost", () => {
  assert.match(chat, /\{ghostText !== null && \(\s*<div aria-hidden="true" className=\{styles\.ghostMirror\}>/);
  assert.match(chat, /ghostMirror: \{[\s\S]{0,600}pointerEvents: "none"/, "never intercepts the field");
  // The typed prefix repeats invisibly; the suffix uses the placeholder grey.
  assert.match(chat, /ghostTyped: \{ color: "transparent" \}/);
  assert.match(chat, /ghostSuffix: \{ color: tokens\.colorNeutralForeground4 \}/);
  // Wrapping fidelity: the mirror pins the same metrics the textarea slot uses.
  assert.match(chat, /ghostMirror: \{[\s\S]{0,600}whiteSpace: "pre-wrap"/);
});

test("the widget input stays ghost-free by decision (main window is the surface)", () => {
  // WidgetBar deliberately carries no chat store (its own header comment), its
  // session corpus is at most a handful of inline asks, and a filled-in ask
  // would collide with Enter-activates-row semantics — so the ghost is NOT
  // wired there. This pin makes the skip a decision, not an accident.
  assert.doesNotMatch(read("src/features/widget/WidgetBar.tsx"), /ghostCompletion/);
});
