# Lighthouse — retrospective, adversarial analysis & two-persona roadmap

*Written 2026-07-14, covering PRs #1–#142 (0.1.0 → 0.11.0). Companion docs:
[rewrite-scope.md](rewrite-scope.md), [analytics-genie.md](analytics-genie.md),
[security-fixes.md](security-fixes.md).*

This document does four things:

1. Summarizes everything that has shipped since the beginning of the repo.
2. **Adversarial analysis** — identifies the steps along the way that actually
   *hindered* the product's goals, with the cost each one carried.
3. Maps the shipped feature set onto the two target demographics — the **data
   analyst** and the **IT security director** — including what's missing and
   what's falling short for each.
4. Lays out a **game plan**, and for each workstream a **ready-to-run prompt**
   written in the house style (OpenSpec where featureful, verification gates
   named, parity rules stated) so each update can be started as its own session.

---

## 1. What has been built (six arcs)

| Arc | PRs | Dates | What shipped |
|---|---|---|---|
| **1. Local-first MVP** | #1–#50 | Jun 27–29 | Real vault backend (default-excluded inclusion, ancestor-exclusion wins), upload + link-in-place, Electron shell + installers + double-click launchers, PDF/DOCX/XLSX extraction, trial licensing (Supabase Edge Fn), SharePoint/OneDrive connector (device-code OAuth), conversational chat + attachments, local model provider, structured grounded prompt with `[n]` citations, Markdown answers, renderer CSP |
| **2. Polish, brand & model churn** | #51–#75 | Jun 30–Jul 1 | Usage click telemetry, Forerunner steel/blue reskin (replacing the sandy-beach theme), branded NSIS installer, A/B experiments end-to-end, bundled model churn (Qwen → SmolLM2 → Mistral-7B), Piper neural TTS, model demoted to opt-in 4.2 GB download after the 2 GB installer-cap failure, sidebar water animation, Converse placeholder, `/api/profile` recursion release-breaker + fix |
| **3. Security remediation & release plumbing** | #76–#91 | Jul 2–4 | 43-finding multi-agent security review remediated: loopback bind + per-launch token + DNS-rebinding defense, telemetry flipped opt-out→**opt-in** and file-name PII removed, 0600 atomic writes, tokens moved out of the vault, license fail-closed, supply-chain pin + SHA-256 fail-closed fetches, signing *scaffolding* (still unsigned), notify-only auto-updater, CI check gates; also the self-inflicted v0.2.4→v0.2.5 same-origin 403 regression and two lockfile CI breaks |
| **4. Native rewrite** | #92–#102 | Jul 5 | Full Rust engine (`lighthouse-core`) + Tauri 2 shell + IPC transport, **no local TCP port**, persistent incremental index + FS watcher (10k files: 276 ms cold / 128 ms warm), state-compatible with `.rag-vault/`; Electron and the TS engine kept in-tree |
| **5. Widget / Whisper era** | #103–#115 | Jul 5–7 | Desktop search-bar widget, Whisper mode (modifier-only summon via per-platform keyboard hook / event monitor / raw input), inline widget answers, safe mode for a machine-freezing launch, ~11 patch releases of platform fixes (focus stealing, z-order, Wayland), persistent chat history (opt-in) |
| **6. Analyst platform** | #116–#142 | Jul 8–14 | **Genie analytics** (NL→SQL over CSV/TSV/Parquet/XLSX via DataFusion; schema-only to the model; read-only single-SELECT guard; SQL + freshness shown), hybrid semantic search (bundled nomic embeddings + RRF), multi-doc synthesis, GPU local model, six AI providers, **Genie v2** (refinement chips + Edit SQL, save-as-CSV/PNG/note artifacts, multi-step analytics, pinned questions with watcher rechecks, union tables + join hints + column catalog, vault meta-answers + suggested asks, Excel header/date hardening), performance pass, virtualized tree, PPTX/ODF/RTF extraction, **on-device OCR** (images + scanned PDFs), asset self-mirroring after HF CDN outages, session persistence + sealed API-key store |

The through-line: the product found its two real audiences mid-flight. Arcs 1–2
built a general "private ChatGPT for your files"; arc 3 earned the right to
say *private*; arc 4 earned *fast*; arcs 5–6 split the value proposition into
the two personas this document plans for.

---

## 2. Adversarial analysis — steps that hindered the goals

Goals, as evidenced by the repo itself: **(a)** a *trustworthy* local-first
product a governance-conscious buyer can approve, **(b)** *analyst-speed*
answers over one's own files, **(c)** a sellable $14.99/mo product, **(d)**
sustainable shipping velocity.

### 2.1 The destructive-by-design first trial (#12) — against goal (a)

The first licensing implementation **reset the user's filesystem** on trial
expiry. It was replaced within days by the non-destructive lock (#14), but it
shipped in-tree first: the single most trust-destroying behavior a vault
product can have existed as the design intent. Residual cost today: the
licensing subsystem still carries three modes plus wipe-adjacent code paths
that every security review must re-clear.

### 2.2 Telemetry that contradicted the pitch (#19, #52) — against (a)

Click events keyed to **email + contact id**, with **file/folder names** in
the payload, captured **opt-out**, labeled "anonymous." This is the exact
opposite of the product's one-liner, and it ran in shipped builds until the
Jul 2 remediation flipped it to opt-in, coarse-kinds-only (#76). The Supabase
audit found 0 rows accumulated — lucky, not designed. Residual cost: an
"Experiments" leaderboard dialog still ships in a privacy product, and the
A/B assignment plumbing (server-balanced variants) remains a per-launch cloud
touchpoint that the security persona has to be talked through.

### 2.3 Bundled-model churn and the broken public installer (#45→#56→#70→#72) — against (c), (d)

Three different bundled models in five days (Qwen → SmolLM2 → Mistral-7B),
culminating in a 4.2 GB bundle attempt that silently exceeded NSIS's and
GitHub's 2 GB caps and **published a broken 270 MB installer**. The final
design (engine bundled, weights as an opt-in verified download) is right — but
it burned four releases, a public broken artifact, and produced the
`.gguf`-exclusion guard (#73) that exists to protect against the mistake
recurring. Lesson worth encoding: any decision that changes artifact size by
GBs needs a pipeline dry-run before a version bump.

### 2.4 Brand/theme churn + decorative work against later goals (#22→#53, #58) — against (d)

Sandy-beach (WCAG-checked) shipped Jun 28; the Forerunner steel reskin
replaced it Jun 30; the README *still describes the sandy-beach theme* — the
front door of the repo misdescribes the product. The sidebar **water
animation** (#58) is pure decoration that directly opposes two later
efforts the repo paid real engineering for: the 0.7.2 background
power-conserve work and the 0.8.0 performance pass. Idle animation in a tray
app is the kind of thing the 0.8.0 audit exists to hunt.

### 2.5 The Widget/Whisper detour: high burn, wrong sequencing (#103–#115, #123–#126) — against (d), partially (a)

The widget is genuinely differentiating for the analyst ("ask without leaving
your document"). But it consumed **~12 releases** of platform-specific
firefighting (Windows focus theft, Wayland fallbacks, z-order, safe-mode traps
for a machine-freezing launch) in the same weeks the analytics engine — the
actual moat — hadn't started. And **Whisper mode is implemented as a global
keyboard hook / raw-input listener**: in an *unsigned* binary, that is the
behavioral signature EDR products flag as keylogging. We built the one feature
most likely to get the app quarantined by the IT department we want to sell
to, before signing the binary. (It is opt-in, which saves it — but the optics
need managing; see workstream S4.)

### 2.6 Six cloud providers without a policy layer (#128) — against (a)

Adding OpenAI/Gemini/Grok/Mistral/DeepSeek serves analyst choice, but each is
a new egress path the security director must assess, and **DeepSeek in
particular is a hard policy flag in many orgs**. There is no org-level control
to pin the provider set (e.g., "local only," "Anthropic only"), so the privacy
product's data-flow story is now "whatever each user picked." The feature
isn't wrong; shipping it *without the admin policy counterpart* inverted the
trust story for the harder persona.

### 2.7 The permanent dual-engine tax (#92 onward) — against (d)

The rewrite kept the TS engine as a "twin," and the shipped feature set has
since diverged: analytics, embeddings, OCR, pins are Rust-only with `PARITY`
stubs (18+ markers across both trees). Every retrieval change must land twice,
byte-identical prompts and all. Meanwhile the **Electron shell, the Next
server, and `release.yml` are all still in-tree** — and `release.yml` **still
triggers on every `v*` tag**, building legacy Electron installers into a draft
release alongside the real (manual-dispatch) Tauri pipeline. That is wasted CI
on every release and a live risk of publishing the wrong artifact. The twin
was the right *migration* tool; three weeks post-cutover it is pure drag.

### 2.8 Release-pipeline fragility discovered in production (#61, #90–#91, #94, #118–#121, #136–#137, #141) — against (d)

Roughly **ten PRs exist only to un-break releases**: two lockfile
regenerations, four Linux AppImage attempts, an icns miss, an installer
narration fix, a settings-write build break, and three consecutive releases
blocked by Hugging Face CDN 403s before the asset-mirror workflows landed.
The mirrors and asset-digest gates were the right fixes and now exist — but
each arrived only after a blocked release. The pattern to break: platform and
supply-chain assumptions get validated *at release time* rather than per-PR.

### 2.9 Monetization built early, still switched off — against (c)

Trial + Stripe + Supabase licensing landed in week one; `PAID_ENABLED=0` to
this day, and the trial is **infinitely repeatable** — which trains every
early user that Lighthouse is free. The licensing code has already cost a
forgery-class security finding (#76), edge-function deploy coordination, and
review surface on every audit. Either the paid gate should open (with a real
trial policy) or the surface should shrink until it can.

### 2.10 Self-inflicted hardening regressions (#81, #141) — against (d)

v0.2.4's loopback hardening 403'd **every mutating request** in the shipped
build (fixed in v0.2.5); the OCR settings-write miss broke all three platform
builds. Both were caught by users/CI rather than by a pre-release smoke.
The gates have improved steadily (check job, native.yml, asset digests,
retrieval-eval floors) — the remaining hole is a **cross-platform boot smoke
on the release branch** before any tag is cut.

### Verdict

None of these were fatal, and several were honestly self-corrected (telemetry,
destructive trial, model bundling). The recurring failure mode is **sequencing
against the persona**: demo-visible work (themes, water, widget, six
providers) repeatedly jumped ahead of trust-critical work (signing, policy
controls, pipeline hardening) that the actual buyers gate on.

---

## 3. Persona mapping

### 3.1 The data analyst — what already lands

| Need | Shipped answer |
|---|---|
| Trustworthy numbers | Genie: model writes one SELECT, DataFusion executes, model narrates the **verified** result; SQL shown verbatim; freshness footer ("computed from *file*, saved N ago") |
| Iteration speed | Refinement chips (Top 10 · Monthly · As %), **Edit SQL** (guarded re-run, no model), conversational refinement seeded with the prior query |
| Real-world data shape | Union groups (`sales-2025-*.csv` = one table), join hints, column catalog, Excel true-header detection + ISO dates, structure-aware chunking (header on every chunk) |
| Deeper questions | Multi-step analytics (up to 3 chained queries on remote models), multi-doc synthesis, whole-document answers, semantic + lexical hybrid retrieval |
| Artifacts | Save result as CSV into the vault (compounds into new input), chart→PNG, chat→vault note, copy-as-CSV |
| Recurring questions | Pinned questions: watcher re-runs stored SQL deterministically, alerts on change |
| Zero-friction ask | Widget summon + dictation, suggested asks, vault meta-answers ("what's new this week?"), session persistence |
| Messy corpora | PDF/DOCX/XLSX/PPTX/ODF/RTF extraction, `.doc` salvage, **on-device OCR** of screenshots and scanned PDFs |

**Where it falls short for the analyst:**

- **Local-model answer latency** (~1 min/answer CPU) makes the *private* path
  feel broken for interactive analysis; GPU offload exists but isn't the
  guided default, and there is no fast-draft tier.
- **PDF tables** — the format analysts live in — are explicitly designed-but-
  deferred; a financial report PDF today contributes prose only.
- **Charts are bar/line only**, and pinned-question alerts show a text digest
  with no before/after visual.
- Pins alert **inside the app only** — there is no morning-briefing digest;
  the "taps you on the shoulder" pitch stops at a banner you must be looking at.
- No way to see/query **across conversations** ("what did I conclude last
  week?") even though notes export exists.

### 3.2 The IT security director — what already lands

| Need | Shipped answer |
|---|---|
| Data boundary | On-device engine, **no local TCP port** (Tauri IPC), local LLM/embeddings/OCR/TTS, extractive no-network fallback |
| Least privilege | Default-excluded corpus, ancestor-exclusion wins, per-question attachment scoping, non-destructive remove-to-trash |
| Query safety | Read-only single-SELECT SQL guard (DML/DDL rejected pre-execution), bounded execution, prompt-injection fencing of retrieved context |
| At-rest hygiene | 0600 atomic+fsync state writes, sealed API-key store (AES-256-GCM, honest threat-model note), OAuth tokens outside the vault, path-escape guards |
| Consent | Telemetry **opt-in** and coarse-only, chat history opt-in, explicit per-file visibility |
| Supply chain | Pinned SHA-256 fail-closed asset fetches, self-mirrored release assets, asset-digest record/verify CI, license/attribution documented |
| Track record | `security-fixes.md` — a public, severity-rated remediation log |

**Where it falls short for the security director:**

1. **Unsigned installers** — SmartScreen/Gatekeeper warnings on first launch;
   the #1 deferred item since Jul 2 and the first thing a pilot deployment hits.
2. **No admin policy layer** — provider allowlist, force-local-only,
   telemetry hard-off, widget/hotkey disable, vault-root restrictions: none
   are deployable org-wide; every control is a per-user toggle.
3. **No audit trail** — the product can't answer "what did the AI read, and
   what left the machine, and when" — the exact question a security review asks.
4. Keys sealed **beside their sealing key** (documented honestly) — the OS
   keychain upgrade is designed-for but not done.
5. **No SBOM / vuln-response process** — 945 npm packages + a Rust tree, one
   `xlsx` dependency fetched from a vendor CDN tarball, no published
   disclosure policy.
6. **Whisper-mode optics** — a global keyboard hook in an unsigned binary is
   EDR-bait, and there is no doc a security team can whitelist against.
7. **Licensing phone-home** is undocumented as a data flow, and there is no
   offline/air-gapped activation story.

---

## 4. Game plan

Sequenced in three waves. Wave 1 removes the deployment blockers and the drag;
it makes the other two waves land in a product a buyer can install. Waves 2–3
then deepen each persona's core loop. Each workstream cites the prompt
(§5) that starts it.

### Wave 1 — Foundation (both personas)

| # | Workstream | Why now |
|---|---|---|
| F1 | **Sign & notarize everything**; flip updater to verified auto-install (Phase B of the existing design) | Single highest-leverage trust item; unblocks S4 optics and every pilot install |
| F2 | **Retire the legacy surfaces**: delete the Electron shell + `release.yml` (or archive to a branch), stop the tag-triggered legacy build; demote the TS engine to a explicitly-scoped dev twin with a generated parity suite | Ends the double-landing tax and the wrong-artifact risk before new features widen the divergence |
| F3 | **Release-branch boot smoke**: per-PR cross-platform build + launch + one-question smoke (the 0.2.5/0.10.0 class of regressions dies here) | Stops production-discovered breakage |
| F4 | **Truth pass on docs/brand**: README theme/claims, rag-vault→lighthouse naming debt, document every network touchpoint in one place | The repo front door currently misdescribes the product |

### Wave 2 — IT security director

| # | Workstream | What ships |
|---|---|---|
| S1 | **Policy layer** | Admin-deployable policy file (MDM/GPO-distributable): provider allowlist, force-local-only, telemetry/history hard-off, widget+hotkey disable, vault-root allowlist, OCR toggle. UI shows "managed by your organization" state |
| S2 | **Local audit log** | Tamper-evident, local-only JSONL: per question — files read, provider used, egress (yes/no + host), artifacts written. Exportable CSV. Off by default, one policy switch on |
| S3 | **Egress transparency panel** | Live per-session "what left this machine" view (none / provider / license check), turning the architectural claim into a visible, demoable feature |
| S4 | **Keychain + supply-chain pack** | OS-keychain key storage behind the existing secrets API; CycloneDX SBOM per release; `cargo audit`/`npm audit` CI gates; SECURITY.md disclosure policy; a one-page EDR-whitelisting doc for the Whisper hook |
| S5 | **Deployment story** | Offline/air-gapped activation (signed license file), documented licensing data-flow, silent-install flags for the NSIS installer |

### Wave 3 — Data analyst

| # | Workstream | What ships |
|---|---|---|
| A1 | **Fast private answers** | Guided GPU offload (detect + default-on with VRAM check), optional small fast-draft model tier, target: first token < 5 s local |
| A2 | **PDF tables** | The designed-but-deferred extractor: detect tabular regions in text-layer PDFs, emit header-carrying rows into the existing tabular chunking + analytics registration |
| A3 | **Briefings** | Pinned questions grow a scheduled digest: on vault change or a daily time, write/refresh a "Lighthouse Briefing" note in the vault + one OS notification. Before/after mini-charts per changed pin |
| A4 | **Richer results** | Chart kinds (stacked bar, area, scatter), number/date axis formatting, pin-diff visualization; result tables sortable in-chat |
| A5 | **Cross-conversation memory** | Exported notes become first-class: auto-index chat notes, "what did I conclude about X?" retrieves prior conclusions with links back to the conversation |

### Monetization checkpoint (after F1 + S1)

Decide the trial policy (repeatable → one trial + grace), open `PAID_ENABLED`
behind a launch checklist, and add seat/team management — the "several
subscriptions under one card" story currently has no admin surface. Gate: do
not open paid while installers are unsigned.

---

## 5. Ready-to-run prompts

One prompt per workstream, in the house style: scope pinned, non-goals pinned,
engines named, gates named. Feature-sized ones should flow through OpenSpec
(`openspec/changes/`) per repo convention; fix/chore-sized ones go straight to
a PR. Each is self-contained — paste it into a fresh session.

### F1 — Signing & verified updates

> Set up code signing and notarization for Lighthouse's desktop releases, then
> flip the updater to Phase B per `docs/auto-updater-design.md`. Scope: (1)
> `desktop-release.yml` — integrate Windows Authenticode signing (prefer a
> cloud/HSM signing service over a raw cert-in-CI; document the choice and
> key-custody model in `docs/auto-updater-design.md` §3) and macOS
> Developer-ID signing + notarization using the existing entitlements/notarize
> scaffolding; keep unsigned builds working when secrets are absent (current
> conditional-env pattern). (2) Tauri updater: enable the signed-manifest
> update flow (tauri-plugin-updater keys, manifest generation in CI), replace
> the notify-only check in the shell with download+verify+install-on-consent,
> and keep notify-only as the fallback when the manifest key is absent. (3)
> Update `docs/launch-copy.md`'s unsigned-builds caveat and README. Non-goals:
> no store distribution (MS Store/Homebrew), no license changes. Gates: a
> dispatch of `desktop-release` on all three platforms producing
> signed/notarized artifacts (verify with `signtool verify`, `spctl -a`,
> and AppImage signature); an end-to-end update test from a previous signed
> build; secrets documented in the workflow header but never echoed. Tell me
> which certificates/accounts you need me to provision and stub the workflow
> so it fails closed until they exist.

### F2 — Retire the legacy Electron surface & scope the TS twin

> Remove the retired Electron distribution path from Lighthouse and make the
> TS engine's dev-twin role explicit. The shipping product is the Tauri shell
> (`native/`) since 0.3.0; `electron/`, the Electron deps in `package.json`,
> and `.github/workflows/release.yml` (which still triggers on every `v*` tag
> and builds legacy installers) remain in-tree. Scope: (1) delete `electron/`,
> `release.yml`, electron/electron-builder/electron-updater deps and the
> `electron`/`dist`/`dist:nomodel`/`release` npm scripts — first archive the
> current state on a branch `archive/electron-shell` so nothing is lost; keep
> `Lighthouse.cmd`/`Lighthouse.command` working by pointing them at the web
> dev server or removing them with a README note (decide and justify). (2)
> Audit `package.json` `build` config and `scripts/` for now-dead references
> (electron-builder config block, notarize.cjs is shared — check what
> `desktop-release.yml` actually uses and keep only that). (3) Write
> `docs/ts-twin.md`: what the TS engine is for (web dev + parity oracle),
> the PARITY rules, and the canonical list of Rust-only capabilities
> (analytics, embeddings, OCR, pins background scheduler). (4) Sweep the 18+
> `PARITY` markers and verify each still states the true divergence. Non-goals:
> do not delete the TS engine or the Next server (the web dev flow stays);
> no behavior changes in the Rust engine. Gates: `npm run test` green,
> `native.yml` suite green, a dispatch dry-run of `desktop-release.yml`
> unaffected, `git grep -i electron` returns only docs/history references,
> and README's Run-it section matches reality.

### F3 — Pre-tag release smoke

> Add a cross-platform boot-smoke gate to Lighthouse's release pipeline so
> regressions like v0.2.5's same-origin 403 (every mutation broken in a
> shipped build) and 0.10.0's `ocr_enabled` compile break die before a tag.
> Scope: a new `release-smoke.yml` (and a job reused inside
> `desktop-release.yml`) that on all three OS runners: builds the real bundle
> (`build-ui-static` + `cargo build --release -p lighthouse-desktop`),
> launches the built app headlessly (Xvfb on Linux — follow the existing
> Xvfb+openbox patterns from the 0.4.x work), drives one end-to-end pass via
> the existing test seams: create a temp vault with a fixture file, include
> it, ask a question against the extractive fallback (no network, no model
> download), assert a grounded answer with a reference arrives on the IPC
> transport, then exits clean. Also assert the settings round-trip
> (write/read every field of the settings struct) so a missing field is a CI
> failure, not a field report. Non-goals: no model downloads in CI, no
> licensing-server calls (use the disabled mode), no new test framework.
> Gates: the smoke fails on a deliberately-broken settings write (prove it by
> reverting #141's fix locally), runs under 10 minutes per OS, and
> `desktop-release.yml` refuses to attach bundles unless the smoke passed for
> the same ref.

### F4 — Documentation & brand truth pass

> Bring Lighthouse's front-door docs back in line with the shipped product.
> Known drift: README describes the retired sandy-beach theme (the app has
> been Forerunner steel/blue since #53) and leads with the from-source
> Electron launchers; the npm package/userData dir is still `rag-vault`
> (renaming userData breaks upgrades — document rather than rename, or write
> a migration; decide with evidence from `app_state_dir()` usage);
> `docs/desktop.md` and `docs/ARCHITECTURE.md` predate the Tauri cutover.
> Scope: (1) rewrite README's descriptions (theme line, Run-it section,
> Architecture pointers, Status section) to match 0.11.0 reality, keeping the
> honest tone. (2) Add a **"Network touchpoints"** section to README or a new
> `docs/data-flows.md`: enumerate every egress the app can make (chosen cloud
> provider, license/trial check, telemetry when opted in, model/asset
> downloads, update check) with when it fires and what it carries — this doc
> is for a security reviewer. (3) Fix stale claims in `docs/desktop.md` /
> `ARCHITECTURE.md` or stamp them with an "Electron-era, see native/" header.
> Non-goals: no code changes except comment/doc strings; no rename of the npm
> package in this pass. Gates: every claim in README verifiable against the
> tree (spot-check by grepping the referenced files); `docs/data-flows.md`
> lists at minimum the six provider hosts, the Supabase function URL, the
> GitHub releases feed, and HF/mirror asset hosts.

### S1 — Managed policy layer

> Propose (OpenSpec: `add-managed-policy`) and implement an org-deployable
> policy layer for Lighthouse, aimed at IT administrators. A policy file —
> `policy.json` in a fixed machine-scope path per OS (`/etc/lighthouse/`,
> `%ProgramData%\Lighthouse\`, `/Library/Application Support/Lighthouse/`) —
> read-only to the app, overriding user preferences where set. V1 keys:
> `allowedProviders` (subset of the seven, e.g. `["local"]`),
> `forceLocalOnly` (bool, hides + blocks cloud providers), `telemetry`
> (`"off"` hard-locks opt-out), `chatHistory` (`"off"`), `widgetHotkeys`
> (`"off"` disables the summon hook entirely — never installs the keyboard
> hook), `ocr` (`"off"`), `vaultRoots` (allowlist of path prefixes for vault
> location + linked folders). Engine: policy loads once in
> `lighthouse-core::config`, exposed via a `policy` op on `/api/rag` +
> commands; every enforcement point rejects server-side (not just UI). UI:
> affected controls show a "Managed by your organization" lock state. TS
> twin: parse + expose the same policy, enforce provider/telemetry/history
> (PARITY: hook/OCR are desktop-only). Non-goals: no remote policy fetch, no
> signed policies in v1 (note both as follow-ons in the design), no per-user
> exceptions. Gates: unit tests per key incl. precedence over user prefs;
> an E2E proving a `forceLocalOnly` policy blocks a keyed provider at the
> engine even when profile.json says otherwise; docs page
> `docs/managed-deployment.md` with example policy + MDM/GPO distribution
> notes; `openspec validate --all` green.

### S2 — Local audit log

> Propose (OpenSpec: `add-audit-log`) and implement a local-only, append-only
> audit log for Lighthouse answering the security-review question "what did
> the AI read and what left the machine." Default **off**; enabled by user
> preference or forced by the S1 policy key `auditLog: "on"`. Per answered
> question, append one JSONL record to `audit/audit-<month>.jsonl` in the
> app-state dir (0600, atomic appends): timestamp, question hash (sha256, not
> the text — privacy default; a policy key `auditVerbatim` can include text),
> file ids read (references + analytics tables), provider used, egress
> (`none` | provider host), models/servers touched (local llama/embed/OCR),
> artifacts written (saved CSVs, notes), and a per-record HMAC chained to the
> previous record (tamper-evident; key in the existing secrets store). Engine
> work in `lighthouse-core` (single choke point where synthesis resolves —
> `synth.rs` — so widget and main window are both covered), ops to list/export
> (CSV) via routes/commands, small viewer dialog under the settings gear with
> export button. TS twin: same record shape at the same choke point
> (`synth.ts`), no HMAC chain (PARITY note). Non-goals: no remote shipping of
> the log, no retention automation in v1 (document manual rotation). Gates:
> unit tests for the HMAC chain (detect a modified middle record), an E2E
> asserting a cloud-provider question logs the host and a local question logs
> `egress:none`, `openspec validate --all` green.

### S3 — Egress transparency panel

> Implement a live "What left this machine" panel in Lighthouse. A small
> shield indicator in the app header (and a line in the widget pill footer)
> summarizes the current session: `All local` or `N requests to <provider>`.
> Clicking opens a panel listing this session's network events grouped by
> destination — provider streaming calls, license/trial checks, telemetry
> batches, update checks, asset downloads — each with count and last time;
> sourced from a new in-memory egress registry in `lighthouse-core` that
> every outbound-HTTP call site registers through (grep for reqwest usage;
> the choke points are llm.rs, license.rs, usage/experiment clients,
> local_model.rs downloads, embed.rs is local-only — verify). No content is
> recorded, only destination + purpose + count. When S2's audit log is on,
> the registry also feeds it. TS twin: same registry shape over fetch in
> `src/server/` (PARITY where subsystems don't exist). Non-goals: no packet
> capture, no blocking here (S1 does blocking), no persistence (session
> memory only). Gates: unit test that a mocked provider call registers
> exactly one event with the right host; E2E: fresh session with local
> provider shows `All local` and stays that way through an ask; README/
> `docs/data-flows.md` cross-links the panel.

### S4 — Keychain, SBOM & disclosure pack

> Harden Lighthouse's at-rest and supply-chain story in one pass. (1)
> OS-keychain storage for provider API keys behind the existing secrets API:
> use the `keyring` crate (Windows Credential Manager / macOS Keychain /
> Secret Service) to hold the sealing secret from
> `native/crates/lighthouse-core/src/secrets.rs` (keep the file-based secret
> as fallback when no keychain is available — headless Linux — and migrate
> transparently on first unlock; the honest threat-model comment updates to
> match). TS twin keeps file-based (PARITY: web dev has no keychain). (2)
> SBOM: generate CycloneDX for both the npm tree and the Cargo workspace in
> `desktop-release.yml` and attach both to every release. (3) CI gates:
> `cargo audit` and `npm audit --omit=dev` jobs in `native.yml`/check with a
> documented allowlist file for accepted advisories; also flag the
> CDN-tarball `xlsx` dependency — evaluate moving to the registry version or
> vendoring with a pinned hash, and do it if compatible. (4) `SECURITY.md`:
> supported versions, private disclosure contact, response SLO, and a
> one-page `docs/edr-whitelisting.md` describing exactly what the Whisper
> hook does (per-platform mechanism, opt-in surface, S1 policy disable) for
> AV/EDR review. Non-goals: no key-format change for existing users without
> migration, no new telemetry. Gates: tests for keychain-present and
> keychain-absent paths + migration; a release dry-run attaching both SBOMs;
> audits green or allowlisted with justification.

### S5 — Offline activation & deployment docs

> Give Lighthouse an air-gapped deployment story. (1) Offline activation: a
> signed license file (Ed25519, public key baked into the app; issue tooling
> as a small script under `supabase/` ops or a new `tools/` dir) that
> `license.rs`/`license.ts` accept as an alternative to the hosted Edge
> Function check — entitlement, expiry, and seat count verified offline,
> never destructive on failure (matches the existing lock-not-wipe posture).
> The hosted path remains default. (2) Document the licensing data flow in
> `docs/data-flows.md` (what the check sends, when, what happens offline —
> read the actual code, don't guess). (3) Silent install: NSIS `/S` flags +
> the settings/policy pre-seed path for fleet deployment, documented in
> `docs/managed-deployment.md`. Non-goals: no change to Stripe/checkout, no
> license-server UI, no seat-management UI in this pass (note as follow-on).
> Gates: unit tests for signature verification (valid/expired/tampered/wrong
> key), an E2E with `LICENSE_API_URL` unset + a license file proving startup
> with zero network, docs updated, and the Edge Function untouched.

### A1 — Fast private answers

> Make Lighthouse's private (local-model) path feel interactive. Today
> Mistral-7B on CPU takes ~1 min/answer; GPU offload exists but is not
> guided. Scope: (1) detection + guided default: on first local-model run,
> probe for a usable GPU (Vulkan/Metal per the existing GPU work in 0.6.0 —
> read `local_model.rs`/supervise.rs to see what's already there), report
> VRAM, and default `-ngl` layers accordingly with a visible "GPU: on (N
> layers)" line in the AI-models dialog; fall back to CPU cleanly on the
> known Vulkan crash class (the guard exists — reuse it). (2) A fast-draft
> tier: while the full local answer generates, stream the existing extractive
> answer immediately under a "Draft — verifying with the local model…" label
> that is replaced in place when the model's grounded answer lands (the
> extractive generator already exists as the fallback; this is orchestration
> in `synth.rs` + one UI state, keep the final answer's citations
> authoritative). Add a Preferences toggle "Fast draft while the private
> model thinks" default on. TS twin: draft orchestration only (no local
> model — PARITY). Non-goals: no new model downloads, no quantization
> changes, no cloud fallback. Gates: E2E on the extractive+local path
> asserting the draft renders then swaps; measured first-visible-token < 2 s
> with the draft on; no regression in the existing local-model E2E suite.

### A2 — PDF table extraction

> Propose (OpenSpec: `add-pdf-tables`) and implement the deferred PDF-table
> capability from `docs/analytics-genie.md` Phase C. Scope: text-layer PDFs
> only (scanned PDFs already OCR to prose — out of scope for tables in v1).
> In `native/crates/lighthouse-core/src/extract.rs`, detect tabular regions
> from the text layer's positioned runs (pdf-extract/lopdf give glyph
> positions — cluster into columns by x-alignment across consecutive lines;
> require ≥3 aligned rows × ≥2 columns; keep the heuristic pure and
> unit-tested like `detect_header_row`), emit each detected table as
> header-carrying CSV-ish rows appended to the extraction text under a
> `[table N]` marker so it flows through the existing tabular chunking
> (header prepended per chunk). Analytics: a detected-table PDF registers
> its tables like workbook sheets (extend `register_workbook`'s pattern;
> respect existing file/sheet/row caps). Cache version bumps in BOTH engines
> (established pattern). TS twin: extraction-side parity via the same
> heuristic over unpdf's positioned output if available, else PARITY-note
> extraction stays prose and analytics is Rust-only anyway. Non-goals: no
> ML layout models, no OCR'd-table support, no merged-cell reconstruction
> (state all three in the design's Non-goals). Gates: fixture PDFs (a clean
> financial table, a two-column prose PDF that must NOT false-positive, a
> ragged table) with committed expected outputs in both suites where
> applicable; an E2E analytics ask over a fixture table PDF returning
> engine-verified numbers; `openspec validate --all` green.

### A3 — Briefings (pins grow a digest)

> Propose (OpenSpec: `add-briefings`) and implement scheduled briefings on
> top of Lighthouse's pinned questions. Today pin changes surface as an
> in-app banner only. Scope: (1) a Briefing note: when ≥1 pin changes (and
> at most once per configurable interval, default daily at a user-set time,
> plus on-demand from the pins dialog), the engine writes/refreshes
> `Lighthouse Briefing.md` under `Lighthouse Notes/` in the vault via the
> existing sanitized vault-write helper: per changed pin — question, compact
> before→after table (reuse the pin digest diff), sparkline-style delta
> line, and the freshness footer; unchanged pins listed one-line. The note
> indexes like any file (existing watcher). (2) One OS notification via the
> Tauri notification plugin ("Your briefing is ready — 3 pins changed"),
> respecting the existing power-conserve activity states (never wake from
> hidden; queue until active). (3) Pins dialog gains schedule controls +
> "Brief me now". S1 policy `notifications:"off"` respected if present.
> Scheduler lives beside the existing debounced pin-recheck in
> `lighthouse-desktop/src/main.rs` — reuse, don't duplicate. TS twin: pins
> are already PARITY on-demand-only; briefing note generation on-demand
> only, no scheduler, no notification (PARITY notes). Non-goals: no email/
> push, no per-pin schedules, no model calls in the digest path (stays
> deterministic). Gates: unit tests for digest rendering + schedule gating;
> E2E: change a fixture CSV a pin reads → briefing note appears with the
> before/after row and a notification fires; `openspec validate --all` green.

### A4 — Richer results (charts & tables)

> Extend Lighthouse's chart/table rendering for analyst-grade output, keeping
> the trust invariant: specs are engine-built from query batches, never
> model-drawn. Scope: (1) chart kinds: stacked/grouped bar (label + 2–3
> numeric series), area (dated x-axis), scatter (two numeric columns);
> selection heuristics live with the existing emitter
> (`core::analytics::chart_spec_from_batches`) and stay unit-tested; the
> TS renderer (`src/lib/chartSpec.ts` + `AnalyticsChart.tsx`) grows matching
> theme-aware SVG (follow the existing light/dark token usage). (2) Axis
> formatting: thousands separators, compact notation (12.4k), date ticks by
> granularity (day/month/quarter — the data is ISO post-harden-excel), y-axis
> zero-baseline rule for bars. (3) In-chat result tables become sortable
> (client-side, header click) and show a row-count footer when truncated at
> the 200-row cap. (4) Pinned-question alerts embed a mini before/after bar
> pair when the changed result is chartable. Malformed-spec degradation to a
> visible code block stays. Non-goals: no interactivity beyond sort (no
> zoom/brush), no new charting library (hand-rolled SVG stays), no
> model-visible changes to prompts. Gates: spec-emitter unit tests per new
> kind incl. the never-model invariant (numbers traceable to batches);
> renderer fixture snapshots in both themes; existing chart fixtures stay
> byte-identical (no regression for bar/line); widget pill still strips
> fences.

### A5 — Cross-conversation memory

> Propose (OpenSpec: `add-conversation-recall`) and implement recall over
> past Lighthouse conversations. Exported chat notes already land in
> `Lighthouse Notes/` and index like any file; the gap is that history is
> opt-in, export is manual, and answers never distinguish "your prior
> conclusion" from "a document." Scope: (1) when "Save chats on this device"
> is on, auto-export each conversation to `Lighthouse Notes/Chats/` as
> markdown on close/idle (reuse `exportChat`; frontmatter: date, title,
> provider, file ids cited) — respecting the existing opt-in and S1 policy
> `chatHistory:"off"`. (2) retrieval: chunks originating from
> `Lighthouse Notes/Chats/` carry a `conversation` source kind; the synthesis
> prompt labels such context blocks "from your past Lighthouse conversation
> (date)" so answers can say "on July 10 you concluded…" with the note as
> the citation; references render with a chat glyph and open the note. (3)
> meta-answers: "what did I ask/conclude about X?" cues route to a recall
> variant that prefers conversation-kind chunks. Both engines (retrieval +
> prompt labeling are shared paths; auto-export scheduling desktop-first
> with PARITY note). Non-goals: no embedding of live (unsaved) sessions, no
> summarization pass in v1, no cross-vault recall. Gates: unit tests for
> source-kind labeling and the meta cue; E2E: ask → save → new chat →
> "what did I conclude about <topic>?" returns the prior conclusion citing
> the chat note; history-off leaves zero notes; `openspec validate --all`
> green.

---

## 6. Suggested order of execution

```
F2 → F3 → F1 → F4        (foundation: shrink, gate, sign, tell the truth)
S1 → S3 → S2 → S4 → S5   (security: policy first — it gates three others)
A1 → A2 → A4 → A3 → A5   (analyst: latency first — it multiplies the rest)
```

F-track first (F2 before F3 so the smoke doesn't gate a shell being deleted;
F1 needs maintainer-provisioned certs, so start it early but expect it to
finish in parallel). The S and A tracks are independent of each other and can
interleave; within each, the listed order front-loads the items later ones
build on (S1's policy keys are consumed by S2/S3/S4; A1's latency win makes
A2–A5 feel like different features on the private path).

---

## 7. Master prompt — the whole plan as one copyable session prompt

The per-workstream prompts in §5 are the fine-grained option. The prompt below
condenses the entire game plan into a single self-contained instruction for
one (long) session or a small series of sessions — phases land independently,
so it degrades gracefully if stopped early.

```
Harden and extend Lighthouse for its two target users — the data analyst and
the IT security director. The full analysis behind this plan is in
docs/roadmap-personas-2026-07.md (on branch claude/repo-analysis-roadmap-mwqgl0
if not yet merged); read it if present, but this prompt stands alone.

Work in three phases, in order. The app must build and pass every gate at the
end of each phase; open one PR per phase for review and stop short of merging
or tagging. No version bumps — those happen at ship time.

Ground rules, non-negotiable:
- The Rust engine (native/) is the shipping product; the TS engine under
  src/server is the web-dev twin. Any change to shared behavior lands in BOTH
  engines with byte-identical prompts/labels, or carries an explicit PARITY
  comment stating the divergence — follow the existing convention.
- Feature-sized changes go through OpenSpec (openspec/changes/<id>/ with
  proposal, design with Non-goals pinned, spec deltas, tasks;
  `openspec validate --all` green) before implementation. Fixes and chores go
  straight to commits.
- Never weaken the local-first invariants: default-excluded inclusion,
  lock-never-wipe licensing, the read-only single-SELECT analytics guard,
  opt-in telemetry and chat history, 0600 atomic state writes, and no new
  network egress without documenting it in docs/data-flows.md.
- Gates per phase: npm test (tsc + node suites), the native cargo test suite,
  lint, and a live end-to-end check of each user-visible change against the
  real built app (headless Xvfb where needed, per the repo's practice).
- Anything requiring accounts, certificates, or payments: implement
  fail-closed scaffolding, document exactly what the maintainer must
  provision, and move on. Where a product decision is genuinely the
  maintainer's (marked below), ask; otherwise decide and record the rationale.

PHASE 0 — FOUNDATION (de-risks everything after)

0.1 Retire the Electron distribution. Archive the current state to a branch
    archive/electron-shell, then delete electron/, .github/workflows/release.yml
    (it still triggers on every v* tag and builds legacy Electron installers —
    the shipping pipeline is desktop-release.yml), the
    electron/electron-builder/electron-updater dependencies, and the
    electron/dist/dist:nomodel/release npm scripts. Keep the Next web-dev flow
    working. Write docs/ts-twin.md defining the TS engine's role (web dev +
    parity oracle) and the canonical list of Rust-only capabilities; sweep all
    PARITY markers and correct any stale ones.

0.2 Pre-tag release smoke. A workflow job on all three OS runners that builds
    the real bundle (build-ui-static + cargo build --release -p
    lighthouse-desktop), boots it headlessly, drives one ask over a fixture
    vault via the extractive fallback (no network, no model download), asserts
    a grounded answer with a reference arrives, and round-trips every field of
    the desktop settings struct — a missing field must fail CI, not surface as
    a field report (see PR #141). Make desktop-release.yml require this job.

0.3 Signing, to the edge of what's possible without certs. Wire Windows
    Authenticode and macOS Developer-ID signing + notarization into
    desktop-release.yml gated on secrets (absent secrets → cleanly unsigned
    build, never half-signed). Generate tauri-plugin-updater signed manifests
    and implement updater Phase B (download + verify + install-on-consent)
    active only when a manifest key exists, keeping notify-only as the
    fallback. End with a checklist of exactly which certificates/accounts the
    maintainer must provision.

0.4 Docs truth pass. README still describes the retired sandy-beach theme and
    Electron-era run instructions — rewrite it to match the shipping product
    (0.11.0, Tauri, Forerunner steel/blue). Create docs/data-flows.md
    enumerating every possible egress — the six cloud-provider hosts, the
    Supabase license/telemetry functions, the GitHub releases feed, HF +
    mirror asset hosts — with when each fires, what it carries, and how to
    disable it. This document is written for a security reviewer.

PHASE 1 — IT SECURITY DIRECTOR

1.1 Managed policy layer (OpenSpec: add-managed-policy). A machine-scope,
    read-only policy.json (/etc/lighthouse/, %ProgramData%\Lighthouse\,
    /Library/Application Support/Lighthouse/) overriding user preferences.
    V1 keys: allowedProviders (subset of the seven), forceLocalOnly,
    telemetry:"off", chatHistory:"off", widgetHotkeys:"off" (the summon
    keyboard hook is then never installed), ocr:"off", notifications:"off",
    auditLog:"on", vaultRoots (path-prefix allowlist). Enforce in the engine —
    reject server-side, not just in the UI; affected controls show a
    "Managed by your organization" lock state. Write
    docs/managed-deployment.md with an example policy and MDM/GPO notes.
    TS twin: parse + enforce provider/telemetry/history; hook/OCR keys are
    desktop-only (PARITY).

1.2 Egress transparency panel. An in-memory session registry that every
    outbound HTTP call site reports through (llm.rs, license.rs, the
    usage/experiment clients, model/asset downloads — find them by grepping
    for reqwest/fetch). A header shield reads "All local" or "N requests to
    <host>"; clicking opens the per-destination list (purpose + count + last
    time — never content). The widget pill footer gets the one-line summary.

1.3 Local audit log (OpenSpec: add-audit-log). Append-only JSONL in the
    app-state dir, one record per answered question, written at the synthesis
    choke point (synth.rs / synth.ts — so the widget and main window are both
    covered): timestamp, question sha256 (verbatim text only under a policy
    key), file ids read, provider used, egress none|host (from 1.2's
    registry), local servers touched, artifacts written, and a per-record
    HMAC chained to the previous record (key in the existing secrets store)
    so tampering is detectable. Off by default, on by preference or policy.
    Viewer dialog under the settings gear + CSV export.

1.4 Keys, SBOM, disclosure. Move the sealing secret from secret.key-on-disk
    (native/crates/lighthouse-core/src/secrets.rs — see its honest
    threat-model comment) into the OS keychain via the keyring crate, with
    the file fallback for headless Linux and transparent migration; update
    the comment to match. Generate CycloneDX SBOMs for the npm tree and the
    Cargo workspace and attach both to every release. Add cargo audit +
    npm audit CI gates with a justified allowlist file. Evaluate replacing
    the CDN-tarball xlsx dependency with a registry or vendored pinned copy,
    and do it if compatible. Write SECURITY.md (disclosure contact, response
    SLO) and docs/edr-whitelisting.md describing exactly what the Whisper
    summon hook does per platform (keyboard hook / event monitor / raw
    input), that it is opt-in, and how policy disables it.

1.5 Offline activation. Accept an Ed25519-signed license file (public key
    baked into the app; small issue-tooling script) as an alternative to the
    hosted Edge Function check — entitlement and expiry verified with zero
    network, never destructive on failure (matches the lock-not-wipe
    posture). The hosted path stays default. Document the licensing data
    flow honestly in docs/data-flows.md and the NSIS silent-install flags in
    docs/managed-deployment.md.

PHASE 2 — DATA ANALYST

2.1 Fast private answers. Probe for a usable GPU (the Vulkan/Metal offload
    machinery from 0.6.0 exists — read local_model.rs and the shell
    supervisor first), default the offload layers accordingly with a visible
    "GPU: on (N layers)" line in the AI-models dialog and a clean CPU
    fallback on the known crash class. Then: stream the existing extractive
    answer immediately as "Draft — verifying with the private model…" and
    replace it in place when the local model's grounded answer lands
    (orchestration in synth.rs + one UI state; the final answer's citations
    are authoritative; Preferences toggle, default on). Target: first
    visible token < 2 s on the private path.

2.2 PDF tables (OpenSpec: add-pdf-tables). Text-layer PDFs only (scanned
    PDFs already OCR to prose). Cluster positioned text runs into columns by
    x-alignment across consecutive lines (≥3 aligned rows × ≥2 columns; a
    pure, unit-tested heuristic in the spirit of detect_header_row). Emit
    each detected table as header-carrying rows so it flows through the
    existing tabular chunking, and register detected tables in analytics
    like workbook sheets under the existing caps. Cache version bump in BOTH
    engines. Fixtures must include a two-column prose PDF that must NOT
    false-positive, plus a clean financial table and a ragged one.

2.3 Briefings (OpenSpec: add-briefings). When pinned questions change — at
    most once per user-set daily time, plus on demand from the pins dialog —
    write/refresh "Lighthouse Briefing.md" under Lighthouse Notes/ via the
    existing sanitized vault-write helper: per changed pin a compact
    before→after table and the freshness footer, deterministic, zero model
    calls. Fire one OS notification (Tauri notification plugin) respecting
    the power-conserve activity states (never wake from hidden) and the
    notifications policy. Build the scheduler beside the existing debounced
    pin recheck — do not duplicate it. TS twin: on-demand note only (PARITY).

2.4 Richer results. New engine-built chart kinds — stacked/grouped bar,
    area, scatter — with matching theme-aware hand-rolled SVG in the
    existing renderer; axis formatting (thousands separators, compact
    notation, date ticks by granularity, zero-baseline rule for bars);
    in-chat result tables sortable by header click with a truncation footer
    at the 200-row cap; changed-pin alerts embed a before/after mini-chart
    when chartable. The trust invariant stands: specs are built from query
    batches, never model text; existing bar/line fixtures stay
    byte-identical.

2.5 Cross-conversation recall (OpenSpec: add-conversation-recall). With
    "Save chats on this device" on, auto-export each conversation to
    Lighthouse Notes/Chats/ as markdown (frontmatter: date, title, provider,
    cited file ids) reusing exportChat. Chunks retrieved from that folder
    carry a conversation source kind: the synthesis prompt labels them
    "from your past Lighthouse conversation (date)" and references render
    with a chat glyph opening the note. A "what did I ask/conclude about X?"
    meta cue prefers conversation-kind chunks. Zero notes are written while
    history is off or policy-disabled.

REPORT, DON'T IMPLEMENT (maintainer decisions — end with a recommendation on
each): the trial policy (today it is infinitely repeatable), opening
PAID_ENABLED, and team/seat management. State the hard rule in the report:
paid must not open while installers are unsigned.

After each phase: gates green, PR opened, and a short status summary —
shipped / blocked-on-maintainer / deferred, with reasons. If a phase can't
complete, land what's green and report precisely where you stopped.
```

---

## 8. Refocused plan (2026-07-14): analyst-first, trust-first

Maintainer direction after reviewing §1–7: **focus on the data analyst** and
make the analytical side pristine; **fix the trust and misbranding issues
that exist today**; and to get there faster, **drop all automatic data
collection outright** — usage telemetry, A/B experiments, and the Experiments
leaderboard dialog — keeping **feedback and bug reports** as the only
channel, explicit and user-initiated. The security-director track (§4 Wave 2)
is deferred, and dropping collection makes much of it moot: the strongest
possible trust feature is having nothing to disclose.

The posture this plan encodes everywhere: *the only bytes that ever leave the
machine on Lighthouse's behalf are a cloud-model request the user configured,
a license/trial check, an update check, pinned asset downloads, and a
feedback or bug report the user explicitly pressed Send on.*

### The two tracks

**Track T — trust & truth reset** (one session, one PR). Remove both engines'
telemetry (`usage.ts`/`usage.rs`, launch pings, `model_selected`, the
counts-only vault presence events, every `data-log` attribute, the onboarding
consent checkbox) and the whole experiment machinery
(`experiment.ts`/`experiment.rs`, server-balanced `assign`,
`experiments.json`); delete the Experiments dialog and put "Send feedback" in
its menu slot; consolidate the feedback/bug/interest channel around a
show-before-send dialog; rewrite the README and stale docs to match the
shipping product; add `docs/data-flows.md` (now five items long); disarm the
legacy Electron release pipeline that still auto-fires on `v*` tags. Care
point: explicit submissions (bug reports, feedback, interest votes) ride the
same Edge Function as the deleted telemetry — keep those ops, delete the
ambient ones, and produce a server-side decommission checklist rather than
deploying.

**Track G — "Genie v3": pristine analytics** (OpenSpec batch in the #129
house style, one commit per feature). Ordered so each step hardens the ground
the next stands on: **G1** correctness audit + eval floor for the existing
analytics path (adversarial two-pass review of `analytics.rs`, `catalog.rs`,
`table_profile.rs`, tabular chunking, `chartSpec.ts`; golden executor tests;
prompt snapshot tests; truncation honesty), **G2** fast private answers (GPU
guided default + extractive fast-draft swapped in place), **G3** PDF tables,
**G4** presentation polish (chart kinds, axis/number/date formatting,
sortable tables, pin-diff mini-charts), **G5** briefings (deterministic
digest note + OS notification), **G6** cross-conversation recall (optional,
last). The §5 A-prompts remain valid individually; the Track G prompt below
supersedes their sequencing and strips the dropped policy-layer references
(notification and history controls become plain user preferences).

**In parallel, maintainer-gated:** code signing (§5 F1 / §7 step 0.3,
unchanged) — the one remaining trust item no code-only session can finish.
Certificates to provision: Windows Authenticode, Apple Developer ID +
notarization account, tauri updater signing key.

### Order

Run **T before G**: it shrinks the surface G ships into (G's new UI would
otherwise need `data-log` wiring), and it converts the marketing claim into a
grep-provable fact before new analyst features draw attention to the product.

### Track T prompt

```
Remove every form of automatic data collection from Lighthouse, replace the
Experiments dashboard with a single explicit feedback channel, and make the
repo's front-door docs tell the truth about the shipping product. One PR, no
version bump. The posture to encode everywhere: the only bytes that ever
leave the machine on Lighthouse's behalf are a cloud-model request the user
configured, a license/trial check, an update check, pinned asset downloads,
and a feedback/bug report the user explicitly pressed Send on.

Ground rules: the Rust engine (native/) is the shipping product and the TS
engine under src/server is its web-dev twin — changes land in BOTH engines
per the existing PARITY convention. No behavior changes outside the scope
below. Gates: npm test (tsc + node suites), the native cargo suite, lint,
plus the proof gates at the end.

1. Delete usage telemetry, both engines:
   - src/server/usage.ts and src/features/usage/useUsageCapture.ts; every
     data-log / data-log-type attribute (grep — they're spread across ~15
     components); the launch ping and the account-email attachment on events
     (license.ts / profile.ts); the model_selected event; the counts-only
     vault presence telemetry in vault.ts and vault.rs.
   - native: usage.rs plus its references in license.rs / profile.rs /
     lib.rs and the routes/commands that expose it.
   - Onboarding: remove the "share usage analytics" checkbox and the
     usageLoggingOptOut plumbing (src/features/onboarding/OnboardingPanel.tsx)
     and the trial-mint consent-reset logic; the register payload keeps only
     what licensing needs.
2. Delete the A/B experiment machinery, both engines: experiment.ts /
   experiment.rs, the server-balanced `assign` call, the local-hash
   fallback, pilot overrides, experiments.json state. Default inclusion
   became an explicit user choice in #99 — verify nothing still resolves a
   variant and migrate any straggler to the setting. Delete or stamp
   docs/experiments/ as historical.
3. Replace the dashboard with the feedback channel:
   - Delete src/features/experiments/ExperimentsDialog.tsx and the
     "Experiments" gear-menu item (src/features/license/LicenseGate.tsx,
     ~line 1481); in its slot, a "Send feedback" item opening the feedback
     form.
   - Consolidate the voluntary channel (BugReport.tsx, FeedbackNudge.tsx,
     FeatureInterestVote.tsx — keep all three): every submission shows
     exactly what will be sent before sending — the message, app version,
     OS — plus an off-by-default checkbox to attach a shell.log excerpt,
     rendered in the dialog so the user reads it first. Nothing sends
     without a click.
   - Careful seam: explicit submissions (bug reports, feedback, interest
     votes) ride the same Edge Function ops as the deleted telemetry — map
     the /api/event and /api/usage routes and the function's op handlers,
     keep the ops that carry explicit submissions, delete the ones that
     carry ambient telemetry.
4. Server-side decommission checklist (report, don't deploy — I run
   deploys): which Edge Function ops and tables are now dead (click_events,
   events if unused after the seam split, experiment_assignments, the
   assign op) and what the license function still needs.
5. Docs truth pass:
   - README: the theme description (the app has been Forerunner steel/blue
     since #53, not sandy-beach), the Run-it section (the Tauri desktop app
     is the product — say what's true about the Electron-era launchers or
     remove them from the front door), the Status section, and a short
     privacy paragraph stating the posture above.
   - New docs/data-flows.md: the complete egress list — chosen cloud
     provider, license/trial check, update check, pinned asset downloads,
     explicit feedback — when each fires, what it carries, how to turn it
     off. After this PR the list is exactly that long; write it for a
     skeptical reviewer.
   - Stamp or fix stale docs (docs/desktop.md and ARCHITECTURE.md predate
     the Tauri cutover). Document the naming debt: the npm package and
     userData dir remain rag-vault because renaming breaks upgrades — no
     rename in this pass.
6. The repo builds only what it ships: .github/workflows/release.yml still
   auto-triggers on every v* tag and builds the retired Electron
   installers. Archive the current state to branch archive/electron-shell,
   then delete release.yml. Deeper Electron/TS-twin removal is out of scope
   here.

Proof gates, beyond the suites: (a) grep-clean — usage capture, experiment,
data-log, pingLaunch, model_selected appear nowhere outside docs/history;
(b) run the built app through onboarding and one ask with outbound requests
observed (mock fetch layer or local proxy) and assert zero requests except
those in docs/data-flows.md; (c) the bug-report and feedback forms still
round-trip end-to-end; (d) the Experiments dialog is absent from the bundle.
End with the decommission checklist and a one-paragraph summary of what a
privacy reviewer would now find.
```

### Track G prompt

```
Make Lighthouse's analytics experience pristine — a "Genie v3" batch in the
house style of PR #129: every feature OpenSpec-planned
(openspec/changes/<id>/ with proposal, design with Non-goals pinned, spec
deltas, tasks; `openspec validate --all` green), implemented one commit per
feature, opened as one PR for review. No version bump — that happens at ship
time. Read docs/analytics-genie.md and the existing openspec/changes/ first:
everything below extends that architecture and its invariants — the model
never does arithmetic, every number traces to DataFusion output, the SQL is
shown verbatim, the read-only single-SELECT guard stands, and the analytics
branch may only add capability, never break an answer. Analytics is
Rust-only (established PARITY decision); shared paths (chunking, chart spec
parsing, prompts) land in both engines byte-identically per convention.

G1 — Correctness audit + eval floor. Do this first: harden what exists
    before anything new lands.
    - Adversarial two-pass review (the #135 pattern: find, then
      independently verify each finding before fixing) of analytics.rs,
      catalog.rs, table_profile.rs, the tabular chunking path, and
      src/lib/chartSpec.ts. Hunt the wrong-but-plausible class specifically:
      date arithmetic over ISO strings (substr-based grouping), Excel
      serials that slipped the harden-excel pass, union-group misgrouping
      (same stem, different schema), join-hint false positives, NULL
      handling in aggregates, LIMIT/cap truncation narrated as if complete,
      guard bypasses (subquery-smuggled DML, multi-statement, CTE tricks).
      Every confirmed finding gets a fix + regression test.
    - Eval harness: golden executor tests (committed fixtures → expected
      result tables) covering dates, unions, joins, and header detection;
      prompt snapshot tests so any schema-card or few-shot drift is a
      reviewed diff; an examples/analytics_eval.rs scorecard (question →
      expected numbers over fixtures) runnable locally against a configured
      provider — wire it into CI only where it can run model-free; never
      add a flaky gate.
    - Truncation honesty: any capped or truncated result must say so in the
      answer and footer ("first 200 rows of 12,431").

G2 — Fast private answers. Probe for a usable GPU (the Vulkan/Metal offload
    machinery from 0.6.0 exists — read local_model.rs and the shell
    supervisor first), default the offload layers accordingly with a
    visible "GPU: on (N layers)" line in the AI-models dialog and a clean
    CPU fallback on the known crash class. Then stream the existing
    extractive answer immediately as "Draft — verifying with the private
    model…", replaced in place when the local model's grounded answer lands
    (orchestration in synth.rs plus one UI state; the final answer's
    citations are authoritative; Preferences toggle, default on). Target:
    first visible token under 2 s on the private path.

G3 — PDF tables (OpenSpec: add-pdf-tables). Text-layer PDFs only (scanned
    PDFs already OCR to prose). Cluster positioned text runs into columns
    by x-alignment across consecutive lines (at least 3 aligned rows by 2
    columns; a pure, unit-tested heuristic in the spirit of
    detect_header_row). Emit each detected table as header-carrying rows so
    it flows through the existing tabular chunking, and register detected
    tables in analytics like workbook sheets under the existing caps. Cache
    version bump in BOTH engines. Fixtures must include a two-column prose
    PDF that must NOT false-positive, a clean financial table, and a ragged
    one.

G4 — Presentation polish. New engine-built chart kinds — stacked/grouped
    bar, area, scatter — with matching theme-aware hand-rolled SVG in the
    existing renderer; axis formatting (thousands separators, compact
    notation, date ticks by granularity, zero-baseline rule for bars);
    in-chat result tables sortable by header click with the truncation
    footer from G1; changed-pin alerts embed a before/after mini-chart when
    the result is chartable. The trust invariant stands: chart specs are
    built from query batches, never model text; existing bar/line fixtures
    stay byte-identical.

G5 — Briefings (OpenSpec: add-briefings). When pinned questions change —
    at most once per user-set daily time, plus on demand from the pins
    dialog — write/refresh "Lighthouse Briefing.md" under Lighthouse Notes/
    via the existing sanitized vault-write helper: per changed pin a
    compact before→after table and the freshness footer, deterministic,
    zero model calls. Fire one OS notification (Tauri notification plugin,
    behind a user preference, default on) respecting the power-conserve
    activity states — never wake from hidden. Build the scheduler beside
    the existing debounced pin recheck; do not duplicate it. TS twin:
    on-demand note only (PARITY).

G6 — Cross-conversation recall (OpenSpec: add-conversation-recall; take
    this only if G1–G5 are green). With "Save chats on this device" on,
    auto-export each conversation to Lighthouse Notes/Chats/ as markdown
    (frontmatter: date, title, provider, cited file ids) reusing
    exportChat. Chunks retrieved from that folder carry a conversation
    source kind: the synthesis prompt labels them "from your past
    Lighthouse conversation (date)" and references render with a chat
    glyph opening the note. A "what did I ask/conclude about X?" meta cue
    prefers conversation-kind chunks. Zero notes are written while chat
    history is off.

Gates per feature: unit + fixture tests in the owning engine, parity
fixtures where the path is shared, a live end-to-end check against the real
built app (headless Xvfb where needed, per repo practice), and the G1 eval
suite stays green through G2–G6. After each feature: one commit, a one-line
status. If a feature can't complete, land what's green and report where you
stopped.
```

---

## 9. Cutting the cord: no Supabase, no accounts (supersedes §8 Track T)

Maintainer question: with data collection dropped and no paid accounts, is
Supabase needed at all? **No.** The full dependency inventory:

| Supabase piece | Serves | Disposition |
|---|---|---|
| `license` fn + trial/contact tables | Repeatable 14-day trial, sign-in, lock | Gates nothing of value (`PAID_ENABLED=0`, trial repeatable). Delete — app always unlocked |
| `create-checkout`, `stripe-webhook` fns | $14.99/mo checkout | Dead with paid. Delete |
| `click_events`, `experiments_events`, `experiment_assignments`, `assign` op | Telemetry & A/B | Already deleted by Track T |
| `bug_reports`, `feature_interest`, `coming_soon_leaderboard` | Explicit feedback | Replace with a **zero-backend** channel: compose locally, hand off via prefilled `mailto:` or GitHub-issue URL — the app never transmits |

Gains: the app's complete egress list drops to three items (chosen cloud
provider, update check, pinned asset downloads); ~2–3k lines of licensing
code across both engines removed; the sign-in bug class (#111, 0.11.0's
vault-switch fix) becomes structurally impossible; onboarding loses the
email step; the shipped anon key and login-time license check vanish.
Losses, accepted: centralized feedback inbox (→ email/GitHub issues), the
notify-me list (data collection anyway), the trial lever. Door left open:
if paid returns it returns as **offline signed license files + a Stripe
payment link** — no accounts, no Supabase.

Maintainer inputs the prompt flags: the feedback email address, and the
hosted-project sunset plan (old installs poll the license function; a dead
endpoint never wipes — lock-not-wipe holds — but they'd eventually lock, so
keep the function up patched always-valid for a window).

### Track T v2 prompt — "cut the cord"

```
Cut Lighthouse's cloud cord: remove all automatic data collection, the
entire licensing/accounts system, and the Supabase backend; replace the
Experiments dashboard with a zero-backend feedback channel; and make the
docs tell the truth about the shipping product. After this PR the complete
egress list is: the cloud model the user configured, the update check, and
pinned asset downloads. Feedback leaves via the user's own mail client or
browser — never sent by the app itself.

One PR, one commit per numbered section below so review and partial landing
stay clean. No version bump. Ground rules: the Rust engine (native/) is the
shipping product and the TS engine under src/server is its web-dev twin —
changes land in BOTH engines per the existing PARITY convention. Gates: npm
test (tsc + node suites), the native cargo suite, lint, plus the proof
gates at the end.

1. Telemetry — delete, both engines: src/server/usage.ts and
   src/features/usage/useUsageCapture.ts; every data-log / data-log-type
   attribute (grep — ~15 components); the launch ping and account-email
   event attachment (license.ts / profile.ts); the model_selected event;
   the counts-only vault presence telemetry (vault.ts / vault.rs);
   usage.rs plus its lib.rs/routes/commands wiring; the /api/usage route;
   the onboarding "share usage analytics" checkbox and usageLoggingOptOut
   plumbing.

2. Experiments — delete, both engines: experiment.ts / experiment.rs, the
   server-balanced assign call, the local-hash fallback, pilot overrides,
   experiments.json state. Default inclusion has been an explicit user
   setting since #99 — verify no variant consumer remains and migrate any
   straggler. Delete src/features/experiments/ExperimentsDialog.tsx and
   the "Experiments" gear-menu item. Move docs/experiments/ to the archive
   branch.

3. Licensing, accounts, Supabase — delete:
   - Engines: license.ts (~600 lines) / license.rs (~900 lines), the
     /api/license and /api/register routes and their Rust twins,
     identity/contact/launch state files (stop writing them; clean stale
     ones from the app-state dir on boot), the LICENSE_ENFORCE /
     LICENSE_SECRET local-dev mode, and the Stripe checkout path
     (submitNotify, CHECKOUT_API_URL).
   - UI: src/features/license/LicenseGate.tsx is the largest feature file
     and hosts surfaces that must SURVIVE — first extract the settings
     gear menu, Preferences dialog, and AI models dialog into a new
     src/features/settings/, then delete the gate overlay,
     trial/registration/purchase/activate/notify-me dialogs, GraceBanner,
     sign-out, and the account card. The app is simply always unlocked.
   - Onboarding: remove the email/registration step entirely; first run
     becomes vault choice → window/widget mode → model pick → default
     inclusion. Drive the full first-run E2E afterward.
   - Repo: move supabase/ and docs/registration.md to the archive branch;
     delete .env.production (or reduce it to a documented empty stub) and
     every LICENSE_API_URL / SUPABASE_ANON_KEY / CHECKOUT_API_URL /
     PAID_ENABLED reference (README, .env.local.example, installer
     config, rewrite-scope appendix note).
   - Compatibility: old installs poll the hosted license function. Verify
     from the old code's own behavior that a dead endpoint degrades to
     grace/lock — never a wipe — and put the sunset recommendation in the
     final checklist (keep the function up, patched always-valid, for a
     window). Report it; don't deploy anything.

4. Feedback goes zero-backend: rework BugReport.tsx, FeedbackNudge.tsx,
   and FeatureInterestVote.tsx into one "Send feedback" flow (gear-menu
   item in the old Experiments slot + the existing FAB): the dialog
   composes the report locally — message, app version, OS, optional
   off-by-default shell.log excerpt rendered in full for review — then
   offers two explicit handoffs: "Email us" (mailto: with prefilled
   subject/body — ASK ME for the address before wiring it) and "Open a
   GitHub issue" (prefilled github.com/lmansf/lighthouse/issues/new with
   title/body params, labeled as public). The app itself transmits
   nothing; /api/event dies with the interest-vote backend and the
   coming-soon teaser keeps only a local thank-you.

5. Docs & branding truth: README — fix the theme description (Forerunner
   steel/blue since #53, not sandy-beach) and the Run-it section (the
   Tauri desktop app is the product), delete the Pricing & trial section,
   add a short privacy paragraph stating the posture above. New
   docs/data-flows.md: exactly three app egresses plus the two
   user-initiated feedback handoffs, when each fires, what it carries, how
   to turn it off — written for a skeptical reviewer. Stamp or fix
   docs/desktop.md and ARCHITECTURE.md (pre-Tauri). Record the naming debt
   (npm package / userData dir stay rag-vault for upgrade safety). Add a
   one-paragraph decision record: if paid ever returns, it returns as
   offline signed license files + a Stripe payment link — no accounts, no
   Supabase.

6. The repo builds only what it ships: archive-then-delete
   .github/workflows/release.yml — it still auto-fires legacy Electron
   builds on every v* tag; the shipping pipeline is desktop-release.yml.

Proof gates, beyond the suites: (a) grep-clean — supabase,
LICENSE_API_URL, PAID_ENABLED, usage capture, experiment, data-log,
pingLaunch, model_selected, submitNotify appear nowhere outside the
archive branch and history/roadmap docs; (b) built-app run: fresh
first-run onboarding through to a grounded answer with outbound traffic
observed (mock fetch layer or local proxy) — zero requests except those in
docs/data-flows.md; (c) the feedback dialog produces a correct mailto: URL
and a correct prefilled issue URL (assert both strings in a unit test);
(d) the settings gear still opens Preferences and AI models; (e) full
suites green. End with the maintainer checklist: Supabase project sunset
plan, the feedback email address, Stripe account cleanup — and a
one-paragraph summary of what a privacy reviewer would now find.
```

---

## 10. Privacy-first for data analysts: the include/remove pass (Track P)

Product identity settled: **privacy-first analytics for data analysts** —
the analyst whose spreadsheets can't leave the machine (finance, health,
HR, legal, gov). The test for every surface: *does it help this person
trust and interrogate their own data on-device?* Applied to the tree as it
stands after T v2 + G are queued:

**Remove / demote** (dilutes the thesis):

| What | Why |
|---|---|
| Dormant SharePoint/Microsoft connector, both engines, + explorer teaser | Unfinished cloud plumbing in a no-cloud product; demoted to a teaser in 0.4.5, never shipped in the Rust engine's UI; its interest-vote backend dies with T v2. Keep the SourceConnector seam, archive the implementation |
| DeepSeek from the built-in roster *(maintainer decision, flagged)* | Instant policy flag for the exact buyer; the shared OpenAI-compatible adapter + BYO endpoint keep the capability for anyone who insists |
| Cloud-as-peer provider framing | Local/private becomes the hero path; cloud vendors group under an honest "sends excerpts of your included files to the vendor" label — one click away, never hidden, never dark-patterned |
| Bundled Piper voice *(optional, flagged)* | ~60–90 MB installer diet; the flakiest mirrored asset leaves the default build; read-aloud falls back to OS voices until the user opts in |

**Include** (missing for this persona, beyond queued G1–G6):

| What | Why |
|---|---|
| Per-answer privacy provenance | "Answered on this device" / "Answered via <vendor> — N excerpts from M files sent" stamped under every answer, engine-computed at prompt assembly. Turns the architecture into a visible, per-interaction feature |
| Local-only file marks | Per-file/folder "private — this device only" flag, engine-enforced: cloud providers never see those files (retrieval, attachments, analytics, catalog), with an honest skip note in answers. THE control for mixed-sensitivity vaults |
| "What the AI sees" inspector | Per-file panel: extraction preview, chunking mode, detected columns, freshness, plain-language visibility state, test-search scoped to the file. Trust (see exactly what could leave) + retrieval debugging (why did my ask miss) in one surface |
| Big-table streaming registration *(→ G7, amends Genie v3)* | CSV/TSV/Parquet register by path and stream through DataFusion — the 100k in-memory row cap stops applying to those formats; workbooks keep their caps with G1's truncation honesty |
| Evidence-pack export *(fold into G4)* | One self-contained file per analytics answer: question, narrative, table, chart, SQL, provenance + freshness, timestamp — what an analyst pastes into a review thread |

**Order: T v2 → P → G.** P is one session; it completes the privacy story
end-to-end (T v2 sets the posture, P makes it visible and controllable),
and running it before G means G1's audit + eval cover P2's retrieval
filtering. If T v2 hasn't run yet, P4's deletions can fold into it.

### Track P prompt

```
Lighthouse is now privacy-first analytics for data analysts. Make that
identity legible in one pass: the private path becomes the hero, privacy
becomes visible per answer and controllable per file, and the dormant
cloud plumbing leaves the tree. One PR, one commit per numbered section,
no version bump. Ground rules: the Rust engine (native/) is the shipping
product, the TS engine under src/server is the web-dev twin — shared
behavior lands in BOTH per the PARITY convention; sections 2 and 3 are
feature-sized and get OpenSpec changes (proposal, design with Non-goals
pinned, spec deltas, tasks; `openspec validate --all` green). Gates: npm
test, the native cargo suite, lint, and a live E2E per section.

1. Private-first provider experience + per-answer provenance.
   - Reframe onboarding's model step and the AI-models dialog: "Private —
     runs on this device" (the local model) is the hero option with its
     install affordance; cloud vendors group under "Cloud models — sends
     excerpts of your included files to <vendor> to answer", with the
     vendor named per row. No dark patterns: cloud stays one click away,
     just honestly labeled.
   - Per-answer provenance stamp, engine-emitted (never model text): the
     final ChatChunk gains meta {origin: "device" | provider id, excerpt
     count, source file count}; the UI renders "Answered on this device"
     or "Answered via <vendor> — N excerpts from M files sent" under each
     answer, and the widget pill shows the same line compactly. A small
     header shield summarizes the session ("All local" / "N cloud
     calls"). Compute the stamp where the prompt is assembled so it
     counts what was actually sent, not what was retrieved. Both engines.
   - Provider roster decision (ASK ME before wiring): recommend dropping
     DeepSeek from the built-in roster — a policy flag for the target
     buyer; the shared OpenAI-compatible adapter and BYO endpoint remain,
     so nothing is lost architecturally. Roster lives in
     src/contracts/mocks/providers.ts + llm.ts / llm.rs. Present the
     tradeoff, await my answer, implement accordingly.

2. Local-only file marks (OpenSpec: add-local-only-marks). A second
   per-node flag alongside inclusion: "Private — this device only".
   Semantics mirror the existing inclusion model (explicit flag,
   ancestor-wins: marking a folder covers descendants). Enforce in the
   ENGINE at the choke points that assemble model context: when the
   active provider is a cloud vendor, local-only nodes are excluded from
   retrieval candidates, attachments, analytics registration, and
   catalog/meta answers — column names are sensitive too; when the
   provider is the local model or the extractive fallback they
   participate normally. Answers note exclusions honestly ("2 files
   skipped — marked private; switch to the private model to include
   them"). Explorer: a lock toggle on rows and in selection mode,
   visually distinct from the visibility eye; state persists in
   state.json (versioned, migration-safe for existing vaults). Parity
   tests: same fixture vault + cloud provider → identical candidate sets
   in both engines. E2E: mark a file, ask with a cloud provider
   configured (mocked endpoint), assert the file's content cannot appear
   in the outbound prompt and the skip note renders.

3. "What the AI sees" inspector (OpenSpec: add-file-inspector). From an
   explorer row menu, a read-only panel per file: extraction preview
   (the first N chars of exactly what the index holds, OCR-derived text
   flagged as such), chunk count + chunking mode (prose/tabular),
   detected columns + kinds for tabular files (the catalog computes
   this), index freshness (mtime/size key, last extracted), inclusion +
   local-only state in plain language ("Visible to AI · private-model
   only"), and a test-search box scoped to this file showing top
   matching chunks with scores. No mutations from this panel beyond the
   existing toggles. Desktop first; the twin renders the same panel
   minus desktop-only fields (PARITY).

4. Remove the dormant cloud connector; finish the focus cut.
   - Archive-then-delete the SharePoint/Microsoft connector from BOTH
     engines: src/server/sources/sharepoint.ts and
     src/server/sources/microsoft/, native/crates/lighthouse-core/src/
     sources/{microsoft.rs,sharepoint.rs}, the explorer's SharePoint
     coming-soon teaser (FileExplorer.tsx) and src/lib/comingSoon.ts if
     nothing else uses it, the SHAREPOINT_* env surface (config.ts,
     docs), and the /api/connect surface if now empty. KEEP the
     SourceConnector seam (types.ts, registry.ts, local.ts and their
     Rust twins) — the extension point survives, the unfinished cloud
     implementation does not. Archive branch:
     archive/sharepoint-connector.
   - Decision to present, not implement (ASK ME): demote the bundled
     Piper TTS voice to an opt-in download like the chat model (~60–90MB
     installer diet; removes the flakiest mirrored asset from the
     default build; read-aloud falls back to OS voices until installed).
     Estimate the work, await my answer.

Proof gates: grep-clean for sharepoint / SHAREPOINT / msal outside the
archive branch and history docs; provenance-stamp E2E on both an
on-device answer and a mocked cloud-provider answer; the local-only E2E
above; an inspector snapshot test against a fixture vault; full suites
green. End with a one-paragraph "what changed for a privacy reviewer"
summary and the two decisions awaiting my answer.
```

### G7 fragment (append to the §8 Track G prompt when running it)

```
G7 — Big-table streaming registration (amends add-tabular-scale).
    CSV/TSV/Parquet files register by path so DataFusion streams them —
    the per-file row cap stops applying to those formats (it exists to
    bound in-memory tables); workbook (xlsx/xls) registration keeps its
    materialized caps. Freshness footers and G1's truncation honesty
    stay accurate on both paths. Fixtures: a >100k-row CSV answering an
    aggregate correctly with no truncation note; a capped workbook still
    noting its cap. Also fold into G4: an evidence-pack export — one
    self-contained file per analytics answer (question, narrative,
    result table, chart, SQL, file provenance + freshness, timestamp)
    via the existing artifacts machinery.
```
