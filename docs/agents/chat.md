# Agent brief: chat

## Scope (yours)
- `src/features/chat/` only. Replace the `ChatPanel.tsx` placeholder.

A Google-style answer surface: the AI answer on top, related/reference files beneath, streamed in realtime.

## Contract you implement against
- Scope retrieval via `useRagStore().includedFileIds()` - only included files are queryable.
- Call `ChatService.ask(question, includedFileIds, history?, attachmentFileIds?)` from `@/contracts`. It returns an `AsyncIterable<ChatChunk>`; append each `chunk.delta`, and the terminating chunk (`done: true`) carries `references: RagReference[]`. Pass prior turns as `history: ChatTurn[]` (`{ role, content }`) so follow-up questions resolve against the ongoing conversation (the backend caps history to the last few turns). Pass `attachmentFileIds: string[]` to scope the answer to just those files (the user attached them to the question); when non-empty the backend retrieves only from them, ignoring the global included set (the attach gesture is the consent), and the files are still validated server-side to real vault files.
- Render `RagReference` (`fileId`, `name`, `snippet`, `score`) as the "related files" list.

## What to build
1. **Composer** + a running transcript of turns: each question and its grounded answer is kept so the dialogue accumulates. A **"New chat"** button starts a fresh conversation.
2. Each assistant turn: **answer streamed token-by-token at the top** (rendered as Markdown via `react-markdown` + `remark-gfm` — headings, lists, tables, code, bold, and links that open externally), then a **"Related files"** list of reference cards below (name, snippet, score), appearing as the stream resolves.
3. Realtime feel - show streaming state; let the user ask follow-ups (prior turns are threaded back via `history`).
4. Empty/grounding states: if `includedFileIds()` is empty, prompt the user to include files first (the backend returns a no-grounding answer in that case).
5. **Attach files to a question** - drag a file from the explorer onto the panel, or drop OS files onto it (which `upload`s them into the vault, then attaches the new node ids), to scope the next question and its follow-ups to just those files. Attachments render as removable pills above the composer and clear on **New chat**. Use the shared `@/shell/dnd` helpers (`FILE_DRAG_MIME`, `parseDraggedFiles`) so internal drags stay distinguishable from OS file drops, and pass the attached ids as `attachmentFileIds` to `ask`.
6. **Read answers aloud (on-device TTS)** - a **Read aloud** switch in the header (persisted to `localStorage`) auto-speaks each finished answer, and each answer carries a play/stop button. Use the `@/lib/speech` helpers (`isSpeechSupported`, `speak`, `stopSpeaking`). `speak` first asks `/api/tts` to synthesize the text with the bundled local neural voice (Piper) and plays the returned WAV; when that voice isn't bundled or synthesis fails it falls back to the Web Speech API (`speechSynthesis`) over the OS's installed voices. Either way nothing leaves the machine. Hide both affordances when `isSpeechSupported()` is false. A new question or **New chat** stops any playback.
7. **Converse entry point** - render the shell's `ConversePlaceholder` button in the chat header, immediately left of **New chat**. It only opens a "coming soon" dialog for the future conversational mode (no badge).

## Acceptance criteria
- Streaming renders incrementally (not all-at-once).
- References are clickable affordances that reference real `fileId`s from the store. On the desktop build (`useRagStore().desktop`), clicking a card POSTs the `fileId` to `/api/open` to open the cited file in its native app; on web the cards stay non-interactive (the route refuses). Do not import the explorer.
- The "N sources available" indicator tracks `includedFileIds()` live.
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`. No hardcoded colors.
- Don't import explorer/onboarding internals; coordinate only through `@/contracts` and stores. The only shell pieces you may use are its shared exports: `@/shell/dnd`, `@/shell/theme`, and the `ConversePlaceholder` placeholder rendered in the chat header.
