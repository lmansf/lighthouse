# Conversational analytics refinement

## Why

Every analytics ask writes SQL from scratch — the model never sees its previous query, so "same thing but monthly" or "now exclude cancelled" restarts instead of editing one clause. Analysts iterate; today each iteration costs a cold ask and often re-derives the wrong query.

## What Changes

- The SQL-writing prompt includes the **previous query** from this conversation (parsed from the last assistant turn's "Query used" fence) with an instruction to adapt it when the user is refining.
- The final chat chunk of an analytics answer carries structured **analytics metadata** (`sql`, the file ids it read) so the UI can act on the answer — this is also the foundation `add-answer-artifacts` (Save as CSV) and `add-pinned-questions` build on.
- **Quick-action chips** under analytics answers (Top 10 · Monthly · As % · Edit SQL). The first three send canned refinement follow-ups through the normal ask path; **Edit SQL** opens the exact query in a dialog and re-runs a user-edited version through the existing guard via a new engine op — no model, instant.
- New `analyticsSql` op on `/api/rag`: registers the answer's files and runs one guarded SELECT, returning the result table, optional chart spec, and the provenance footer.

## Capabilities

### New Capabilities
- `analytics-refinement`: refining a previous analytics answer conversationally, via chips, or by editing the SQL directly.

### Modified Capabilities
<!-- none -->

## Impact

- `native/crates/lighthouse-core/src/analytics.rs` (prior-query extraction, refinement prompt line), `synth.rs` (meta on final chunk), `contracts.rs` (+ `AnalyticsMeta`), `lighthouse-server/src/routes.rs` + `lighthouse-desktop/src/commands.rs` (`analyticsSql` op).
- `src/contracts` (ChatChunk type + rag service op), `src/features/chat/ChatPanel.tsx` (chips + Edit SQL dialog), `src/lib/chartSpec.ts` untouched.
- TS twin: type-level only (the TS engine never emits analytics metadata — PARITY).
