# Cross-conversation recall: "you asked something like this before" (Phase 2)

## Why

An analyst's questions repeat and build on each other — "what did we conclude
about Q3 churn?", "pull up that regional breakdown again". Today each
conversation is an island: the answer to a question you worked through last
week is in a past chat you'd have to find and reopen by hand. The vault already
keeps multi-conversation history (opt-in, on-device — add-chat-history), so the
material for recall is right there; it just isn't surfaced.

Cross-conversation recall closes that loop: as you type a question, the app
finds the most relevant prior exchanges from your *other* conversations and
offers them — one tap to reopen the earlier answer. It is deterministic,
on-device, and **passive by design**: recall never injects anything into the
prompt or calls the model — it only surfaces what you already said, for you to
choose to revisit. That keeps the privacy posture intact (nothing leaves the
machine, nothing is silently added to a new ask) and makes the feature honest —
a suggestion, not a hidden context change.

## What Changes

- **A relevance ranker over past chats**: a new pure `src/lib/recall.ts` scores
  the current draft question against the user↔assistant exchanges in stored
  conversations (lexical term overlap, stop-worded, with a recency tiebreak),
  excludes the current conversation, returns at most one best exchange per past
  conversation and a small top-K overall. Pure and DOM-free, so the ranking is
  unit-tested without a store.
- **A quiet "From earlier chats" affordance**: in the chat composer/empty state,
  when recall finds matches, a compact list of past questions appears; tapping
  one opens that conversation (the existing conversation-switch path). It shows
  only when there is a non-trivial query AND matches exist.
- **Fail-closed on the privacy switch**: recall reads only what history
  persistence already stores. When "save chats on this device" is off there are
  no stored conversations, so recall is empty — the feature cannot resurface
  anything the user chose not to keep. A managed policy that forbids persisting
  conversations therefore disables recall for free.

## Capabilities

### New Capabilities
- `conversation-recall`: surfacing relevant prior exchanges from a user's other
  on-device conversations as a passive, opt-in-gated suggestion.

## Impact

- New `src/lib/recall.ts` (pure ranker) + `test/recall.test.mjs`.
- `src/features/chat/ChatPanel.tsx`: a compact recall affordance wired to the
  existing conversation-switch action, reading conversations from `useChatStore`
  and gated on history persistence being enabled.
- **No engine change, no Rust twin**: conversations live only in the client
  store (`useChatStore`, localStorage) — there is no engine-side conversation
  store to mirror, so recall is client-only, like theme and other FE-local
  features. Documented, not an accidental parity gap.

## Non-goals

- **No prompt injection / auto-context** — recall never adds past turns to a new
  ask; it only offers them for the user to open. (Feeding a chosen past answer
  back into a question is just the normal "ask in that conversation" flow.)
- **No semantic/embedding search** — the on-device embedder indexes the vault,
  not chat history; recall is deterministic lexical ranking, which is
  explainable and needs no model. (An embedding-backed recall is a possible
  later refinement, not this change.)
- **No server round-trip** — ranking is local and synchronous.
- **No cross-device recall** — only this device's stored conversations.
- **Nothing when history is off** — recall has no private store of its own.
