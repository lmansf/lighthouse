# Tasks — add-multi-step-analytics

## 1. Engine

- [x] 1.1 `multi_step_cue(q)` in analytics.rs (analytics cue AND comparison/why cue, word-boundary) + positive/negative unit table
- [x] 1.2 `parse_step_reply(raw) -> StepReply { Sql(String) | Done }` reusing extract_sql; unparseable ⇒ Done; unit tests (NEXT_SQL fenced, bare SELECT, DONE, prose)
- [x] 1.3 `step_question(original, steps_so_far)` prompt builder (schema cards ride as contexts; steps as capped SQL+result blocks) + budget unit test (≤ ~8k chars at 3 steps)
- [x] 1.4 synth.rs: gated loop (remote+key only) — ≤3 steps, per-step one corrective retry, zero-success fall-through to the single-query branch, ≥1-success narration with all step results as context blocks
- [x] 1.5 Footer: "Queries used (N)" numbered fences + single freshness line over the union of files; analytics meta carries the last SQL; progress chunks per step

## 2. Verification

- [x] 2.1 Unit tests green (cues, parser, prompt budget); cargo + node tests, tsc, lint
- [x] 2.2 Live check with a keyed remote provider: comparison question over seeded quarters executes ≥2 queries with a numbered footer; same question on local runs single-query
