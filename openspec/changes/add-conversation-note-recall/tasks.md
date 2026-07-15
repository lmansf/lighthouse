# Tasks — cross-conversation recall via note export

## 1. Source kind (both engines, PARITY)
- [x] 1.1 `SourceKind { File, Conversation }` enum on `RagReference` (contracts.rs,
  serde default) + optional `kind` on the TS `RagReference` (types.ts).
- [x] 1.2 `source_kind_of` + `CHATS_SUBDIR` (vault.rs); `sourceKindOf` /
  `CHATS_SUBDIR` (vault.ts) — path-based, trailing-slash-exact.
- [x] 1.3 `kind` on the synth `Context` (vault.rs) / retrieved contexts (vault.ts);
  set at every `RagReference`/`Context` construction site (retrieve, build_listing,
  synth analytics/map/doc-focus, meta) — File except conversation notes.

## 2. Synthesis label (both engines, byte-identical)
- [x] 2.1 `ctx_label` (synth.rs) / `ctxLabel` (synth.ts): "from your past Lighthouse
  conversation" for conversation contexts, else the file name.
- [x] 2.2 Apply at the three context→prompt sites (single-shot, map, doc-focus).

## 3. Recall cue + boost (both engines, byte-identical)
- [x] 3.1 `recall_cue` + `CONV_BOOST` (Rust: synth.rs; TS: vault.ts to avoid a
  synth↔vault cycle) — anchored frames, `cross_doc_cue` normalization.
- [x] 3.2 Apply the boost inside `retrieve` before the sort (both engines).

## 4. Idempotent note write + ops (both engines)
- [x] 4.1 `write_conversation_note` / `writeConversationNote`: stable
  `"<title> [<cid8>].md"` (SHA-1 of conversation id), truncating overwrite,
  old-title orphan removal, `safe_abs` guard.
- [x] 4.2 `purge_conversation_notes` / `purgeConversationNotes`: remove `Chats/`.
- [x] 4.3 Ops `exportConversationNote` + `purgeConversationNotes` in routes.rs,
  commands.rs (CI-only), and app/api/rag/route.ts.

## 5. Contracts + UI
- [x] 5.1 `services.ts` + `rag.real.ts` + `rag.mock.ts`: the two new methods.
- [x] 5.2 `ChatPanel.tsx`: auto-export hook in the turn-settle finally (gated on
  `persistEnabled`), YAML frontmatter builder + transcript, in-flight guard.
- [x] 5.3 `ChatPanel.tsx`: chat glyph + "Open past conversation note" title on a
  `kind === "conversation"` reference.
- [x] 5.4 `LicenseGate.tsx`: opt-out purge on the "Save chats" toggle.

## 6. Tests
- [x] 6.1 Rust: `recall_cue`, `source_kind_of`, `ctx_label` (synth.rs);
  `write_conversation_note` upsert/orphan/escape + `purge` idempotency (vault_test.rs).
- [x] 6.2 Node: `recallCue` + `sourceKindOf` byte-parity (recallCue.test.mjs).

## 7. Gates
- [x] 7.1 `cargo test -p lighthouse-core -p lighthouse-server` green.
- [x] 7.2 `tsc --noEmit` + `next lint` + `node --test test/*.test.mjs` green.
- [x] 7.3 No `CACHE_VERSION` change; no new settings field (settings tripwire
  unaffected).
- [x] 7.4 `node scripts/openspec-validate.mjs add-conversation-note-recall` green.
- [ ] 7.5 CI-only: desktop-release builds the two commands.rs ops; release-smoke
  grounded-ask wire tolerates the added `kind` field; auto-export + chat glyph
  visually verified.
