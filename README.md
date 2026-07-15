# Lighthouse

Curate which of your files and data sources your AI can see — then ask.
Lighthouse is a **local-first** desktop app: a vault of your documents on your
own disk, an explorer to toggle exactly which of them the AI may read, and a
grounded chat (with citations) that answers only from what you included. The
engine, the search index, the embeddings, OCR, text-to-speech, and — if you
choose the private model — the AI itself all run **on your machine**.

Built for two people in particular: the **data analyst** who wants trustworthy,
engine-verified answers over their own spreadsheets and reports, and the **IT
security director** who needs to approve all of it.

**Download:** installers for Windows, macOS, and Linux at
**[lhvault.app](https://lhvault.app)** — or straight from the
[latest release](https://github.com/lmansf/lighthouse/releases/latest).

> Naming debt, kept on purpose: the npm package is still named `rag-vault`,
> and the hidden per-vault state directory is `.rag-vault/` — renaming either
> would break existing installs' upgrades (orphaned indexes and settings), so
> neither is renamed. The product and repo are **Lighthouse**. The UI is the
> Forerunner theme — steel blues with a beacon accent — in light and dark.

## What it does (as of 0.11)

- **Curated inclusion.** Files default to *excluded*; a document is readable
  by the AI only when its own toggle is on and no ancestor folder is excluded.
  Adds are link-in-place on desktop (nothing copied), removal is
  non-destructive (recoverable trash), and the tree stays live via a
  filesystem watcher.
- **Grounded chat with citations.** Answers stream with `[n]` references and
  clickable Related-files cards. Ask about one document and Lighthouse reads
  **all of it** (whole-document answers; very long files are read section by
  section with an honest note). Multi-document questions get map-reduce
  synthesis.
- **Beam analytics.** Questions over CSV/TSV/Parquet/Excel become **one
  read-only SQL SELECT**, executed by an embedded engine (DataFusion) — the
  model narrates the *verified* result and the SQL is shown verbatim, with a
  freshness footer. Refinement chips, Edit-SQL re-runs (no model), multi-step
  analytics, union tables + join hints, charts in chat, save-as-CSV/PNG/note,
  and **pinned questions** that re-run deterministically and alert on change.
- **Hybrid retrieval.** Lexical search fused with on-device semantic
  embeddings (bundled nomic-embed model — no cloud, no download at query
  time), plus name/path matching and structure-aware chunking that keeps
  table headers on every chunk.
- **Reads your real corpus.** PDF, Word (+ legacy `.doc` salvage), Excel,
  PowerPoint, OpenDocument, RTF, Markdown, text — and **on-device OCR** for
  images and scanned PDFs.
- **Desktop widget + Whisper summon.** A floating ask-bar summonable with a
  keyboard chord (opt-in — it installs an OS keyboard hook only if you turn
  it on; see `docs/edr-whitelisting.md`), with inline answers and dictation.
- **Your choice of model.** On-device private model (bundled `llama-server`
  engine + opt-in ~4.2 GB Mistral-7B download, GPU-offloaded where available)
  — or bring a key for Anthropic Claude, OpenAI, Google Gemini, xAI Grok,
  Mistral, or DeepSeek. Keys are stored **encrypted at rest** on your device
  and survive restarts and sign-outs. No model at all still works: a
  zero-network extractive fallback answers with citations.
- **Read-aloud** via a bundled neural voice (Piper) — the answer text never
  leaves the machine.

## Run it

### Desktop app (what users get)

Install from [lhvault.app](https://lhvault.app) or the
[releases page](https://github.com/lmansf/lighthouse/releases/latest). The app
is a native shell (Tauri 2) around a Rust engine: system tray, opt-out
launch-at-login, native dialogs, **no local TCP port** — the UI talks to the
engine over IPC.

### From source

Web dev flow (TypeScript twin engine, fastest UI iteration — no Rust needed):

```bash
npm install
npm run dev      # http://localhost:3000
```

Desktop build (Rust toolchain + platform webview deps required; see
`.github/workflows/desktop-release.yml` for the exact Linux packages):

```bash
npm install
npm run desktop:build      # static-export UI + cargo build --release
# binary: native/target/release/lighthouse-desktop
npm run fetch:model        # optional: bundled engines (llama-server, Piper, embeddings, OCR)
```

## Architecture

Two engines, one contract:

- **`native/` — the shipping product.** `lighthouse-core` (Rust) owns the
  vault, retrieval index, extraction, OCR, embeddings, analytics, and
  synthesis; `lighthouse-desktop` is the Tauri 2 shell (window/tray/
  widget/supervision/updater); `lighthouse-server` is the same engine behind
  a loopback HTTP API for tests and headless use.
- **`src/server/` + `app/api/` — the TypeScript twin.** The web-dev flow and
  parity oracle. It is deliberately not the product; see
  **[docs/ts-twin.md](docs/ts-twin.md)** for the parity rules and the
  canonical list of Rust-only capabilities.

The UI (Next.js static-export + Fluent UI) decouples through
`src/contracts/`; inside the desktop shell every `fetch("/api/…")` is carried
over Tauri IPC (`src/shell/tauriTransport.ts`).
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the original design notes
(pre-rewrite; see its header).

Releases: `desktop-release.yml` (gated on a 3-OS build/boot/ask smoke —
`release-smoke.yml`) builds the installers and update manifests;
`publish-release.yml` flips the draft public. Code signing is wired and
awaits certificates — **[docs/signing.md](docs/signing.md)**.

## Network & privacy

**Lighthouse collects no analytics and phones nothing home on its own.**
There is no usage telemetry, no click tracking, no launch ping, no A/B
experiment machinery, and no accounts or licensing — none of it exists in the
code. The app makes only **three** kinds of outbound request, and every one is
something you asked for:

1. a request to the **cloud AI provider you configured** (the only path that
   can carry document content — pick the local model and it's zero calls);
2. a **version check** against GitHub releases (a GET, no payload);
3. **pinned asset downloads you click** — the private-model weights (from a
   fixed URL) and app updates (which are signature-verified before they run).

Feedback never leaves via the app itself: the **Send-feedback** form composes
your report locally — shown in full first — and hands it to **your own mail
client** (a `mailto:`) or **browser** (a prefilled, public GitHub issue). You
send it; Lighthouse makes no request of its own. The complete egress inventory
— every host, when it fires, what it carries, how to turn it off — is
**[docs/data-flows.md](docs/data-flows.md)**, written for a security review.
Chat history is **opt-in** and local; API keys are sealed (AES-256-GCM) on
disk; state writes are 0600 and atomic.

## Configuration

All optional (`.env.local`, gitignored; the desktop app manages its own state):

- `VAULT_DIR` — where your documents live (default `./vault` in dev; the
  desktop app manages this).
- Provider keys — normally entered in-app (sealed at rest); env overrides:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or
  `GOOGLE_API_KEY`), `XAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`.
- `LIGHTHOUSE_LOCAL_LLM_URL` — OpenAI-compatible endpoint for the private
  provider (default `http://127.0.0.1:8080/v1/chat/completions`; Ollama:
  `http://127.0.0.1:11434/v1/chat/completions`).
  `LIGHTHOUSE_LOCAL_LLM_MODEL` — model name for servers that need one
  (Ollama/LM Studio); ignored by the bundled `llama-server`.

Lighthouse has no accounts, licensing, or payment configuration — there is
nothing to set up and no backend to run.

## Local model

Pick **"Local model (private)"** — in onboarding or the settings gear's **AI
models** dialog — to answer entirely on-device: no API key, no network,
nothing leaves your machine.

- **Bundled engine + opt-in weights:** the installer ships `llama-server`
  (llama.cpp, MIT) but not the ~4.2 GB Mistral-7B-Instruct-v0.3 weights
  (past the 2 GB installer/asset caps) — click **＋** next to the private
  model to download them once (Apache-2.0, from Hugging Face with a
  hash-verified fallback mirror). The shell then runs the model
  automatically, offloading layers to a supported GPU (Vulkan/Metal) and
  falling back to CPU cleanly.
- **Bring your own:** point `LIGHTHOUSE_LOCAL_LLM_URL` at Ollama or
  LM Studio.

If the local server isn't reachable, Lighthouse falls back to streaming the
most relevant passages, so you still get a grounded, cited answer.

### Third-party components

Bundled in the installer under their own permissive licenses:

- **llama.cpp** `llama-server` — MIT © the ggml.ai / llama.cpp authors.
- **Piper** TTS — MIT © Michael Hansen / the Piper authors — with the
  `en_US-lessac-medium` voice (MIT/CC0; see
  [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)).
- **nomic-embed-text-v1.5** embeddings — Apache-2.0 © Nomic AI.
- **ocrs** OCR models — the ocrs project is MIT/Apache-2.0; its models are
  trained on openly-licensed data (HierText, CC-BY-SA 4.0), attributed here.

Downloaded on demand (not bundled): **Mistral-7B-Instruct-v0.3** weights —
Apache-2.0 © Mistral AI.

## Status

Shipping: the native desktop app described above, at **0.11.x**, with the
release pipeline (build → 3-OS smoke → draft → publish) run from this repo.
Landed from the persona roadmap: the org-deployable managed-policy layer,
the local audit log + egress transparency panel, PDF table extraction,
briefings, richer charts — and the removal of **all** automatic data
collection *and* the accounts/licensing/Supabase backend (see §Network &
privacy; the only feedback channel is the explicit Send-feedback form, which
hands off to your own mail client or browser). Still open: code-signing certificates —
installers are currently **unsigned** (SmartScreen/Gatekeeper warn on first
launch); the signing pipeline is wired and documented in
[docs/signing.md](docs/signing.md).
