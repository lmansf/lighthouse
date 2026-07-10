# Tasks — add-analytics-refinement

## 1. Engine

- [ ] 1.1 `last_query_used(history) -> Option<String>` in analytics.rs (backward scan for the deterministic fence, 800-char cap) + unit tests (present, absent, multiple answers → last, cap)
- [ ] 1.2 Thread it into `sql_question` as the adapt-if-refining block; synth.rs passes history through
- [ ] 1.3 `AnalyticsMeta { sql, file_ids }` on ChatChunk (contracts.rs, serde skip-if-none); synth.rs sets it on the analytics final chunk (group members flatten into file_ids)
- [ ] 1.4 `analytics::run_direct(sql, file_ids) -> Result<DirectResult, String>` reusing register_tables + guard + run_query + footer rendering; unit test over temp CSVs (result, guard rejection, unknown id skipped)
- [ ] 1.5 `analyticsSql` op in lighthouse-server routes.rs and lighthouse-desktop commands.rs returning { markdown, chart?, footer } | { error }

## 2. Contracts + UI

- [ ] 2.1 TS ChatChunk type gains optional `analytics`; rag service + real/mock impls gain `analyticsSql`; TS /api/rag returns PARITY error for the op
- [ ] 2.2 ChatPanel: chip row under messages with meta (Top 10 / Monthly / As % send canned follow-ups; disabled while streaming)
- [ ] 2.3 Edit SQL dialog: textarea prefilled from meta.sql, Run → analyticsSql, render markdown table + chart + footer inline, error state
- [ ] 2.4 Widget untouched (chips are main-window only; meta ignored there)

## 3. Verification

- [ ] 3.1 cargo + node tests, tsc, lint; live check: seed vault, ask aggregate → refine "only top 5" → verify adapted SQL in footer; Edit SQL round-trip
