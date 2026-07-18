/**
 * @-mention composer attach (openspec: add-usability-field-patch §2). The pure
 * token parser (src/lib/mentionQuery.ts) is exercised FOR REAL — its trigger
 * rules are the whole safety story (prose and emails must not open a file
 * picker) — and the ChatPanel wiring (which can't load in node) is asserted
 * structurally against the source, the boardsUi/providerSignin house style.
 *
 * Run: `node --test test/mentionQuery.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { activeMention, replaceMention } = await import("../src/lib/mentionQuery.ts");

// --- A. Trigger rules (the safety boundary) ---------------------------------

test("no '@' → no mention", () => {
  assert.equal(activeMention("just a question", 15), null);
  assert.equal(activeMention("", 0), null);
});

test("a bare '@' at the caret is an active (empty-query) mention", () => {
  assert.deepEqual(activeMention("@", 1), { query: "", start: 0, end: 1 });
});

test("'@' at start or after whitespace opens; the query is the run to the caret", () => {
  assert.deepEqual(activeMention("@rep", 4), { query: "rep", start: 0, end: 4 });
  assert.deepEqual(activeMention("ask about @rep", 14), { query: "rep", start: 10, end: 14 });
  assert.deepEqual(activeMention("@a\n@b", 5), { query: "b", start: 3, end: 5 }); // newline = ws
});

test("an email / mid-word '@' never triggers", () => {
  assert.equal(activeMention("you@example.com", 15), null);
  assert.equal(activeMention("a@b", 3), null);
});

test("whitespace ends the token — caret past the space is not a mention", () => {
  assert.equal(activeMention("@rep ort", 8), null);
  // …but the caret still inside the token IS a mention.
  assert.deepEqual(activeMention("@rep ort", 4), { query: "rep", start: 0, end: 4 });
});

test("multiple mentions: the token nearest the caret wins", () => {
  assert.deepEqual(activeMention("@a @b", 5), { query: "b", start: 3, end: 5 });
  assert.deepEqual(activeMention("@a @b", 2), { query: "a", start: 0, end: 2 });
});

test("caret is clamped; an over-long query (a stray '@') is refused", () => {
  assert.deepEqual(activeMention("@rep", 999), { query: "rep", start: 0, end: 4 });
  assert.equal(activeMention("@" + "x".repeat(200), 201, 100), null);
});

// --- B. Strip on accept ------------------------------------------------------

test("replaceMention drops the '@fragment' and reports the caret", () => {
  const span = activeMention("ask @rep more", 8); // "@rep"
  assert.deepEqual(span, { query: "rep", start: 4, end: 8 });
  assert.deepEqual(replaceMention("ask @rep more", span), { text: "ask  more", caret: 4 });
});

// --- C. ChatPanel wiring (structural — the JSX can't load in node) ----------

test("ChatPanel wires the @-mention picker to quick-open + the attach path", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  // Reuses the quick-open matcher + its emphasis, and the mention parser.
  assert.match(chat, /from "@\/lib\/quickOpen"/);
  assert.match(chat, /import \{ emphasize \} from "@\/features\/quickopen\/QuickOpen"/);
  assert.match(chat, /activeMention, replaceMention.*from "@\/lib\/mentionQuery"/);
  // Ranks FILES with quickOpenMatches, filtered to attachable (not already on).
  assert.match(chat, /quickOpenMatches\(mention\.query, nodes/);
  assert.match(chat, /c\.kind === "file" && !attachedIds\.has\(c\.id\)/);
  // Accept: attach via the existing path, then strip the token from the draft.
  assert.match(chat, /addAttachments\(\[\{ id: candidate\.id, name: candidate\.name \}\]\)/);
  assert.match(chat, /replaceMention\(text, mention\)/);
  // One popover at a time: the mention picker suppresses the ask type-ahead.
  assert.match(chat, /&& !mentionShown/);
  // The listbox + the keyboard precedence block.
  assert.match(chat, /id="mention-listbox"/);
  assert.match(chat, /if \(mentionShown\) \{/);
});

test("emphasize is exported for reuse", () => {
  assert.match(read("src/features/quickopen/QuickOpen.tsx"), /export function emphasize/);
});
