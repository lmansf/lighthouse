# Design — add-analytics-refinement

## Context

The chat client threads history (user + assistant turns) into every ask, and analytics answers already embed their SQL deterministically in a "Query used" fence. The NDJSON chat stream ends with a final chunk carrying references. `/api/rag` is the established multiplexed op endpoint (mirrored by `rag_op`-style desktop commands), and the guard (`guard_sql`) + executor (`run_query`) are already safe against arbitrary SQL.

## Goals / Non-Goals

**Goals:**
- A refining follow-up reuses the previous query's shape instead of re-deriving it.
- The UI can act on an analytics answer (rerun, edit, later: save/pin) without parsing markdown.
- Direct SQL edits run instantly, guarded, with full provenance — zero model cost.

**Non-Goals:**
- A SQL editor with completion/highlighting (plain textarea; power-user escape hatch).
- Refinement memory beyond the current conversation (no cross-session query store — that's `add-pinned-questions`).
- Chips on non-analytics answers.

## Decisions

1. **Prior query comes from history, not new state.** `last_query_used(history) -> Option<String>` scans backwards for the last assistant turn containing a `*Query used:*` fence and extracts the SQL (capped at 800 chars — the local 6144-token window pays for this block). Rationale: the client already round-trips history; parsing our own deterministic fence needs no storage, works across restarts, and stays correct when the user edits older turns. Injected into `sql_question` as: "Previous query from this conversation (if the question refines it, adapt this SQL instead of starting over): …".
2. **Structured meta rides the existing final chunk.** `ChatChunk` gains `analytics: Option<AnalyticsMeta { sql, file_ids }>` (serde skip-if-none; TS type optional). Alternative — parsing the fence client-side — rejected: markdown is presentation, and the file-id set (which the UI can't reconstruct) is what Save-as-CSV/pins need.
3. **`analyticsSql` op is deterministic re-execution.** Input `{ sql, fileIds }`: resolve ids via `vault::doc_path`, register through the SAME `register_tables` path (groups included), `guard_sql` + `run_query`, return `{ markdown, chart?, footer }` where footer is the standard Query-used + Computed-from block. No model call, no persistence. Errors return `{ error }` with the engine's reason (guard rejection reads exactly like the model-path failure).
4. **Chips are canned follow-ups, not client-side SQL rewrites.** "Top 10" sends "Refine the previous result: only the top 10 rows." through the normal ask; the model + prior-query context handles dialect correctly (client-side SQL surgery would need a parser). "Edit SQL" is the deterministic path via the op.

**Parity:** TS engine takes no analytics branch, so it never emits meta and its `/api/rag` returns a clear `{ error: "analytics runs in the desktop engine" }` for `analyticsSql` (PARITY comment). Contracts/types are shared; chips render only when meta is present, so the web dev twin naturally never shows them.

**Degradation:** no prior fence in history ⇒ prompt unchanged from today. Meta missing ⇒ UI shows no chips. Op failure ⇒ dialog shows the engine error; chat is untouched. Local window: prior-SQL block ≤800 chars and replaces nothing (schema cards already dominate; measured budget stays within the clamps established in the 0.6.1 window fix).

## Risks / Trade-offs

- [Model over-anchors on the previous query for a NEW question] → the instruction says "if the question refines it"; few-shots unchanged; worst case equals a normal wrong-query retry (existing correction round still applies).
- [Edited SQL touches tables from another conversation] → op registers ONLY the given file ids (from the answer's own meta); unknown ids are skipped and reported in the footer.
- [Chip taxonomy grows unbounded] → fixed set of three + Edit SQL; further verbs belong to future spec changes.
