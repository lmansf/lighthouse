# Design — cross-conversation recall via note export

## Non-Goals (pinned)

1. No prompt injection beyond ordinary retrieval — a conversation note earns
   top-k by relevance (+ the recall-cue bias), never force-feeding.
2. No cross-device sync — notes are local vault files.
3. The recall cue only shapes retrieval; it never short-circuits to a model-free
   answer (contrast the `meta` cues, which do).
4. The passive P2.5 "From earlier chats" chip row stays.
5. No frontmatter-stripping extraction, hence NO `CACHE_VERSION` bump.
6. No new settings field — the gate is the existing `persistEnabled` +
   `chatHistory` managed policy.

## The load-bearing constraints

### C1 — "Answers stay grounded and local" ⇒ a conversation is just another file
A conversation note is an ordinary markdown vault file. It flows through the
SAME walk → index → retrieve → synthesize path as any document, so it inherits
inclusion rules, the named-file guarantee, the token budget, and the local/
provider provenance line unchanged. G6 adds only a source-KIND dimension
(cosmetic label + retrieval bias); it changes no answer that didn't already
retrieve a conversation note.

### C2 — Byte-identical twins ⇒ shared classifier, cue, label, boost
`source_kind_of`, `recall_cue`, `ctx_label`, and `CONV_BOOST` are mirrored
Rust↔TS. `recall_cue` normalizes exactly like `cross_doc_cue` and matches the
same anchored frame list; `ctx_label` emits the identical "from your past
Lighthouse conversation" string; the boost constant is identical. A Node test
(`recallCue.test.mjs`) asserts `recallCue`/`sourceKindOf` against the Rust cases.

## Decisions

### D1 — Path-based source kind, not a stored flag
The node id IS the vault-relative path, so `id.starts_with("Lighthouse Notes/
Chats/")` is an exact, deterministic classifier needing no new persisted state
and no extraction change. The trailing slash is required (`Chats/`, not
`Chatsz`). Defaults to `File` so any payload without the field is safe.

### D2 — Idempotent write keyed by conversation id, human-scannable name
`write_conversation_note` names the file `"<sanitized-title> [<cid8>].md"`, where
`cid8` is the first 8 hex of SHA-1(conversationId) — stable across title edits
and collision-resistant, while the title keeps the file readable in the explorer.
The write TRUNCATES in place (not `add_file`'s collision-suffix), and any earlier
note for the SAME conversation under a changed title is removed first, so the
vault holds exactly one current note per chat. Same sanitize + `safe_abs` guard
as the artifact writers; a crafted title cannot escape `Chats/`.

### D3 — Recall cue biases inside `retrieve`, so both engines and both passes get it
`recall_cue(query)` is computed once inside `vault::retrieve`; conversation-kind
candidates are multiplied by `CONV_BOOST` just before the sort. Because it lives
in `retrieve` (no signature change), every caller — the initial k and the wide
pass — benefits automatically and parity is free. It only scales EXISTING
candidates; it never invents one or asks the model to rank.

### D4 — Synthesis label is the only prompt change
`ctx_label` rewrites a conversation context's block header to "from your past
Lighthouse conversation" at the three context→`Ctx` sites (single-shot, map,
doc-focus). No date is added to the label — the note's YAML frontmatter (which
carries the date) is already in the retrieved chunk text, so the model has the
date regardless, and keeping the label date-free avoids an mtime lookup on the
hot path. The label is a few tokens, so the 6144-token local window is
unaffected.

### D5 — Auto-export on turn settle, fail-closed, fire-and-forget
The client exports in the turn-settle `finally`, AFTER `persistMessages()` and
gated on the SAME `persistEnabled` flag (already false under the `chatHistory`
policy). It builds YAML frontmatter (date, title, provider, cited file ids, each
double-quoted so a colon/quote stays valid YAML) + the existing
`transcriptMarkdown`. An in-flight ref prevents overlapping writes for a chat;
failures are swallowed (background convenience, never a blocker). It requires at
least one real assistant answer before writing.

### D6 — Opt-out purges, closing the fail-closed loop
Turning "Save chats on this device" OFF calls `purgeConversationNotes`, deleting
the whole `Chats/` folder — so opting out leaves none of the user's chats on
disk, matching the existing "clears everything already on disk" behavior of the
history toggle.

### D7 — TS placement divergence (documented)
In Rust, `recall_cue`/`CONV_BOOST` live in `synth.rs` (beside `cross_doc_cue`)
and `vault.rs` calls them. In TS, `synth.ts` imports from `vault.ts` (one-way),
so `recallCue`/`CONV_BOOST` live in `vault.ts` to avoid a synth↔vault import
cycle. BEHAVIOR is byte-identical; only the file home differs, noted in PARITY
comments.

## Degradation

- Export failure (read-only vault, IO error) ⇒ swallowed; the chat still works.
- A conversation with no real answer yet ⇒ no note written.
- Unknown/missing `kind` on the wire ⇒ treated as `File` (glyph = document).
- A conversation note that is excluded or trashed ⇒ simply not retrieved, like
  any file. The recall cue then finds nothing to boost and synthesis is normal.
- Notes are ordinary files: the 2-week auto-clear of chat history does not delete
  them, but the opt-out purge does — documented so the user knows they persist as
  vault files until they opt out or delete them.

## Test plan

- Rust (`synth.rs`): `recall_cue` triggers/does-not; `source_kind_of` exactness
  (trailing-slash sensitivity); `ctx_label` conversation-vs-file. (`vault_test.rs`):
  `write_conversation_note` upsert (same id on re-write, orphan removal on title
  change, distinct id per conversation, escape-safety) and `purge` idempotency.
- Node (`recallCue.test.mjs`): `recallCue` + `sourceKindOf` byte-parity with Rust.
- `cargo test -p lighthouse-core -p lighthouse-server`, `tsc --noEmit`,
  `next lint`, `node --test test/*.test.mjs` all green.
- `node scripts/openspec-validate.mjs add-conversation-note-recall` green.
- CI-only (`desktop-release.yml` / `release-smoke.yml`): the desktop crate builds
  the two new `commands.rs` ops; the grounded-ask wire test exercises
  `RagReference` with the added `kind` field (back-compat on the shipped binary);
  the auto-export hook + chat glyph are DOM/OS — manual/visual QA.
