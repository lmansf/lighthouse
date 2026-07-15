# Tasks — chart directive

## 1. Engine: directive core (Rust-only, analytics.rs)
- [ ] 1.1 Directive struct + parser (`lighthouse-chart-request` fence, first block wins, only the five fields read) + validator against batch schema (column existence, numeric series, ≤3 series, capped/sanitized title, sort whitelist).
- [ ] 1.2 Directed variant of `chart_spec_from_batches` (label/series/sort/title as parameters; data read from batches exactly as the heuristic does); optional `title` on the emitted spec only when directed.
- [ ] 1.3 Heuristic improvements behind golden fixtures: year-range gate in `looks_temporal`, integral-float categorical keys stay bar, id-named label columns decline — with `default_chart_outputs_are_byte_locked` and every existing kind fixture untouched.
- [ ] 1.4 Unit tests: validator (unknown column, 4+ series, malformed JSON, fabricated `x`/`values` ignored, "none", title cap), directed emitter (numbers byte-identical to batches), heuristic-fallback equivalence.

## 2. Engine: chart card + narration wiring (analytics.rs + synth.rs)
- [ ] 2.1 `CHART_CARD_VERSION` + card builder interpolating the actual result columns; snapshot test pins the full text; `chart_card_stays_inside_budget` (~200 tokens) in the style of `step_prompt_stays_inside_budget`.
- [ ] 2.2 `every_chart_card_example_validates` — each few-shot example accepted by the validator against its example table (copies the `every_fewshot_example_passes_the_guard` pattern).
- [ ] 2.3 Inject the card as a narration `Ctx` (join-hints mechanism, synth.rs:605-614) only when analytics ran, result untruncated, shape chartable.
- [ ] 2.4 Stream-scan the narration for the fence: withhold fence bytes from forwarded deltas; on completion parse → validate → emit the directed spec, the heuristic fallback, or nothing ("none"); truncated results still never chart.
- [ ] 2.5 Extend the SYSTEM_PROMPT chart lines (llm.rs:146 ⇄ llm.ts:217-219, byte-identical): reference a chart only when requesting one.

## 3. Shared parsing + UI (PARITY)
- [ ] 3.1 `chartSpec.ts`: `parseChartDirective` + `validateDirective(cols)` mirroring the Rust rules (`PARITY:` both sides); optional `title?` accepted by `parseChartSpec`, rendered by `AnalyticsChart`.
- [ ] 3.2 Strip `lighthouse-chart-request` fences from displayed prose in ChatPanel (new) and WidgetBar (generalize the existing regex).
- [ ] 3.3 Node tests: directive parse/validate fixtures shared with Rust; title render; existing chartSpec tests unchanged.

## 4. Quality floor
- [ ] 4.1 Golden misfire fixtures (date-ish labels, top-N, single-value, 4-digit id columns) asserting expected kind-or-none + columns, heuristic and directed paths.
- [ ] 4.2 `examples/chart_eval.rs` scorecard (model-free floor, exit(1) on violation; opt-in provider NL section like `analytics_eval.rs`).
- [ ] 4.3 Wire the analytics eval floor + chart floor as CI steps in `native.yml` (model-free sections only).

## 5. Verify
- [ ] 5.1 Full verification: `cd native && cargo test --workspace` (or -p core/server in-container), `npm run test`, `tsc --noEmit`, `next lint`; both floors green; E2E — valid directive charts, invalid falls back, "none" suppresses, numbers byte-identical to the result table.
