# Design — add-vault-meta-answers

## Context

The synthesis pipeline (both engines) currently goes: missing-file note → analytics branch → synthesis/single-shot. Walk metadata (name, kind, mtime, included flag) is cheap and already powers the explorer; the Rust engine additionally gains the column catalog from `add-tabular-scale`. The chat empty state is a static hint today.

## Goals / Non-Goals

**Goals:**
- Sub-second answers for vault questions, zero model tokens, correct references.
- False positives ~never: a question that merely *mentions* files still gets the full pipeline.
- Suggested asks are guaranteed answerable (they name real columns from real included files).

**Non-Goals:**
- Natural-language filtering beyond the fixed cue set (no "files Bob sent me").
- Content summaries in meta-answers (that's retrieval's job).
- Suggestion ranking experiments (ship a fixed heuristic; A/B later if wanted).

## Decisions

1. **Cues are anchored phrase patterns, not keywords.** `meta.rs::meta_intent(question) -> Option<MetaIntent>` with intents: `WhatsNew { since }` ("what's new / what changed" + optional "today|this week|since …"), `ListFiles { kind }` ("what/which files|spreadsheets|documents|pdfs do I have", "list my …"), `FindColumn { name }` ("which files have a column …", "who has <col> column"). Anchoring (question must START with the interrogative frame after trimming) keeps "what's new in the Q3 report?" OUT of meta (it names a document → full pipeline). Unit-tested against a positive/negative table in both engines.
2. **Renderers are markdown + real references.** WhatsNew: ≤15 included files by mtime desc with saved-age labels (reuse `saved_age_label`). ListFiles: counts by kind + ≤10 notable names. FindColumn (Rust only): catalog scan, files listing the matching column with its kind. Each answer streams as one delta + final chunk with references to the named files — the citation contract holds.
3. **Placement: before the analytics branch, after the missing-file note.** Meta questions are never aggregate questions; running first avoids wasted table registration. A `None` intent costs one regex pass.
4. **Suggested asks derive from the catalog, newest files first.** For ≤3 recent included tabular files: pick a numeric column N and categorical column C (text kind, not a date) → "Total N by C in <file>"; a date column D ⇒ "Monthly trend of N in <file>"; always ≤4 suggestions, deduped by template. Op `suggestedAsks` on `/api/rag` returns `{ asks: [{ label, question }] }`. Empty when no tabular files are included — the UI falls back to today's static hint.

**Parity:** `meta.ts` mirrors WhatsNew/ListFiles (walk metadata exists in the TS twin); `FindColumn` and `suggestedAsks` return none/empty in TS with PARITY comments (catalog is Rust-only). KEEP IN SYNC headers on the cue tables.

**Degradation:** any meta renderer error falls through to the normal pipeline (wrap in a `try`/`Result`, never yield partial meta output before knowing it renders). Local window unaffected (no model). Suggested-ask op failure ⇒ UI keeps static empty state.

## Risks / Trade-offs

- [Cue misfire steals a content question] → anchored patterns + document-name guard; negative-table tests pin the borderline cases; worst case the user rephrases (and every misfire is a one-line cue fix).
- [Suggested ask references a column the model then mangles] → suggestions run through the normal ask path like any typed question; they're phrased exactly like the few-shot idioms so the SQL path is on rails.
- [Catalog cold on first launch] → suggestions simply arrive on the next empty-state render after the catalog warms; no spinner.
