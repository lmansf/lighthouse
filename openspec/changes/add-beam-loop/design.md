# add-beam-loop — design

## The headline constraint: the ask is one-shot and unidirectional

`chat_ask` (`native/crates/lighthouse-desktop/src/commands.rs:887`) takes all
input up front and streams `ChatChunk`s out through a one-way
`Channel<ChatChunk>` (:902). The engine body is an `async_stream!` generator
(`synth.rs:481`/`:596`) with NO handle to receive a client signal mid-flight.
There is therefore no way to pause the stream and wait for the analyst to
approve a plan. **Plan approval must be two-phase** — see below. Everything
else in this change budgets and instruments the loop that already exists.

## The loop that already exists

`synth.rs:1020-1210` is the multi-step executor. The
`remote_keyed && multi_step_cue` gate (:1020) admits it; `'steps: while
steps.len() < 3` (:1031) bounds it by a bare count; each iteration plans via
`stream_answer(step_question(...))` → `parse_step_reply` → `StepReply::Done`
breaks or `Sql` executes through `run_query` (guarded) with one corrective
retry (:1046-1088); narration reads per-step RESULT MARKDOWN, never raw row
batches (:1092-1106); a deterministic footer (queries used / freshness /
assumption ledger / row-cap) rides the answer text. The "3" is also hardcoded
in the step prompt (`analytics.rs:4428` `step_question`) and the progress
label (`synth.rs:1033`). This change replaces the count with a budget and adds
four instrumentation seams; it does not rewrite the cycle.

## §1 — Engine-reported token accounting (foundation; §2/§3 consume it)

`sse_deltas` (`llm.rs:607`) currently discards every non-text SSE event via
`pick_delta`. Generalize it to also pick a `usage` event and thread a typed
`Usage { input, output }` out of `stream_answer`. `AnswerStream`/`DeltaStream`
are `Stream<Item = String>` today (`llm.rs:181`/`:604`); the item becomes an
enum (`Delta(String) | Usage(Usage)`) or `stream_answer` gains a final
out-param — either way callers keep receiving text deltas and additionally see
a typed usage total.

- **Anthropic** streams usage BY DEFAULT — `message_start.message.usage
  .input_tokens` + `message_delta.usage.output_tokens`. Parse both.
- **OpenAI-compat + local** need `stream_options:{include_usage:true}` added to
  the request body (`llm.rs:524-529` builds it). Local llama reports tokens (and
  $0 — loopback is not egress).
- **Accumulate per ask** across EVERY model call: plan calls, corrective
  retries, and the final narration.
- **Fallback:** if a vendor ignores `include_usage` and reports nothing, the
  accumulated token budget stays 0. The loop MUST then bound on
  `max_steps`/deadline and never run unbounded (see §2). The cost meter shows
  "not reported" (see §3) — never a `chars/4` estimate.
- **PARITY:** usage parse is Rust-shipped; the twin mirrors the type as unset
  with a `PARITY:` comment (ts-twin.md rule 3).

## §2 — The budgeted loop core

Lift the loop (`synth.rs:1020-1210`) into a small owned struct — `beam.rs` (new)
or `analytics.rs` — parameterized by a BUDGET, not a count:

```
Budget {
  max_steps:  usize,              // config default ~5–6 (was the literal 3)
  deadline:   Instant,            // wall-clock stop
  no_progress: guard,             // SQL identical to a prior step, OR two
                                  //   consecutive non-advancing replies
  token_ceiling: Option<u64>,     // from §1; None/0 when usage unreported
}
```

- The loop continues while `steps.len() < budget.max_steps` AND
  `Instant::now() < budget.deadline` AND the no-progress guard has not tripped
  AND (the token ceiling is unset OR accumulated tokens are under it). Early
  stop on `StepReply::Done` is unchanged.
- **Single combined plan+decide call per iteration** — no separate reflection
  turn (that doubles cost and worsens the local window). The existing
  `step_question` prompt already asks the model to either emit the next SQL or
  say DONE in one call; keep that.
- Kill the hardcoded "3": `step_question` (`analytics.rs:4428`, "up to 3 SQL
  queries") reads `max_steps`; the progress label (`synth.rs:1033`, "of up to
  3") reads the budget.
- Emit a STRUCTURED per-step progress chunk each iteration — extend
  `ChatProgress` (`contracts.rs:79`, `{label, step, total}`) or add a step
  variant — so §6/§7/the manifest can attach per iteration.
- Preserve narration-over-results and the deterministic footer/ledger exactly.
- **KEEP the `remote_keyed` gate** — do NOT lift onto local. The local
  6144-token window cannot carry `STEP_RESULT_CAP × N` accumulated step context;
  local and extractive keep today's single-query path.

## §3 — The cost meter

A new `CostMeta` rides the `ChunkMeta` seam (`contracts.rs:126`, the same final
-chunk provenance struct that already carries `origin`, `excerpt_count`,
`cached_at`). It reports, summed per ask across all model calls:

- **Tokens** — provider-reported input / output / total (from §1). Honest.
- **Dollars** — tokens × a shipped per-model price constant, LABELLED "estimated
  at $X/Mtok". Derived, never an authoritative charge.
- **Local** ⇒ tokens + $0.00 (loopback, not egress).
- **Unreported** ⇒ "not reported" — NEVER a `chars/4` estimate (that heuristic
  is prompt-sizing only; surfacing it user-facing violates §14).
- **Cumulative** — a running across-asks total surfaced beside the audit record.

Store `CostMeta` in `CachedAnswer` (`answer_cache.rs:61`) so a REPLAY reports 0
NEW tokens / $0 — consistent with `cached_at` meaning "the replay computed
nothing" — while still carrying the original figures as the historical record.

- **PARITY:** the labels are byte-identical across the twin (ts-twin.md rule 2).

## §4 — Two-phase plan approval

Forced two-phase by the one-shot transport:

- **Phase 1 (plan-only).** A `plan_only: Option<bool>` flag on `chat_ask`
  (`commands.rs:900-901`, mirroring the existing optional `bypass_cache` /
  `persist_allowed` params) runs step-1 planning and returns a PLAN chunk — a
  new optional field on `ChatChunk` (the same seam that already carries
  `analytics`, `draft`, `meta`) carrying the intended VERBATIM SQL and the
  context it would use — then STOPS. No execution, and on decline the client
  simply does not re-issue, so nothing runs and nothing egresses.
- **Phase 2 (approve).** The client re-issues the ask echoing back
  `approved_plan`; the engine EXECUTES that exact plan and SKIPS re-planning
  step 1 — the plan the user saw is the plan that runs (trust, and no double
  plan cost).
- **Caching** keys on the APPROVED ask, not the plan-only op — the plan-only op
  leaves the cache unchanged.
- **PARITY:** plan execution is Rust-only (analytics); the twin returns the plan
  op honestly or degrades, with a `PARITY:` comment.

## §5 — The context manifest

A per-entry manifest on the final-chunk seam — for each `Ctx`, `{ name, kind
(schema-card | query-result | retrieved-chunk | join-hints | chart-options |
conversation-note), chars, file_id?, local_only?, score }`.

- **METADATA ONLY — never `Ctx.text`.** Copying context bytes into the manifest
  would persist private text into `CachedAnswer.text` (`answer_cache.rs:61`) and
  G6 conversation notes — a persistence boundary `local_only` never authorized.
  The actual text stays behind the device-only file inspector (`inspect.rs`).
- Built AFTER the shareable-subset gate (`synth.rs:620-632`/`:955-964`,
  `vault::shareable_subset`), so the manifest is ALREADY the gated set for the
  posture. Pair it with the already-emitted `local_only_skip_note`
  (`synth.rs:323`, emitted at `:917`) so the disclosure states both what WENT to
  the model and what was WITHHELD because private.
- Attribute `retrieved-chunk` entries to their files via the already-flowing
  `references` (`RagReference.file_id`, `contracts.rs`).
- Store on `CachedAnswer` so a replay shows the ORIGINAL manifest, not a blank.
- **PARITY:** the twin builds ctxs too, so it mirrors the manifest shape.

## Answer-cache persistence (cross-cutting)

`CachedAnswer` (`answer_cache.rs:61`) currently stores `text`, `references`,
`analytics`, and `meta` (`ChunkMeta`). This change adds the cost meter and the
manifest to what is persisted, so a replay is faithful: 0 new tokens / $0 cost,
and the original manifest — not a blank meter and empty manifest. If this
changes the cached-answer wire shape, `CACHE_VERSION` moves in lockstep across
`native/.../extract.rs` (currently `9`), `src/server/extract.ts`, and the
assertion in `tests/extract_test.rs`.

## Settings lockstep

New `DesktopSettings` (`settings.rs:19`) fields — the loop budget
(`max_steps`), and any meter/approval toggles — are a COMPILE ERROR in
`settings_test.rs` until covered: `every_settings_field_round_trips`
destructures `DesktopSettings` with NO `..`, and `write_desktop_settings` takes
positional `Option` params. Extend the test's struct literal, destructuring,
and wire-key list for each new field.

## Rust/TS PARITY split

| Seam | Rust (ships) | TS twin |
|---|---|---|
| SSE `usage` parse + typed `Usage` (§1) | implemented | mirror the type as unset, `PARITY:` comment |
| Budgeted loop core (§2) | implemented in `beam.rs`/`analytics.rs` | Rust-only (analytics); twin never takes the branch |
| Cost-meter labels (§3) | implemented | byte-identical labels (rule 2) |
| Plan execution (§4) | implemented | returns the plan op honestly or degrades, `PARITY:` |
| Manifest shape (§5) | implemented | mirror the shape (twin builds ctxs) |

The SHARED `llm`/`synth` path is touched by §1/§3/§5, so those get twin edits
with byte-identical labels; the loop core and plan/token execution are Rust-only
because analytics is Rust-only.

## Failure & degradation

- **Usage unreported:** token budget is 0 → the loop bounds on
  `max_steps`/deadline; the meter shows "not reported". Never unbounded, never a
  guessed count.
- **Plan declined:** the client does not re-issue; nothing executes, nothing
  egresses. The one-shot transport makes decline the trivial no-op.
- **Cached replay:** cost meter reports 0 new / $0; the manifest and original
  figures come from `CachedAnswer`.
- **Local / extractive:** the `remote_keyed` gate keeps them on the single-query
  path; the loop, its budget, and its per-step progress never apply there.
