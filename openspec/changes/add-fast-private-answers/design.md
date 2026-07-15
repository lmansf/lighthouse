# Design — fast private answers

## Non-Goals (pinned)

1. **Not token-level speculative decoding.** The answer-level draft is unrelated
   to llama.cpp `--model-draft`; do not conflate them (the supervise.rs comment
   there even predates this and says "roadmap P2.1" — that is the token path).
2. **No new GPU controls.** GPU status is read-only display of existing behavior.
3. **Draft is extractive-only, never a model call.** Zero tokens, zero prompt.
4. **Draft never blocks or alters the verified answer.**
5. **No cache-version bump.**
6. **No GPU status on the web/dev build** (no supervisor).

## Decisions

### D1 — Draft source is the retrieval already done, rendered by the shared extractor
The draft reuses `initial.contexts` — the k=5 hybrid retrieval already performed
for the answer — and the SAME top-passage renderer as the keyless `extractive`
fallback, factored into `draft_answer(question, contexts)`. This is the load-
bearing decision for "instant": no extra I/O, no second retrieval, no model call.
Reusing the extractor (rather than a parallel formatter) keeps the draft's shape
identical to the fallback the user may already have seen, and keeps the two
engines byte-identical by construction (one renderer each, mirrored).

### D2 — A single emission choke point, after meta/analytics return
The draft is emitted at exactly one place in `answer_pipeline`: after the vault
meta-answer and (Rust-only) analytics branches have returned, and before the
"decide: synthesis or single-shot" block. So a deterministic instant answer
(meta) or an engine-verified analytics answer is NEVER prefixed by a pointless
draft — only a real local grounded-answer path gets one. The TS twin has no
analytics branch, so its choke point differs by exactly that block; a PARITY
comment marks the offset.

### D3 — In-place replacement is one wire bool + one UI ref
`ChatChunk.draft: Option<bool>` marks the provisional chunk. The UI keeps a
`draftRef` (synchronous, for the stream loop) and a `draftActive` state (for the
badge). The first non-draft delta wipes the accumulated draft text
(`finalContent = ""`) and clears the flag, then streams the verified answer.
No separate "clear the draft" sentinel is needed; the transition is implicit in
the first authoritative token. Edge cases fall out for free: a model-failure note
or the extractive fallback arrives as a non-draft delta and replaces the draft;
meta/analytics never emit a draft so they never enter this path.

### D4 — Gating: local provider + preference + non-empty contexts
The draft is emitted only when `provider_id == "local"`, `draftAnswers != false`
(default on, read from settings at emit time), and there is at least one
retrieval context. Remote providers (which are faster to first token and whose
draft would be redundant) never draft; an empty-vault ask never drafts.

### D5 — GPU status folds into the existing `/api/model` GET
No new command, route, `generate_handler!` entry, or transport change. The
`model_status` command gains an injected `AppHandle` and merges the supervisor's
`gpu_status()` into the JSON it already returns. The `useLocalModel` poll already
carries the extra fields to the panel. `gpu_status()` records `gpu`/`layers` on
each successful spawn and computes `running` LIVE from whether a chat child is
currently held — so every teardown path reflects immediately without threading a
"stopped" write through `shutdown`/`idle_teardown`/`reconcile`.

### D6 — GPU status lock ordering
`start_local_llm` holds the `llm` lock while it records `gpu_state`. So
`gpu_status()` must not hold `gpu_state` while taking `llm`, or the two invert
and can deadlock. `gpu_status()` therefore reads-and-releases `gpu_state` first
(the lock guard drops at the end of that statement), THEN takes `llm` to compute
`running`. The two locks are never held simultaneously in this reader.

### D7 — `draftAnswers` rides the typed settings pipeline (the tripwire is the point)
Adding the field to `DesktopSettings` and the positional `write_desktop_settings`
writer trips the `settings_test.rs` compile tripwire (no-`..` destructure +
positional writer call). That is the designed safety net from PR #141: it forces
the new field to be covered and every writer call site (core test, both desktop
calls, the server route) to be updated, or the build goes red.

## PARITY decisions (explicit)

- **Draft path: MIRRORED in both twins.** The draft text is user-visible, so
  per CLAUDE.md the Rust and TS renderers stay byte-identical (`draft_answer` ⇄
  `draftAnswer`), and the wire flag + gating match. The only intentional
  divergence is the emission position (the Rust choke point sits after the
  Rust-only analytics branch), marked with a PARITY comment.
- **GPU status: Rust/desktop-only, PARITY-DIVERGED.** The shell owns the
  llama-server, so only the desktop `model_status` can report GPU state. The
  web/dev `model_get` route has no supervisor and omits the fields; the UI
  treats a missing `gpuOn` as "unknown" and renders nothing. A PARITY comment
  marks the route.

## Degradation & the local context window

The draft is a SEPARATE streamed chunk that never enters any prompt, so it costs
zero tokens against the local model's 6144-token window (the window a 0.6.0
report once blew). If the model fails, its failure note or the extractive
fallback arrives as a non-draft delta and cleanly replaces the draft. If
`draftAnswers` is off, nothing is emitted and the answer streams exactly as
before — the branch may only ADD the draft, never alter the verified answer.

Two guards keep a draft from ever settling AS the answer: (1) the local path
always emits a real answer — a clean completion that yields ZERO tokens falls
back to the extractive passages as a NON-draft delta (llm.rs/llm.ts), so the
draft is always replaced on success; and (2) if the stream is instead
interrupted mid-draft (Stop, or an error before any verified token), the UI
blanks the provisional content in its stream-end path rather than let an
unlabeled draft persist as a grounded answer.

## Test plan

- `settings_test.rs`: the exhaustive round-trip gains `draftAnswers` in the
  struct literal, the no-`..` destructure, the assert, the wire-key list, and the
  positional writer call + read-back — the compile tripwire proves every writer
  site was updated.
- `llm.rs` unit + `test/draftAnswer.test.mjs`: `draft_answer`/`draftAnswer`
  render exactly the top 3 passages as `[n] **name** — snippet…`, 300-char
  clamp, trimmed, empty-contexts → empty — parity between the twins.
- Existing `synth`/`llm`/recall tests stay green (the draft is gated to the local
  provider; keyed/mock-provider tests emit none, so no snapshot drift).
- CI-only: `desktop-release.yml` compiles the desktop call sites
  (`model_status(app)`, `settings_set` param, both `write_desktop_settings`
  calls, `GpuLaunchState`); `release-smoke.yml` runs the settings round-trip and
  the zero-network grounded-ask boot (which now exercises the draft→verified
  replace path).
