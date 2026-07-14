# Data flows — every network touchpoint, for a security review

*This document enumerates every outbound network call the shipped Lighthouse
app can make: the destination, what triggers it, exactly what data it
carries, and how to turn it off. It is written to be checked against the
code — file references are given throughout. Scope: the shipping Rust engine
(`native/`); the TypeScript twin (`src/server/`, dev-only — see
`docs/ts-twin.md`) mirrors the same hosts but does not ship.*

**The baseline claim, stated precisely:** Lighthouse contains **no automatic
data collection**. There is no usage telemetry, no click capture, no launch
ping, no funnel events, and no A/B experiment machinery — the code for all of
it has been deleted, not merely disabled. The only bytes that ever leave the
machine on Lighthouse's behalf are: **(1)** a request to the cloud AI
provider you configured (§1 — the only path that can carry document
content), **(2)** the license/trial check (§2), **(3)** the update check
(§4), **(4)** pinned, hash-verified asset downloads you click (§4–5), and
**(5)** a feedback/bug report you explicitly pressed **Send** on (§2). Two
further strictly-user-initiated flows exist: Subscribe checkout (§3, hidden
by default) and the Microsoft 365 connector (§6, only if you connect it).
That is the whole list.

With the **local model** selected (or no model configured), answering a
question makes **zero network calls** — retrieval, embeddings, OCR, TTS, and
generation are all on-device (loopback or in-process; §7).

---

## 1. AI providers — the only path that carries document content

Fires **per question**, only when that provider is selected **and** has a
key. Payload: the system prompt, recent conversation turns, your question,
and the retrieved context — **file names + extracted text of the retrieved
chunks** (or the whole document under whole-document answers). Engine:
`native/crates/lighthouse-core/src/llm.rs`.

| Provider | Host | Also (key test in Settings) |
|---|---|---|
| Anthropic Claude | `api.anthropic.com` (`POST /v1/messages`) | `GET /v1/models` |
| OpenAI | `api.openai.com` (`POST /v1/chat/completions`) | `GET /v1/models` |
| Google Gemini | `generativelanguage.googleapis.com` (`POST /v1beta/openai/chat/completions`) | `GET …/models` |
| xAI Grok | `api.x.ai` | `GET /v1/models` |
| Mistral | `api.mistral.ai` | `GET /v1/models` |
| DeepSeek | `api.deepseek.com` | `GET /v1/models` |

**Disable:** select **Local model (private)** or no provider — the engine
answers from the on-device model or the extractive fallback with zero
egress (`llm.rs` `stream_local`/`extractive`). A cloud call cannot happen
without a stored key for the selected provider. Organizations can enforce
this: the managed policy layer's `allowedProviders`/`forceLocalOnly`
(docs/managed-deployment.md) pins the choice engine-side.

## 2. License, trial & explicit feedback — Supabase Edge Function

All ops go to **one host**, baked into shipped builds via `.env.production`:
`https://yyiqwpcqpohzyrzwyxqk.supabase.co/functions/v1/license`
(`native/crates/lighthouse-core/src/license.rs`, hub `call_fn`). **No
document content, file names, or questions — ever — on this host.**

The retired ops, named so a reviewer can grep for their absence: `ping`
(launch ping), `event` (funnel events), `events` (click-capture batches),
and `assign` (A/B bucketing) **no longer exist in either engine** — there is
no code path that emits them.

What remains, exhaustively:

| op | When it fires | Payload |
|---|---|---|
| `check` | **every launch**; activating a key | `{licenseKey}` (an opaque install id — the one automatic call on this host) |
| `start` | you starting the 14-day trial | the contact form fields you typed |
| `bug` | you pressing **Send** on the feedback form | `{where, what, version, os, log?}` — exactly what the dialog showed you; the `log` (a shell.log excerpt) only with its off-by-default checkbox ticked, rendered in the dialog first. **No account id, email, or license id.** |
| `feedback` | you pressing **Send** on the trial survey | the survey fields you typed, plus the account email and contact id (it is a contact-linked survey) |
| `featureInterest` | you pressing **Send** on the shelved-features vote | `{shown, wanted}` — the feature ids shown and the ones you ticked, nothing else |
| `notify` | you asking to be emailed when purchasing opens | the email you typed + contact id (that's the point of the form) |

Identity semantics for the rows above: `contactId` is a **random persistent
UUID** minted locally; `email`/name leave the machine **only** where the
table says so — always inside a form you filled in and submitted.

**Defaults, stated plainly:** in a hosted (normal) build, the license
`check` is the **only** call that fires without a click. Everything else in
the table requires you to press Send on a form that shows its payload. The
managed-policy key `telemetry: "off"` is retained for config compatibility
but now has nothing left to silence. The build-level off switch is unsetting
`LICENSE_API_URL` (every op no-ops, checked per-call); **offline activation**
(shipped — `LICENSE_OFFLINE_PUBKEY` + a signed license file,
docs/managed-deployment.md) removes even the `check` for air-gapped
deployments. Failure posture: license checks **fail closed to a lock, never
a wipe** — your files are untouched.

## 3. Checkout — Supabase + Stripe

`POST …/functions/v1/create-checkout` with `{guid, email}` returns a Stripe
Checkout URL opened in your browser. Fires **only** on clicking Subscribe,
which is hidden unless `PAID_ENABLED=1` (shipped default `0`). Stripe is
contacted by the Edge Function server-side and by your browser — never by
the app directly.

## 4. Update check & verified update download — GitHub

`native/crates/lighthouse-desktop/src/supervise.rs`:

- **Check:** `GET api.github.com/repos/lmansf/lighthouse/releases/latest` at
  boot and every 6 h. Payload: none (a GET with UA `lighthouse-app`).
  Notify-only: a newer version arms a banner/tray notice.
- **Download:** only on your click, and only in builds carrying the updater
  public key against a release carrying a minisign `.sig` — the installer
  and signature download from `github.com/lmansf/lighthouse/releases/download/…`
  (302 → `*.githubusercontent.com`) and the artifact is **verified before
  anything executes** (`lighthouse-core::updates`). Unsigned builds/releases:
  the button opens the releases page in your browser instead; the app never
  downloads what it can't verify.

## 5. Private-model weights — Hugging Face (opt-in, one-time)

Clicking **＋** on "Local model (private)" downloads
Mistral-7B-Instruct-v0.3 (~4.2 GB) from `huggingface.co` (302 → HF CDN),
streamed to your user-data dir (`local_model.rs`). Payload: none (GET).
Never fires unless you click install. The embedding/OCR/TTS models are
**bundled in the installer** — nothing is fetched for them at runtime.

## 6. SharePoint / OneDrive connector — Microsoft (opt-in)

Only if you connect it (default: disconnected, zero calls).
`sources/microsoft.rs`: device-code OAuth against
`login.microsoftonline.com` (public client, no secret), then Microsoft
Graph (`graph.microsoft.com`) to list and download **your** files into the
local mirror. Direction is inbound — no vault content is uploaded. Tokens
are stored outside the vault; the bearer token is sent only to Graph hosts
(guarded in code). Disconnect drops tokens and the mirror.

## 7. Loopback & in-process — NOT egress

For completeness, the on-device services (127.0.0.1 only, no external
sockets): the chat llama-server (`:8080`), the embedding server (`:8091`),
Piper TTS / Whisper dictation / OCR (in-process or child processes with no
sockets), and the dev-mode embedded API server. In the shipped bundle the
UI talks to the engine over **Tauri IPC — no TCP port at all**.

PDF table reconstruction (`pdf_tables.rs`, add-pdf-tables) is likewise
in-process and offline: it reads a PDF's own text-layer glyph positions and
rebuilds any confident grid as markdown appended to the extracted text — pure
geometry, no model, no network. Reconstructed tables ride the same on-device
extraction/retrieval path as OCR text; nothing about them touches egress.

## 8. Build/CI-time only — never in the shipped app

`scripts/fetch-local-model.mjs` (build machines): llama.cpp + Piper GitHub
releases, HF-hosted voice/embedding models and the ocrs S3 bucket — all via
the repo's own mirror first (`github.com/lmansf/lighthouse` release
`hf-assets-1`), version-pinned and SHA-256-verified fail-closed.

## 9. Local audit log — written locally, NOT egress

With the audit log on (`auditEnabled`, off by default, or managed policy
`auditLog: "on"`), the engine appends one JSONL record per answered question
under the app-state directory (`audit/audit-<YYYY-MM>.jsonl`, 0600) — the same
place the index and settings live. The record holds what the answer read (file
ids), which provider answered, and **which hosts that question dialed** (the
egress panel's per-question delta), plus a SHA-256 of the question (the verbatim
text only if `auditVerbatim` is also set). Each record chains an HMAC-SHA256 to
the previous one, so deleting or editing any record breaks verification from
that point (a detective control, not anti-root DRM — see the threat model in
`openspec/changes/add-audit-log/design.md`). The log itself **never leaves the
machine**: it is written and read locally, and the only way it moves is the
user's own "Export CSV" into the vault. The TS dev twin mirrors the record shape
but omits the HMAC chain (PARITY — it is not a security surface).

## Redirect / effective hosts (for allowlisting)

`github.com` + `api.github.com` → `objects.githubusercontent.com` /
`release-assets.githubusercontent.com`; `huggingface.co` → `cdn-lfs*.
huggingface.co` / `cas-bridge.xethub.hf.co`; ocrs models →
`ocrs-models.s3-accelerate.amazonaws.com` (build-time only).

## Disable matrix (today)

| Egress | Lever |
|---|---|
| Cloud AI (the only content path) | choose Local/no provider; don't store a key — or managed policy `allowedProviders`/`forceLocalOnly` (org-wide, engine-enforced) |
| License `check` | unset `LICENSE_API_URL` (build-level), or offline activation (`LICENSE_OFFLINE_PUBKEY` + signed license file) for air-gapped deployments |
| Feedback / bug / vote / notify | never without your click on **Send**; the form shows the payload first |
| Update check | no toggle (GET, no payload); notify-only |
| Update download | never without your click + a verifiable signature |
| Model weights download | never without your click |
| Microsoft connector | never unless connected |
| Checkout | hidden unless `PAID_ENABLED=1`; fires only on your click |

There is no telemetry row because there is no telemetry: nothing ambient is
left to disable. The in-app **egress panel** (the header shield) and the
**local audit log** (§9) let you verify this live — the panel shows every
host each answer dialed, and the audit record keeps the per-question delta.

*Related: `README.md` §Network & privacy · `docs/signing.md` ·
`docs/ts-twin.md` · `docs/managed-deployment.md` (managed policy + offline
activation) · `docs/edr-whitelisting.md`.*
