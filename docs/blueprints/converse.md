# Blueprint — Conversation mode ("Converse")

**Status:** shelved (removed from the UI to keep the app lean). It never shipped
as a working feature — it was a "coming soon" teaser gauging demand. That signal
now comes from the mid-session feature-interest vote
(`src/lib/shelvedFeatures.ts`, id `converse`) → the `feature_interest` Supabase
table, replacing the old click-teaser.

## What it was

A "Converse" button in the chat header that opened a *coming-soon* dialog
(GitHub issue #66): the pitch was a free-flowing back-and-forth conversation with
Lighthouse — ask anything and chat back and forth, like an in-browser assistant —
rather than the one-question / one-answer flow. It did nothing yet; its only job
was to register interest.

## How it worked (to rebuild the teaser or the real thing)

- **The teaser** (was `src/shell/ConversePlaceholder.tsx`): a subtle Fluent
  `Button` with `data-log="converse-coming-soon"` / `data-log-type="nav"` so the
  global click-capture (`src/features/usage/useUsageCapture`) logged each press as
  a `click_events` row, plus a friendly "coming soon" `Dialog`. It was rendered in
  the chat header next to "New chat".
- **The real feature (never built):** a conversational loop that keeps the RAG
  grounding but relaxes the strict Q&A framing — multi-turn planning, clarifying
  questions back to the user, and (optionally) voice in/out. It would build on the
  existing chat transcript store (`src/stores/useChatStore.ts`, now persistent) and
  the streaming `chatService.ask` seam.

## To bring it back

- **Teaser:** restore `ConversePlaceholder.tsx` and render it in the chat header;
  the click pipeline still exists.
- **Real feature:** design against `chatService` + the persistent conversation
  store; keep answers grounded (cite `[n]`), and decide the voice story (see the
  read-aloud blueprint for the TTS half and any future speech-to-text).
