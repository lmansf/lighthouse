# add-beam-loop

## Why

The multi-step analytics executor is already a loop — `remote_keyed &&
multi_step_cue` gates a `while steps.len() < 3` plan→query→verify cycle whose
narration reads verified per-step results and whose footer lists every query.
But it is a loop with a bare hardcoded count, no cost visibility, no way for
the analyst to see or approve what it will run, and no honest account of what
context it fed the model. This change turns that cycle into a budgeted,
legible, approvable Beam loop, and makes four things first-class:

- **A budgeted loop** — the hardcoded "3" becomes a real budget (`max_steps` +
  wall-clock deadline + no-progress guard + a token ceiling), so the loop
  spends effort proportionate to the question and never runs unbounded.
- **An honest cost meter** — provider-REPORTED tokens summed across every model
  call, a LABELLED dollar estimate (never a charge), $0 for local, and "not
  reported" where a provider is silent.
- **Plan approval** — the analyst sees the intended verbatim SQL and the
  context it would use, and approves before anything runs or egresses.
- **A context manifest** — a per-entry, metadata-only account of exactly what
  went to the model, paired with the existing local-only skip note.

The headline constraint shapes the approval design: a chat ask is **one-shot
and unidirectional**. `chat_ask` takes all input up front and streams
`ChatChunk`s out through a one-way channel; the engine body is an
`async_stream!` generator with NO handle to receive a client signal
mid-flight. There is therefore **no mid-stream pause** — plan approval MUST be
two-phase (plan-only returns a plan and stops; a second ask echoes the
approved plan back and runs it). And because the multi-step executor already
IS the loop, this change budgets and instruments what exists rather than
building a new one.

## What Changes

- **Engine-reported token accounting (do first).** Generalize the SSE parser
  (`sse_deltas`, llm.rs:607) to also pick a `usage` event and thread a typed
  `Usage { input, output }` out of `stream_answer`; parse Anthropic's default
  usage and add `stream_options:{include_usage:true}` to the OpenAI-compat +
  local bodies. Accumulate per ask across every model call. If usage is
  unreported, the token budget stays zero and the loop falls back to
  `max_steps`/deadline.
- **The Beam loop core.** Lift the multi-step loop into an owned struct
  parameterized by a BUDGET (`max_steps` default + deadline + no-progress guard
  + the token ceiling) instead of `steps.len() < 3`; kill the hardcoded "3" in
  the step prompt and the progress label; keep the single combined plan+decide
  call per iteration; emit a structured per-step progress chunk; preserve
  narration-over-results and the deterministic footer/ledger; keep the
  remote-keyed gate (do NOT lift onto local).
- **The cost meter.** A `CostMeta` on the final chunk (riding the `ChunkMeta`
  seam), stored in `CachedAnswer` so a replay reports 0 new tokens / $0. Tokens
  provider-reported and summed; dollars derived from a shipped per-model
  constant and labeled an estimate; local ⇒ tokens + $0.00; unreported ⇒ "not
  reported"; a cumulative total beside the audit record.
- **Two-phase plan approval.** A `plan_only: Option<bool>` flag (mirroring
  `bypass_cache`/`persist_allowed`) returns a plan chunk with the intended
  verbatim SQL + context and STOPS; an `approved_plan` echo re-issues, executes
  that exact plan, and skips re-planning step 1. Caching keys on the approved
  ask, not the plan-only op.
- **The context manifest.** A per-entry, metadata-only manifest on the
  final-chunk seam (`{ name, kind, chars, file_id?, local_only?, score }`,
  NEVER `Ctx.text`), built AFTER the shareable-subset gate so it is already the
  gated set, paired with the existing `local_only_skip_note`, with chunks
  attributed to files via `RagReference.file_id`.

## Capabilities

### New Capabilities

- `beam-loop`: the budgeted multi-step executor — `max_steps` + wall-clock
  deadline + no-progress guard + a token ceiling (with a safe fallback when
  usage is unreported), the single combined plan+decide call, the structured
  per-step progress, and the preserved remote-keyed gate. Every loop figure
  stays engine-computed.
- `answer-cost`: the honest cost meter — provider-reported token accounting
  summed across every model call, a labeled dollar estimate (never a charge),
  $0 local, "not reported" for silent providers, zero-cost cached replays, and
  a cumulative total.
- `plan-approval`: the two-phase plan/approve flow forced by the one-shot
  transport — plan-only returns a plan and stops (no execution, no egress on
  decline); approve executes the exact plan the user saw without re-planning;
  caching keys on the approved ask.
- `context-manifest`: the metadata-only per-entry account of what went to the
  model, built on the gated shareable subset, paired with the skip note, with
  chunk-to-file attribution, and never carrying context bytes.

## Non-goals

- **No mid-stream pause.** The ask transport is one-shot and unidirectional;
  approval is two-phase, never an in-flight interrupt.
- **No model-authored numbers.** The model plans/decides steps and narrates
  over verified results; every figure traces to an engine-executed query.
- **The dollar figure is a labeled estimate, not a charge.** Tokens are
  provider-reported (honest); dollars are derived from a shipped per-model
  constant and labeled as an estimate — never presented as a billed amount.
- **No `chars/4` token guess in the meter.** That heuristic stays
  prompt-sizing only; an unreported provider shows "not reported", never an
  estimated count.
- **Do NOT lift the loop onto local.** The remote-keyed gate stays; the local
  6144-token window cannot carry `STEP_RESULT_CAP × N` accumulated context.
- **No version bump.** This is an H-suite phase; it stays on the current line
  and does not move the version stamps.

## Impact

- **Engine (Rust, ships):** `llm.rs` (SSE `usage` parse + typed `Usage`; the
  `stream_answer` item/out-param becomes usage-aware;
  `stream_options:{include_usage:true}` on OpenAI-compat + local bodies); a new
  `beam.rs` (or `analytics.rs`) owning the budgeted-loop struct lifted from
  `synth.rs:1020-1210`; `synth.rs` (loop call site, per-step progress chunk,
  cost-meter emission, manifest emission built on the shareable subset,
  local-only skip-note pairing); `analytics.rs:4428` (`step_question` drops the
  hardcoded "3", reads the budget); `contracts.rs` (`CostMeta` on the
  `ChunkMeta` seam; a `plan_only`/plan chunk field on `ChatChunk`; the manifest
  field); `commands.rs:887` `chat_ask` (`plan_only` + `approved_plan` optional
  params beside `bypass_cache`/`persist_allowed`); `answer_cache.rs:61`
  `CachedAnswer` (persist cost meter + manifest so a replay is 0-cost and shows
  the original manifest); `settings.rs` `DesktopSettings` (loop budget +
  meter/approval toggles).
- **PARITY cost (`src/server/`):** the SHARED `llm`/`synth` path is touched, so
  the TS twin mirrors the typed usage (unset — usage parse is Rust-shipped),
  the cost-meter labels **byte-identical** (ts-twin.md rule 2), and the
  manifest shape (the twin builds ctxs too). The loop core, plan execution, and
  token parsing are Rust-only (analytics is Rust-only); the twin returns the
  plan op honestly or degrades, with `PARITY:` comments on both sides.
- **Lockstep gates:** if the cached-answer shape changes, `CACHE_VERSION` moves
  in lockstep across `native/.../extract.rs`, `src/server/extract.ts`, and the
  assertion in `tests/extract_test.rs`. New `DesktopSettings` fields (budget /
  meter / approval) are a compile error in `settings_test.rs` (no-`..`
  destructuring) until covered.
- **Supersedes `add-multi-step-analytics`:** that change specified the bounded
  3-query loop and its gating; this change generalizes it to a budget and
  instruments it, and takes over the loop's spec surface.
- **Data flows / egress:** no NEW egress — token usage rides the streams
  already opened; plan-only and manifest add no network calls; the approval
  gate can only REDUCE egress (decline sends nothing).
