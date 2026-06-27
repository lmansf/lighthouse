# Agent brief: chat

## Scope (yours)
- `src/features/chat/` only. Replace the `ChatPanel.tsx` placeholder.

A Google-style answer surface: the AI answer on top, related/reference files beneath, streamed in realtime.

## Contract you implement against
- Scope retrieval via `useRagStore().includedFileIds()` - only included files are queryable.
- Call `ChatService.ask(question, includedFileIds)` from `@/contracts`. It returns an `AsyncIterable<ChatChunk>`; append each `chunk.delta`, and the terminating chunk (`done: true`) carries `references: RagReference[]`.
- Render `RagReference` (`fileId`, `name`, `snippet`, `score`) as the "related files" list.

## What to build
1. **Composer** + transcript of turns.
2. Each assistant turn: **answer streamed token-by-token at the top**, then a **"Related files"** list of reference cards below (name, snippet, score), appearing as the stream resolves.
3. Realtime feel - show streaming state; let the user ask follow-ups.
4. Empty/grounding states: if `includedFileIds()` is empty, prompt the user to include files first (the backend returns a no-grounding answer in that case).

## Acceptance criteria
- Streaming renders incrementally (not all-at-once).
- References are clickable affordances that reference real `fileId`s from the store (wiring to "reveal in explorer" can be a store flag later - do not import the explorer).
- The "N sources available" indicator tracks `includedFileIds()` live.
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`. No hardcoded colors.
- Don't import explorer/onboarding/shell internals; coordinate only through `@/contracts` and stores.
