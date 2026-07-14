# Tasks — add-conversation-recall

## 1. Ranker (pure, unit-tested)
- [x] 1.1 `src/lib/recall.ts`: `RecallConversation`/`RecallHit` types +
      `recallRelated(query, conversations, { currentId, limit })`.
- [x] 1.2 Tokenize + stop-word + min-token gate; pair user↔assistant exchanges;
      overlap score; best-per-conversation; score≥2; sort score/recency; cap.
- [x] 1.3 `test/recall.test.mjs`: matches surfaced, current excluded, one hit per
      conversation, thin draft → none, recency tiebreak, no-match → empty (5 tests).

## 2. Surfacing
- [x] 2.1 `ChatPanel.tsx`: read conversations from `useChatStore` gated on
      `persistEnabled`; compute recall from the draft (`useMemo`); render a compact
      "From earlier chats" chip row above the composer when non-empty; tap →
      `openConversation`. No ask mutation, no new store action.

## 3. Gates
- [x] 3.1 `npm test` (107, incl. ranker) + `npm run lint` (clean) + static export green.
