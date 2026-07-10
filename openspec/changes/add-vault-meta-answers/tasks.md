# Tasks — add-vault-meta-answers

## 1. Engine (Rust)

- [ ] 1.1 New meta.rs: `MetaIntent` + anchored `meta_intent(question)` with positive/negative unit table (incl. "what's new in <doc>" negative)
- [ ] 1.2 Renderers: whats_new (walk mtime desc + saved_age_label), list_files (counts by kind), find_column (catalog scan) — each returns full markdown + references or Err
- [ ] 1.3 synth.rs: meta stage after missing-file note, before analytics; Err ⇒ fall through silently; unit test the fall-through
- [ ] 1.4 `suggested_asks()` from catalog (newest ≤3 tabular included files; templates per design; ≤4, deduped) + unit tests over temp files
- [ ] 1.5 `suggestedAsks` op in routes.rs + commands.rs → { asks: [{label, question}] }

## 2. TS twin

- [ ] 2.1 New src/server/meta.ts mirroring meta_intent + whats_new/list_files (KEEP IN SYNC); find_column falls through (PARITY comment); wire into synth.ts at the same stage; node tests mirror the Rust cue table
- [ ] 2.2 /api/rag `suggestedAsks` returns { asks: [] } with PARITY comment

## 3. UI

- [ ] 3.1 Rag service + real/mock `suggestedAsks`; ChatPanel empty state fetches once and renders chips (fallback: existing static hint); tap submits the question

## 4. Verification

- [ ] 4.1 cargo + node tests, tsc, lint; live check: "what's new this week?" instant + cited; suggestion chip round-trips to a computed answer
