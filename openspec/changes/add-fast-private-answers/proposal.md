# Fast private answers: an instant draft while the local model verifies, and a truthful GPU status

## Why

The private (local-model) path is Lighthouse's most trust-critical answer path —
nothing leaves the machine — but it is also the slowest to a first visible
token: the bundled model takes seconds to warm and prefill before it writes a
word. Retrieval, by contrast, lands in milliseconds. Today the user stares at a
loader for those seconds; a 0.6.x field report put it bluntly: *"slow to write…
provide something instantly."* We already name the sources instantly ("Reading
q3.csv…"), but the *content* is still withheld until the model speaks.

Two independent improvements close that gap, both on-device:

1. **An instant extractive draft.** The retrieval snippets are already in hand;
   render them as a provisional, clearly-labeled draft the moment retrieval
   returns, then replace it in place with the model's grounded answer. First
   visible content drops from seconds to well under two seconds, with zero extra
   I/O and zero model calls — and the draft never blocks or alters the verified
   answer.
2. **A truthful GPU status.** The shell already offloads to the GPU by default
   (`-ngl 999`, Vulkan/Metal) with a CPU fallback and a crash guard, but the user
   has no way to see whether acceleration actually engaged on their machine. The
   AI-models dialog should surface the shell's *real* launch state — "GPU
   acceleration: on (999 layers)" or "off — CPU" — read from the supervisor, not
   guessed.

Neither touches the trust invariant: the draft is extractive-only (it quotes the
user's own files, never a second model's words), it is visibly labeled as a
draft, and the verified answer replaces it wholesale.

## What Changes

- **Answer-level draft-then-verify (both engines).** On the local-model path,
  after meta/analytics have had their chance to answer, the engine emits ONE
  provisional chunk carrying an extractive draft built from the retrieval
  snippets (the top passages, `[n] **file** — snippet…`). A new `ChatChunk.draft`
  wire flag marks it. The UI shows it under a muted "Draft — verifying with the
  private model…" badge and replaces it in place with the first authoritative
  (non-draft) delta. Gated to the local provider + a `draftAnswers` preference
  (default on) + non-empty contexts; meta and analytics answers never get a
  draft (they return before the emission point).
- **`draftAnswers` setting (both engines) + Preferences toggle.** Rides the
  existing typed settings pipeline (which trips the `settings_test.rs` compile
  tripwire, forcing coverage of the new field and every writer call site). A
  Switch in Preferences turns it off; off streams the verified answer with no
  draft, exactly as before.
- **GPU status (desktop + UI, PARITY-diverged Rust-only).** The Tauri
  supervisor records the chat llama-server's real launch state (GPU on/off, `-ngl`
  layer count, running) on each spawn; `model_status` merges it into the existing
  `/api/model` response; the AI-models dialog shows it once the model is
  installed. The web/dev server has no supervisor, so the fields are absent there
  and the UI renders nothing for them.

## Capabilities

### New Capabilities
- `private-answer-draft`: while the local model composes a grounded answer,
  stream an instant extractive draft from retrieval snippets, clearly labeled and
  replaced in place by the verified answer; on by default, Preferences-toggleable,
  mirrored byte-for-byte in both engines.
- `local-model-gpu-status`: surface the shell's actual llama-server GPU launch
  state (on + layer count, or CPU-only) in the AI-models dialog; desktop-only
  (the web/dev build has no supervisor and shows nothing).

## Impact

- Engine (both twins): `contracts.rs`/`types.ts` (`ChatChunk.draft`),
  `llm.rs`/`llm.ts` (`draft_answer`/`draftAnswer`, factored out of the keyless
  `extractive` renderer), `synth.rs`/`synth.ts` (the gated draft emission before
  the decide block), `settings.rs`/`settings.ts` (`draftAnswers`).
- Desktop shell (Rust, CI-verified): `supervise.rs` (`GpuLaunchState` +
  `gpu_status`), `commands.rs` (`model_status` gains `AppHandle` and merges GPU
  fields; `settings_get`/`settings_set` carry `draftAnswers`). Server parity:
  `routes.rs` (`draftAnswers` round-trip; a PARITY note that GPU fields are
  desktop-only).
- UI: `ChatPanel.tsx` (draft state + in-place replacement + badge),
  `LicenseGate.tsx` (Preferences toggle), `LocalModelOption.tsx` (GPU status
  line + fields on `ModelState`), `tauriTransport.ts` (`draftAnswers` mapping).
- Tests: `settings_test.rs` (exhaustive round-trip, the compile tripwire),
  `llm.rs` + `test/draftAnswer.test.mjs` (draft rendering parity). No cache bump.

## Non-goals

- **No change to token-level speculative decoding.** llama.cpp's `--model-draft`
  speculative decoding is a separate, unrelated mechanism; this change is about
  the *answer-level* extractive draft UX and does not touch it.
- **No new GPU offload controls.** GPU status is READ-ONLY display of the
  existing `-ngl`/`llmDisableGpu` behavior; it adds no new knobs and changes no
  launch logic.
- **The draft is extractive-only — never a second model call.** It quotes the
  user's own retrieved passages; it never invokes a model, so it costs no tokens
  and cannot itself be wrong beyond what the files say.
- **The draft never blocks or alters the final answer.** It is a separate chunk
  that enters no prompt; a model failure or the keyless extractive fallback
  simply arrives as a non-draft delta and replaces it.
- **No cache-version bump.** This changes retrieval *presentation* and launch-state
  *display* only — extraction, chunking, and embeddings are untouched.
- **No GPU status on the web/dev build.** No supervisor there; the fields are
  absent and the UI shows nothing (PARITY divergence).
