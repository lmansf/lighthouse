# Tasks — the Beam loop (budget + cost + approval + manifest)

## 1. Engine-reported token accounting (llm.rs) — do first (§2 and §3 consume it)
- [x] 1.1 Generalize `sse_deltas` (llm.rs:607) to pick a `usage` event alongside text deltas: thread a typed `Usage { input, output }` out of `stream_answer` (llm.rs:184) — change the stream item to `Delta(String) | Usage(Usage)` or add a final out-param; callers still receive text deltas unchanged.
- [x] 1.2 Parse Anthropic default usage (`message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`). Add `stream_options:{include_usage:true}` to the OpenAI-compat + local request bodies (llm.rs:524-529) and parse their usage event.
- [x] 1.3 Accumulate usage per ask across EVERY model call — plan calls, corrective retries, and narration — into one summed `Usage` for the ask.
- [x] 1.4 Fallback: when a provider reports no usage, the accumulated budget stays 0; assert the loop still bounds on max_steps/deadline (never unbounded) and the meter later shows "not reported" (never chars/4).
- [x] 1.5 Twin PARITY: mirror the `Usage` type as unset in `src/server/llm.ts` with a `PARITY:` comment (usage parse is Rust-shipped).
- [x] 1.6 Tests: per-dialect usage-parse unit tests (Anthropic default; OpenAI-compat + local with `include_usage`; a silent provider → 0/unreported).

## 2. The budgeted loop core (beam.rs / analytics.rs — Rust-only; twin unchanged)
- [x] 2.1 Lift the multi-step loop (synth.rs:1020-1210) into a small owned struct parameterized by a `Budget { max_steps (config default ~5–6), deadline (wall-clock), no_progress guard (SQL identical to a prior step / two non-advancing replies), token_ceiling (from §1) }`. Continue while under max_steps AND before the deadline AND no-progress hasn't tripped AND (ceiling unset OR tokens under it). Keep `StepReply::Done` early-stop.
- [x] 2.2 Keep the SINGLE combined plan+decide model call per iteration (no separate reflection turn — doubles cost, worsens the local window).
- [x] 2.3 Kill the hardcoded "3": `step_question` (analytics.rs:4428, "up to 3 SQL queries") reads `max_steps`; the progress label (synth.rs:1033, "of up to 3") reads the budget.
- [x] 2.4 Emit a STRUCTURED per-step progress chunk each iteration — extend `ChatProgress` (contracts.rs:79) or add a step variant — so the cost meter/manifest can attach per iteration.
- [x] 2.5 Preserve narration-over-results and the deterministic footer/ledger exactly (queries used / freshness / assumption ledger / row-cap).
- [x] 2.6 KEEP the `remote_keyed` gate (synth.rs:1020) — do NOT lift onto local; local + extractive keep the single-query path (6144-token window can't carry STEP_RESULT_CAP × N).
- [x] 2.7 `DesktopSettings` (settings.rs:19): add the loop budget field(s) (`max_steps`); extend `settings_test.rs` (struct literal + no-`..` destructuring + wire-key list + positional writer) or CI goes red.

## 3. The cost meter surface (§3)
- [x] 3.1 New `CostMeta` riding the `ChunkMeta` seam (contracts.rs:126) on the final chunk: provider-reported input/output/total tokens summed per ask; dollars = tokens × a shipped per-model price constant, LABELLED "estimated at $X/Mtok"; local ⇒ tokens + $0.00; unreported ⇒ "not reported" (never chars/4).
- [x] 3.2 Cumulative across-asks total surfaced beside the audit record.
- [x] 3.3 Persist `CostMeta` in `CachedAnswer` (answer_cache.rs:61) so a REPLAY reports 0 new tokens / $0 (consistent with `cached_at`), while carrying the original figures as history.
- [x] 3.4 Twin PARITY: byte-identical meter labels in `src/server/synth.ts` (ts-twin.md rule 2).
- [x] 3.5 Tests: summed-across-calls meter; local $0.00; silent provider "not reported"; cache-replay cost = 0 new / $0.

## 4. Two-phase plan approval (§4)
- [x] 4.1 Phase 1: `plan_only: Option<bool>` flag on `chat_ask` (commands.rs, mirroring `bypass_cache`/`persist_allowed`) runs step-1 planning and returns a PLAN chunk — `plan: Option<PlanPreview>` on `ChatChunk` (contracts.rs, beside `analytics`/`draft`/`meta`) carrying the verbatim SQL + the tables it would read — then STOPS (no execution; only the plan-generation call egresses). Threaded `commands.rs` + `routes.rs` → `answer_pipeline`/`live_pipeline` via `beam::PlanCtl`.
- [x] 4.2 Phase 2: on `approved_plan` echoed back on re-issue, EXECUTE that exact SQL as step 1 (seeded via `beam::step_one_plan`) and SKIP re-planning step 1; the guard still runs (`run_query` → `guard_sql`). Applies in both the multi-step loop and the single-query path.
- [x] 4.3 Cache keys on the APPROVED ask, not the plan-only op: `answer_pipeline` bypasses the whole key/lookup/insert path when `plan_only` (`beam::plan_only_bypasses_cache`), leaving the cache unchanged.
- [x] 4.4 Twin PARITY: plan execution is Rust-only (analytics); the twin has no analytics branch and degrades honestly. `PARITY:` comments both sides; `PlanPreview`/`plan` shape mirrored in `types.ts` + `synth.ts` (byte-identical field names `sql`/`tables`/`plan`).
- [x] 4.5 No approval SETTINGS toggle added (both phases are per-ask client params, not a persisted setting) — `settings_test.rs` untouched, as directed.
- [x] 4.6 Tests: plan-only bypasses the cache (pipeline test over the model-free meta path — `plan_only_neither_reads_nor_writes_the_answer_cache`); unit tests for approved-SQL⇒step-1 + skip-replanning flag + `plan_only`⇒bypass + guard-runs-on-approved-SQL (`beam.rs`). The live plan→approve path needs a model and can't run in the no-network container.

## 5. The context manifest (§5)
- [x] 5.1 Per-entry manifest on the final-chunk seam: for each `Ctx`, `{ name, kind (schema-card|query-result|retrieved-chunk|join-hints|chart-options|conversation-note), chars, file_id?, local_only?, score }` — METADATA ONLY, NEVER `Ctx.text` (that would copy private bytes into `CachedAnswer.text`/G6 notes; text stays behind the device-only inspector, inspect.rs). `CtxManifestEntry` (contracts.rs) rides `ChunkMeta.manifest` (the cost-meter seam); `chars` = `Ctx.text.len()` count. Builders `manifest_entry`/`analytics_manifest`/`planning_manifest`/`retrieval_manifest` (synth.rs) populate every assembled context.
- [x] 5.2 Build the manifest AFTER the shareable-subset gate so it is already the gated set (every builder runs over ctxs assembled from `shareable_subset`-filtered candidate ids); pair with the already-emitted `local_only_skip_note` so the disclosure says both what went (the manifest) and what was withheld (the dropped count). A local ask has no gate ⇒ full set listed.
- [x] 5.3 Attribute `retrieved-chunk` entries to files via the already-flowing `references` (`RagReference.file_id`) — map/doc-focus set it directly from the flowing reference; single-shot matches by display name against `references`.
- [x] 5.4 Persist the manifest in `CachedAnswer` — automatic: it rides `ChunkMeta`, which `CachedAnswer.meta` stores; the replay's `..hit.meta` spread re-emits the ORIGINAL manifest (confirmed by `a_cache_replay_shows_the_original_manifest_not_a_blank`).
- [x] 5.5 Twin PARITY: `src/server/synth.ts` builds a `retrievalManifest` for its RAG ctxs with byte-identical kind labels (`retrieved-chunk`/`conversation-note`/`schema-card`); the analytics kinds are Rust-only (PARITY note). Shape mirrored in `types.ts`.
- [x] 5.6 CACHE_VERSION lockstep: bumped 10→11 across native/.../extract.rs, src/server/extract.ts, and the assertion in tests/extract_test.rs (the `ChunkMeta` gained `manifest`, a shared cached-answer wire-shape change), with a v10→11 doc note on each.
- [x] 5.7 Tests: manifest carries metadata only (no `Ctx.text` bytes); a cloud ask lists only the shared subset and the skip note states the withheld count; a chunk entry carries its file_id; a replay shows the original manifest (synth.rs `#[cfg(test)]` unit tests + `answer_cache_test` replay over the model-free meta path).

## 6. Eval floor + verify + parity + gates (§6)
- [x] 6.1 Beam goldens in `examples/analytics_eval.rs` — model-free, deterministic step numbers under the budget (max_steps stop, no-progress halt) so removing narration changes no figure.
- [x] 6.2 Verify: usage-parse unit tests per dialect (from 1.6); cache-replay-cost test (replay = 0 / $0, from 3.5); approval two-phase E2E (from 4.6); manifest-omits-bytes + gated-subset + replay-manifest tests (from 5.7).
- [x] 6.3 Diff the twin literals for the cost-meter labels and manifest kind labels (byte-identical, ts-twin.md rule 2); confirm the Rust-only PARITY comments (§1 usage, §2 loop, §4 plan) on both sides.
- [x] 6.4 Full gates: `cd native && cargo test --workspace`; `npm run test`; `tsc`; lint; `release-smoke`; `analytics_eval` floor (Beam goldens green); `node scripts/openspec-validate.mjs --all`.
