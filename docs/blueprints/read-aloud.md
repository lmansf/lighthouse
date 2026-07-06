# Blueprint — Read aloud (text-to-speech)

**Status:** shelved (removed from the UI to keep the app lean). Demand is gauged
by the mid-session feature-interest vote (`src/lib/shelvedFeatures.ts`, id
`read-aloud`) → the `feature_interest` Supabase table.

## What it was

A per-answer "read this aloud" control plus a "Read aloud" switch in the chat
header that auto-spoke each new answer. On-device text-to-speech — nothing left
the machine.

## How it worked (to rebuild)

- **Client speech lib** (was `src/lib/speech.ts`): thin wrapper over the browser
  Web Speech API (`window.speechSynthesis` + `SpeechSynthesisUtterance`) with
  `isSpeechSupported()`, `speak(text, onEnd)`, and `stopSpeaking()`. On the
  desktop webview where Web Speech voices are absent, it fell back to a bundled
  **Piper** voice via the server/native TTS route.
- **Backend TTS** (still present — can be pruned or reused): `POST /api/tts`
  synthesizes with Piper.
  - TS: `src/server/tts.ts` (+ the `app/api/tts` route).
  - Native: `native/crates/lighthouse-core/src/tts.rs` (spawns Piper per request)
    and its desktop command wiring.
- **Chat UI wiring** (was in `src/features/chat/ChatPanel.tsx`): a `readAloud`
  preference (persisted under `lighthouse.chat.readAloud`), a `speakingId` for the
  currently-playing answer, a `readAloudRef` so the streaming closure saw the
  latest toggle, auto-speak of the finished answer when the pref was on, a
  per-answer speaker button, and cleanup that called `stopSpeaking()` on unmount /
  new question / new chat.

## To bring it back

1. Restore `src/lib/speech.ts` (Web Speech + Piper fallback).
2. Re-add the header switch + per-answer speaker button + the `readAloud`/
   `speakingId` state and auto-speak in `ChatPanel`.
3. The TTS backend route already exists (or restore it from history if pruned).

The removal commit is the reference diff; `git log -- src/lib/speech.ts` finds it.
