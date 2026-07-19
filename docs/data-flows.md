# Data flows — every network touchpoint, for a security review

*This document enumerates every outbound network call the shipped Lighthouse
app can make: the destination, what triggers it, exactly what data it
carries, and how to turn it off. It is written to be checked against the
code — file references are given throughout. Scope: the shipping Rust engine
(`native/`); the TypeScript twin (`src/server/`, dev-only — see
`docs/ts-twin.md`) mirrors the same hosts but does not ship.*

**The baseline claim, stated precisely:** Lighthouse has **no accounts, no
licensing, no backend of its own, and no telemetry**. There is no usage
telemetry, no click capture, no launch ping, no funnel events, no
license/trial check, and no A/B experiment machinery — and there is no
Supabase host, no `LICENSE_API_URL`, and no license/checkout module in
either engine. All of it is **deleted from the code, not merely disabled**;
a reviewer will find no code path that emits any of it.

The only bytes that ever leave the machine on Lighthouse's **own** behalf
fall into **exactly three kinds, every one of them user-initiated**:

1. **The cloud AI provider you configured** (§1) — the only path that can
   carry document content. With the **local model** selected (or no provider
   configured), answering a question makes **zero** network calls.
2. **An update check** (§2) — an unauthenticated GET to the GitHub releases
   API that carries **no payload**.
3. **Pinned asset downloads you click** (§3) — an app update (signature-
   verified before it runs) or the private-model weights. Nothing here fires
   without your click.

There are **two further user-initiated flows that are not app egress at
all** (§4): the **Send feedback** dialog composes a report locally and hands
it to **your own mail client** (a `mailto:`) or **your own browser** (a
prefilled, public GitHub issue). Lighthouse opens no socket for either — the
bytes travel only if *you* press Send in the app your OS opens for you.

One capability is **present in code but not reachable from the shipping UI**
(§5): the Microsoft 365 / SharePoint connector. The file explorer shows
SharePoint as **"Coming soon"** and never calls its backend, so it is **not
a live egress today**. It is documented here for completeness, not counted
among the three.

That is the whole list.

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

**Provider sign-in (inert by default).** The code also carries a generic,
standards-based sign-in flow (OAuth 2.0 device authorization, RFC 8628) as
an alternative to pasting an OpenAI API key
(`native/crates/lighthouse-core/src/provider_auth.rs`) — but it ships with
**no endpoints and no client id configured**, so a stock build makes **zero
auth-related calls** and shows **no sign-in control** (the same fail-closed
pattern as the updater's signing key). Every identifier — a public-client
id, the device-authorization endpoint, the token endpoint, and the API
base — must be supplied by the maintainer, at build or run time, **after
registering this application with the vendor**; nothing vendor-specific is
embedded as a default, and any of the four missing keeps the whole surface
answering "unavailable". Only in a build a maintainer has configured does
the egress become: the **configured auth host** (sign-in + token refresh —
carries the client id and OAuth codes/tokens, **never document content or
file names**; ledger purpose `Provider sign-in`), and the **configured API
base** (signed-in asks — the same request and payload class as the table
above, with a bearer token in place of the key; ledger purpose
`Signed-in ask`). The granted tokens live in the same encrypted
install-global secrets store as API keys, and sign-out deletes them.

## 2. Update check — GitHub releases API (notify-only)

`GET https://api.github.com/repos/lmansf/lighthouse/releases/latest` at boot
and every 6 h (`native/crates/lighthouse-desktop/src/supervise.rs`
`check_for_updates`, scheduled from `main.rs` on a `6 * 60 * 60`-second
loop). Unauthenticated; user-agent `lighthouse-app`; **no query, no body, no
payload** — a plain GET. The response's `tag_name` is compared to the
running version; a newer tag only **arms a banner/tray notice**. There is no
toggle because there is nothing to carry and nothing is downloaded here — it
is notify-only. Recorded in the in-app egress ledger as `Update check`
(`lighthouse-core::egress`).

## 3. Pinned asset downloads you click — updates & model weights

Both members are **click-gated**: neither is fetched at launch or in the
background.

**3a. App update download — GitHub (signature-verified).** Only on your
click, and only in builds carrying the updater public key against a release
carrying a minisign `.sig`. The installer and its signature download from
`github.com/lmansf/lighthouse/releases/download/…` (302 →
`*.githubusercontent.com`), and the artifact is **verified against the
signature before anything executes** (`lighthouse-core::updates`, driven
from `supervise.rs`). Payload: none (GETs). An unsigned build or release: the
button opens the releases page in your browser instead — **the app never
installs what it cannot verify.**

**3b. Private-model weights — Hugging Face (opt-in, one-time).** Clicking
**＋** on "Local model (private)" downloads Mistral-7B-Instruct-v0.3 Q4_K_M
(~4.2 GB) from a **pinned** URL on `huggingface.co` (302 → HF CDN), streamed
to your user-data dir (`native/crates/lighthouse-core/src/local_model.rs`).
Payload: none (GET, UA `lighthouse-app`). **Integrity, stated honestly:** the
URL is pinned to a specific repo/file/quant, and the stream is accepted only
when the full `Content-Length` arrives (written to a `.part`, renamed on
completion) — this is a **completeness check, not a signature check**; the
runtime weights fetch is **not** hash-verified in-app. (The SHA-256 pinning
described in §7 covers the **build-time** bundled-asset fetch, not this
runtime download.) Never fires unless you click install; override the URL
with `LIGHTHOUSE_LOCAL_MODEL_URL`. The embedding/OCR models and the
llama-server binary are **bundled in the installer** — nothing is
fetched for them at runtime.

## 4. Feedback & bug reports — zero-backend handoff (NOT app egress)

The **Send feedback** dialog makes **no network request of its own**. It
composes a report **locally** and offers two hand-offs you complete in
another app (`src/features/feedback/BugReport.tsx`; the URL builders live in
`src/lib/feedbackLinks.ts` and are unit-pinned in
`test/feedbackLinks.test.mjs`):

- **Email us** → a `mailto:lmansf96@gmail.com` opened in **your** mail
  client with subject + body prefilled (`buildFeedbackMailto`).
- **Open a GitHub issue** → `https://github.com/lmansf/lighthouse/issues/new`
  `?title=…&body=…&labels=feedback` opened in **your** browser
  (`buildFeedbackIssueUrl`). The dialog states, **before** you click, that
  **GitHub issues are public.**

What the body can contain, exhaustively: the message you typed, an optional
"where in the app?" note, the app version, and a coarse OS label
(`Windows`/`macOS`/`Linux`). **Never** an account id, email, file, file
name, or file content — there are no accounts, and nothing reads the vault.
Optionally, if you tick the **off-by-default** checkbox, a **shell.log
excerpt** is appended: the dialog **renders the full excerpt for you to read
first**, and the URL builders embed only a bounded tail
(`LOG_URL_CAP = 3000`) so the hand-off can never produce a pathological URL
(you can paste the rest yourself). That excerpt is fetched lazily from a
**read-only** `GET /api/diagnostics` (`app/api/diagnostics/route.ts`) which
returns `{version, os, log}` and **makes no network request**; on the web
build there is no shell.log and it returns `log: ""`.

Because the app transmits nothing here, there is **no host to allowlist and
no switch to flip** — declining is simply not pressing Email/Open, or not
opening the dialog.

## 5. Microsoft 365 / SharePoint connector — present in code, NOT reachable in the UI

A device-code OAuth + Microsoft Graph connector still exists in the tree
(`native/crates/lighthouse-core/src/sources/`, route `POST /api/connect`,
store action `connectSharePoint`), but **the shipping UI does not expose
it.** In the file explorer the SharePoint entry is a **"Coming soon"** badge
whose click runs `registerInterest(...)` — a local green thank-you note on a
timer, explicitly *"without running any real connector flow and without
recording anything"* (`src/features/explorer/FileExplorer.tsx`). It **never
calls `/api/connect`**, mints no token, and dials no Microsoft host.

So today it is a **dormant capability, not a live egress** — present in
code, disabled in UI. (Were it ever wired up, its direction is inbound-only:
it lists and downloads *your* files into a local mirror and uploads no vault
content; the bearer token is sent only to Graph hosts, guarded in code, and
disconnect drops the tokens and mirror.) It is described here so a reviewer
who greps `graph.microsoft.com` / `login.microsoftonline.com` and finds the
code knows why it is inert — it is neither a live egress nor deleted.

## 6. Loopback & in-process — NOT egress

For completeness, the on-device services (127.0.0.1 only, no external
sockets): the chat llama-server (`:8080`), the embedding server (`:8091`),
Whisper dictation / OCR (in-process or child processes with no
sockets), and the dev-mode embedded API server. In the shipped bundle the
UI talks to the engine over **Tauri IPC — no TCP port at all**.

PDF table reconstruction (`pdf_tables.rs`, add-pdf-tables) is likewise
in-process and offline: it reads a PDF's own text-layer glyph positions and
rebuilds any confident grid as markdown appended to the extracted text — pure
geometry, no model, no network. Reconstructed tables ride the same on-device
extraction/retrieval path as OCR text; nothing about them touches egress.

Quantitative depth (`recipes.rs`, `insights.rs`, add-quant-depth) is
computation, not a new destination. The `forecast` and `changepoint-scan`
recipes are guarded SQL over DataFusion — every number is engine-computed
on-device; they egress only what any recipe narration does (the result cards
handed to the configured model, exactly as the existing recipes, and NOTHING
when the model is local/extractive). Proactive **insights** (`insights::scan`,
the "what stands out" surface) run those cheap detectors over the cataloged
tables with **no model in the loop at all** — the headlines are templated from
engine numbers — so a scan is pure on-device SQL and touches egress **not at
all**. No new network path; the band chart the forecast draws rides inline in
the answer markdown like every other chart.

Deep analysis (`reports.rs` `investigate`, add-deep-analysis) is the same
posture at a larger grain. "Investigate {table}" runs the applicable recipe
battery — those same guarded DataFusion SELECTs — and assembles the VERIFIED
results into a report that is **written into the vault** through the
write-artifact allowlist (`vault::write_artifact`, the briefing/export note
precedent): a sanitized, traversal-safe, never-overwrite **local file write**,
never a network destination. The deterministic core uses **no model**, so it
egresses **not at all**; the optional prose intro (off by default) would egress
exactly as any recipe narration does and supplies no number. The **capability
map** (`meta::capability_map`) is pure aggregation of the already-posture-gated
`applicable_*` surfaces — it introduces no analysis and no network path, and a
cloud posture drops a local-only table from the map just as it drops it from
every other surface.

## 7. Build/CI-time only — never in the shipped app

`scripts/fetch-local-model.mjs` (build machines): llama.cpp GitHub
releases, the HF-hosted embedding model and the ocrs S3 bucket — all via
the repo's own mirror first (`github.com/lmansf/lighthouse` release
`hf-assets-1`), version-pinned and SHA-256-verified fail-closed. This is the
only place a SHA-256 is pinned; it protects the **bundled** assets baked into
the installer, not the runtime weights download of §3b.

## 8. Local audit log — written locally, NOT egress

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

The **headless entry points** — the `lighthouse` CLI (`ask`) and the
`lighthouse-mcp` server (`ask_vault`) — answer through the SAME
`ask::run_headless_ask` chokepoint the app uses (openspec: add-automation), so a
scripted or MCP-driven ask is recorded here identically: one audit record with
the file ids read, the provider, and the per-question egress delta. There is no
new egress path — a `--local`/local-only ask (and every `list` /
`run_analytics_sql` read) stays on-device, and the CLI's `export` is a
non-egress in-vault write.

## Redirect / effective hosts (for allowlisting)

`github.com` + `api.github.com` → `objects.githubusercontent.com` /
`release-assets.githubusercontent.com`; `huggingface.co` → `cdn-lfs*.
huggingface.co` / `cas-bridge.xethub.hf.co`; ocrs models →
`ocrs-models.s3-accelerate.amazonaws.com` (build-time only).

## Disable matrix (today)

| Egress | Lever |
|---|---|
| Cloud AI (the only content path) | choose Local/no provider; don't store a key — or managed policy `allowedProviders`/`forceLocalOnly` (org-wide, engine-enforced) |
| Update check | no toggle (GET, no payload); notify-only |
| Update download | never without your click **and** a verifiable signature |
| Model-weights download | never without your click (pinned URL; override via `LIGHTHOUSE_LOCAL_MODEL_URL`) |
| Feedback / bug report | **not app egress** — the app sends nothing; you hand off via your own mail client or browser, and the dialog shows the full payload first |
| Microsoft 365 / SharePoint connector | **not reachable** in the shipping UI ("Coming soon"); backend present but never invoked |

There is no telemetry row and no license/checkout row because there is no
telemetry, no license check, and no checkout: nothing ambient is left to
disable, and the code that once did these was removed, not toggled off. The
in-app **egress panel** (the header shield) and the **local audit log** (§8)
let you verify this live — the panel shows every host each answer dialed, and
the audit record keeps the per-question delta.

## Decision record — if paid ever returns

If a paid tier ever comes back, it returns as **offline, signed license
files plus a Stripe payment link** — **no accounts, no Supabase, no
telemetry, and no backend of our own.** Activation would verify a signed
license file **locally** (a signature check over a file the user drops in,
nothing dialed out), and payment would be a hosted **Stripe link the user
opens in their own browser** — never a checkout the app calls server-side.
This is a deliberate constraint, recorded so that any future change reaching
for a hosted license, checkout, or telemetry backend is recognized as a
**reversal of policy**, not an implementation detail that slipped in.

## Naming debt (so a reviewer isn't misled)

Two identifiers still read `rag-vault`, kept for **upgrade safety**, not
because any "rag-vault" service exists anywhere:

- the **npm package name** (`package.json` → `"name": "rag-vault"`), and
- the **per-vault state directory** (`.rag-vault/`, which holds the index,
  settings, and trash beside your files).

Renaming either would strand the state of existing installs, so the names
stay. The shipping desktop app's **app-data directory is `com.lighthouse.app`**
— historically derived from the Tauri identifier of the same name, and since
0.12.8 **pinned** to that path even though the identifier itself became
`app.lhvault` (`native/crates/lighthouse-desktop/tauri.conf.json`), so the
rename moved no existing user's settings, sealed keys, or models. It is **not**
derived from `rag-vault` — that string is a historical package/dir name, not a
network endpoint or an account namespace.

*Related: `README.md` §Network & privacy · `docs/signing.md` ·
`docs/ts-twin.md` · `docs/managed-deployment.md` (managed policy) ·
`docs/edr-whitelisting.md`.*
