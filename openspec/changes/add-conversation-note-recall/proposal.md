# Cross-conversation recall via note export: past chats become retrievable content

## Why

The passive "From earlier chats" chip row (add-conversation-recall, P2.5) lets a
user REOPEN a related past chat, but it never folds a past answer INTO the
current one. When someone asks "what did I conclude about churn last month?",
the engine has no way to draw on that earlier conclusion — the conversation
lived only in the client's chat store, invisible to retrieval and synthesis.

The fix makes a conversation a first-class, retrievable vault artifact: with
"Save chats on this device" ON, each settled chat is auto-exported as a markdown
note under `Lighthouse Notes/Chats/`, so it is walked, indexed, and retrieved
exactly like any other file. A past conversation can then flow into a new answer
— cited with a chat glyph the user can open — under the SAME grounded, local
trust model every answer holds. This extends the existing `conversation-recall`
capability from "reopen the old chat" to "recall what the old chat concluded";
the passive chip row stays as-is (complementary, not replaced).

## What Changes

- **Source kind on every retrieved chunk (both engines, PARITY).** A new
  `SourceKind { File, Conversation }` rides on `RagReference` (and, internally,
  on the synth `Context`). Classification is deterministic and path-based —
  `source_kind_of(id)` returns `Conversation` iff the node id sits under
  `Lighthouse Notes/Chats/`. `#[serde(default)]`/optional so older payloads read
  as `File`. It rides the existing ask wire with no route change.
- **Conversation-aware synthesis label (both engines, byte-identical).** When a
  retrieved context is a conversation note, the block the model reads is
  relabeled "from your past Lighthouse conversation", so the model knows it is
  the user's OWN earlier chat rather than a source document.
- **Recall meta-cue biases retrieval (both engines, byte-identical).** A pure,
  anchored `recall_cue` ("what did I ask/conclude/decide/find about X", "did I
  ask …") scales conversation-kind candidates by a constant boost before ranking,
  lifting past chats into the top-k. It NEVER short-circuits to a model-free
  answer — full synthesis still runs.
- **Idempotent conversation-note export (both engines).** `write_conversation_note`
  overwrites in place at a stable, per-conversation path (`"<title> [<cid8>].md"`,
  keyed by a hash of the conversation id, old-title note removed on rename), so
  the vault keeps exactly ONE current note per chat instead of a growing pile.
  New ops `exportConversationNote` / `purgeConversationNotes` in all three
  transports (desktop IPC, dev server, web route).
- **Auto-export on turn settle (client).** When "Save chats on this device" is
  ON, the settled conversation is exported fire-and-forget as YAML frontmatter
  (date, title, provider, cited file ids) + the existing transcript markdown.
- **Chat glyph on conversation cites (client).** A reference whose `kind` is
  `conversation` renders a chat glyph (not a document) and opens the note.
- **Fail closed.** ZERO notes are written while history is off or managed-locked
  (the single `persistEnabled` gate, already false under the `chatHistory`
  policy). Opting out PURGES `Lighthouse Notes/Chats/`, so nothing of the user's
  conversations survives on disk.

## Capabilities

### Modified Capabilities
- `conversation-recall`: extended from the passive same-session chip row to
  making past conversations retrievable content — auto-exported as indexed notes,
  labeled as conversations in synthesis, biased in by a recall cue, cited with a
  chat glyph, and fully fail-closed on the history opt-out.

## Impact

- Rust engine (`lighthouse-core`): `contracts.rs` (`SourceKind` + `kind` on
  `RagReference`), `vault.rs` (`source_kind_of`, `CHATS_SUBDIR`,
  `write_conversation_note`, `purge_conversation_notes`, `kind` on `Context` +
  the retrieve construction sites, recall-cue boost), `synth.rs` (`recall_cue`,
  `CONV_BOOST`, `ctx_label` + relabel at the three context→prompt sites, `kind`
  set at every reference site), `meta.rs` (`kind` on its references). Rust tests
  for `source_kind_of`, `recall_cue`, `ctx_label`, and note upsert/purge.
- TS twin (`src/server`): `vault.ts` (`sourceKindOf`, `CHATS_SUBDIR`, `recallCue`,
  `CONV_BOOST`, `writeConversationNote`, `purgeConversationNotes`, `kind` on
  contexts/references + the boost), `synth.ts` (`ctxLabel` + relabel).
  `app/api/rag/route.ts` (both ops). `test/recallCue.test.mjs` byte-parity.
- Contracts + UI: `types.ts` (`RagReference.kind`), `services.ts`/`real`/`mock`
  (two ops), `ChatPanel.tsx` (auto-export hook + frontmatter + chat glyph),
  `LicenseGate.tsx` (opt-out purge).
- Desktop crate (CI-only): `commands.rs` two IPC ops. No shared-signature change
  forces other desktop edits (the new fields are additive; the desktop never
  constructs `RagReference`/`Context`).
- No `CACHE_VERSION` bump (extraction untouched; source kind is path-based, the
  note's frontmatter is indexed as ordinary markdown).

## Non-goals

- **No new prompt injection beyond ordinary retrieval.** A conversation note is
  retrieved and synthesized like any file; it earns its place by relevance (plus
  the recall-cue bias), not by being force-fed.
- **No cross-device sync.** Notes are local vault files, nothing more.
- **The recall cue never yields a model-free answer.** It only shapes retrieval;
  full grounded synthesis still runs (unlike the `meta` cues).
- **The passive P2.5 chip row is not removed.** Reopening a chat and folding a
  chat in are complementary; retiring the chip row, if ever wanted, is a
  separate change.
- **No frontmatter-stripping extraction.** The tiny YAML block is indexed as
  plain text; stripping it would force a lockstep `CACHE_VERSION` bump for no
  real gain, so it is out of scope.
- **No new settings field.** The gate is the existing client `persistEnabled` +
  the `chatHistory` managed policy — nothing is added to `DesktopSettings`.
