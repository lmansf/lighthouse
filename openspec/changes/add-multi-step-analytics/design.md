# Design — add-multi-step-analytics

## Context

The analytics branch is: schema cards → model writes ONE SELECT → guard → execute → (one error-retry) → narrate with the verified result. `run_query` already caps rows/time; `collect(llm::stream_answer(...))` is the established non-streamed model call for the SQL phase. Remote providers are now first-class (six vendors, per-provider keys).

## Goals / Non-Goals

**Goals:**
- Comparison/why questions get 2–3 targeted queries, each verified, then one grounded narration.
- Hard bounds: ≤3 steps, existing per-query caps, graceful landing at every failure point.
- Local-model behavior is byte-identical to today.

**Non-Goals:**
- Parallel step execution, data transformations outside SQL, or model-visible raw tables.
- Multi-step on the local model (window math forbids it).
- Exposing a visible "plan" artifact — steps are progress lines + footer entries, not a new UI.

## Decisions

1. **Secondary cue gates entry.** `multi_step_cue(q)`: analytics cue AND any of `compare|versus|vs|difference|why|driver|drivers|explain|what caused|change between|breakdown of the change`. Word-boundary matching like `analytics_cue`; unit-tested positive/negative table. Single-cue questions keep the single-query path even on remote models — multi-step costs latency and should be earned.
2. **Iterative ask, not upfront plan.** Each round the model sees: schema cards (+ join hints), the original question, and prior steps as `Step N SQL / result (narration-capped)`, and must reply either `NEXT_SQL:` + one SELECT or `DONE`. `parse_step_reply(raw) -> StepReply::{Sql,Done}` tolerates fences/prose (reuses `extract_sql`; an unparseable reply = DONE). Rationale vs upfront JSON plan: later queries legitimately depend on earlier results ("Q4 dropped — now break Q4 by region"), and per-step replies reuse the existing extract/guard machinery unchanged.
3. **Loop bounds and landings.** Max 3 executed steps; per-step one guard/execution failure is FED BACK once (same correction pattern as today) and a second failure ends the loop. Zero successful steps ⇒ fall through to the existing single-query path (which retains its own retry); ≥1 success ⇒ narrate what was collected. Every executed query joins the footer: `*Queries used (2):*` with numbered fences; the freshness stamp renders once over the union of files.
4. **Budgets.** Steps' results are capped with the existing narration clamps; the step prompt totals ≤ ~8k chars — comfortably inside every remote window; gating (`provider != "local"` with a key) is checked once at branch entry.

**Parity:** Rust-only (analytics has no TS twin — documented divergence). No contracts change: the final chunk's `analytics` meta (from add-analytics-refinement) carries the LAST step's SQL — the one refinement chips act on — while the footer shows all.

**Degradation:** the chain of landings above means the worst outcome equals today's behavior; any panic-free failure ends in either the single-query path or a narration over fewer steps.

## Risks / Trade-offs

- [Model loops asking redundant queries] → hard 3-step cap + DONE-on-unparseable; progress lines make cost visible.
- [Latency: up to 3 model calls + narration] → remote-only gating (fast providers), progress streaming keeps perceived latency honest; single-cue questions never enter.
- [Footer bloat] → numbered compact fences; chips bind to the last query only.
