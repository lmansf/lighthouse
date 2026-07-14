# Local inference — speed knobs

How the bundled local model runs, and the two levers for faster private answers
(roadmap P2.1). Both default to the fast path and degrade safely; neither sends
anything off the machine.

## GPU offload (default on)

The shell launches `llama-server` with **`-ngl 999`** — offload every layer to
the GPU. The bundled build carries dynamic backends (Vulkan on Windows/Linux,
Metal on macOS) with a built-in **CPU fallback**, so asking for full offload is
safe on GPU-less machines. The one pathological case — a Vulkan driver that
crashes the process — is caught by the quick-crash guard in `Supervisor::
reconcile`, which persists `llmDisableGpu` and relaunches CPU-only.

Overrides (shell settings, `read_settings`):

| Setting | Effect |
|---|---|
| `llmDisableGpu: true` | CPU-only (set automatically after two quick GPU crashes). |
| `llmGpuLayers: <n>` | Offload only `n` layers — for low-VRAM GPUs that OOM at full offload. Unset/negative ⇒ 999 (offload everything). |

## Speculative decoding — "draft-then-verify" (opt-in)

When a small **draft model** is bundled under `resources/llm-draft/`, the shell
passes `--model-draft` (plus `--draft-max`/`--draft-min`, and `-ngld` to offload
the draft too). llama-server then drafts tokens with the fast little model and
the main model **verifies a whole batch at once** — materially faster local
generation with **identical output** (verification guarantees the same tokens
the main model would have produced). With no draft model bundled, decoding is
unchanged — this is strictly opt-in and fail-closed.

`bundled_draft_model()` (engine) only accepts a real GGUF (magic + size) in its
own directory, so the draft weights can never masquerade as the installed main
chat model (the same guard `resources/embed/` uses).

### What the maintainer must provision

Speculative decoding ships **inert** until a draft model is bundled:

1. Pick a small draft model **from the same family/tokenizer** as the main chat
   model (speculative decoding requires a compatible vocabulary) — e.g. a
   0.5–1B GGUF for a 7–8B main model.
2. Add a fetch step to `scripts/fetch-local-model.mjs` that downloads it into
   `resources/llm-draft/` (mirror-first + SHA-256-verified, like the other
   model assets), so the Tauri bundler copies it into the installer.
3. No code change is needed — the engine auto-detects the file at launch.

Speed gains from speculative decoding depend on the draft model's acceptance
rate; measure on target hardware before shipping a specific draft model.
