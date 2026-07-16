/**
 * Investigation context in the chat store (openspec: add-investigations §4.1)
 * — src/stores/useChatStore.ts.
 *
 * The pure seam is `conversationsForContext` (the history drawer's filter):
 * inside an investigation only its own conversations show, and the GLOBAL
 * context shows only unassigned ones — deliberately not a mixed bucket, since
 * an investigation's chats live inside it. The store actions around it are
 * exercised directly (zustand runs fine under node; with no `window` the
 * store is memory-only, which is exactly what these tests want): stamping on
 * "New chat", context-follows-conversation on open, and the never-mix rule on
 * a context switch.
 *
 * Run: `node --test test/chatStore.investigations.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { useChatStore, conversationsForContext } = await import("../src/stores/useChatStore.ts");

/** A minimal saved conversation in a given context (undefined = global). */
function conv(id, investigationId, messages = []) {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages,
    ...(investigationId ? { investigationId } : {}),
  };
}

/** Reset the singleton store to a clean baseline between tests. */
function reset() {
  const fresh = conv("root");
  useChatStore.setState({
    conversations: [fresh],
    currentId: fresh.id,
    messages: fresh.messages,
    lastLeftId: null,
    currentInvestigationId: null,
  });
}

/** Put a user turn into the ACTIVE conversation (fold via persist, like a
 *  settled turn does), so "current conversation is non-empty" paths engage. */
function speak(text) {
  useChatStore.getState().setMessages([{ id: "u1", role: "user", content: text }]);
  useChatStore.getState().persist();
}

// --- The pure filter -------------------------------------------------------

test("an investigation's list shows only its own conversations", () => {
  const all = [conv("a", "inv-1"), conv("b", "inv-2"), conv("c")];
  assert.deepEqual(
    conversationsForContext(all, "inv-1").map((c) => c.id),
    ["a"],
  );
});

test("the global context shows ONLY unassigned conversations — never a mixed bucket", () => {
  const all = [conv("a", "inv-1"), conv("legacy"), conv("b", "inv-2"), conv("plain")];
  assert.deepEqual(
    conversationsForContext(all, null).map((c) => c.id),
    ["legacy", "plain"],
  );
});

test("pre-investigations conversations (no field at all) read as global", () => {
  const legacy = { id: "old", title: "old", createdAt: 1, updatedAt: 1, messages: [] };
  assert.deepEqual(conversationsForContext([legacy], null), [legacy]);
  assert.deepEqual(conversationsForContext([legacy], "inv-1"), []);
});

// --- Store actions ---------------------------------------------------------

test("switching context on an empty scratch conversation adopts it in place (no second empty)", () => {
  reset();
  const before = useChatStore.getState().currentId;
  useChatStore.getState().setCurrentInvestigation("inv-1");
  const s = useChatStore.getState();
  assert.equal(s.currentInvestigationId, "inv-1");
  assert.equal(s.currentId, before, "same conversation — nothing to mix");
  assert.equal(s.conversations.length, 1);
  assert.equal(s.conversations[0].investigationId, "inv-1", "the scratch is re-stamped");
});

test("New chat stays within the current investigation (the fresh conversation is stamped)", () => {
  reset();
  useChatStore.getState().setCurrentInvestigation("inv-1");
  speak("first question");
  useChatStore.getState().newConversation();
  const s = useChatStore.getState();
  const current = s.conversations.find((c) => c.id === s.currentId);
  assert.equal(current.investigationId, "inv-1");
  assert.equal(s.currentInvestigationId, "inv-1", "the context pointer is unmoved");
});

test("switching away from a non-empty conversation starts a fresh stamped one — transcripts never mix", () => {
  reset();
  useChatStore.getState().setCurrentInvestigation("inv-1");
  speak("inside inv-1");
  const invConvId = useChatStore.getState().currentId;

  useChatStore.getState().setCurrentInvestigation(null);
  const s = useChatStore.getState();
  assert.equal(s.currentInvestigationId, null);
  assert.notEqual(s.currentId, invConvId, "a fresh conversation opened");
  assert.deepEqual(s.messages, [], "the new context starts blank");
  const kept = s.conversations.find((c) => c.id === invConvId);
  assert.equal(kept.investigationId, "inv-1", "the old conversation stays, in its investigation");
  assert.equal(kept.messages.length, 1, "its transcript is intact");
  const current = s.conversations.find((c) => c.id === s.currentId);
  assert.equal(current.investigationId ?? null, null, "the fresh one belongs to the new context");
});

test("opening a conversation from another investigation switches the context to match", () => {
  reset();
  useChatStore.getState().setCurrentInvestigation("inv-1");
  speak("inv-1 chat");
  const invConvId = useChatStore.getState().currentId;
  useChatStore.getState().setCurrentInvestigation(null);
  assert.equal(useChatStore.getState().currentInvestigationId, null);

  useChatStore.getState().openConversation(invConvId);
  const s = useChatStore.getState();
  assert.equal(s.currentId, invConvId);
  assert.equal(s.currentInvestigationId, "inv-1", "context follows the conversation");
});

test("deleting an investigation's last chat falls back WITHIN the context, never into another's chat", () => {
  reset();
  speak("a global chat"); // non-empty global conversation exists
  useChatStore.getState().setCurrentInvestigation("inv-1");
  speak("the investigation's only chat");
  const invConvId = useChatStore.getState().currentId;

  useChatStore.getState().deleteConversation(invConvId);
  const s = useChatStore.getState();
  assert.equal(s.currentInvestigationId, "inv-1", "still inside the investigation");
  const current = s.conversations.find((c) => c.id === s.currentId);
  assert.equal(current.investigationId, "inv-1", "the fallback is a fresh stamped conversation");
  assert.deepEqual(current.messages, []);
  assert.ok(
    s.conversations.some((c) => (c.investigationId ?? null) === null && c.messages.length === 1),
    "the global conversation was not collateral damage",
  );
});

test("re-selecting the current context is a no-op (no fresh conversation minted)", () => {
  reset();
  useChatStore.getState().setCurrentInvestigation("inv-1");
  speak("hello");
  const before = useChatStore.getState();
  useChatStore.getState().setCurrentInvestigation("inv-1");
  const after = useChatStore.getState();
  assert.equal(after.currentId, before.currentId);
  assert.equal(after.conversations.length, before.conversations.length);
});
