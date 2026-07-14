# Design — conversation recall

## Why client-only (no Rust twin)

Chat history lives entirely in the front-end store `useChatStore` (localStorage,
opt-in — add-chat-history). There is no engine-side conversation store to mirror,
so recall is a client feature by construction, like theme persistence. This is a
documented, deliberate divergence — not a parity gap the PARITY sweep should
flag.

## The ranker (`src/lib/recall.ts`, pure)

Input is decoupled from the store so it's testable without React:

```
RecallConversation { id, title, updatedAt, messages: { role, content }[] }
RecallHit { conversationId, conversationTitle, question, answer, updatedAt, score }
recallRelated(query, conversations, { currentId, limit }): RecallHit[]
```

Algorithm:
1. Tokenize the query: lowercase, split on non-word, drop tokens shorter than 3
   and a small stop-word set. If fewer than 2 meaningful tokens remain, return
   `[]` (a one-word draft isn't a recall signal).
2. Walk each conversation except `currentId`. Pair each `user` message with the
   next `assistant` message (the exchange). Build the exchange's token set from
   question + answer.
3. Score = count of query tokens present in the exchange token set (overlap).
   Keep only the best-scoring exchange per conversation with score ≥ 2.
4. Sort by score desc, then `updatedAt` desc (recency tiebreak), take `limit`
   (default 3).

Deterministic, allocation-light, and explainable — the user can see *why* a
past chat matched (shared words). No embeddings, no model, no async.

## Surfacing (`ChatPanel.tsx`)

- Read conversations from `useChatStore`. Gate on the same flag the store uses
  to decide whether history is persisted (persist-enabled); when off, the list
  is empty and recall renders nothing.
- Compute `recallRelated(draft, conversations, { currentId })` from the live
  composer value (debounced with the same idiom already used for other
  composer-derived UI). Render a compact "From earlier chats" row of chips —
  each the past question (truncated) — above/near the composer, only when the
  result is non-empty.
- Tapping a chip calls the existing conversation-switch action (the same one the
  history list uses) to open that conversation. No new store action, no ask
  mutation.

## Trust / privacy

Recall touches only already-stored, already-on-device data and never emits
anything: no network, no prompt change. Because it reads through the same store
history persistence controls, the existing "off" and managed-lock paths disable
it with no extra code — fail-closed by construction.
