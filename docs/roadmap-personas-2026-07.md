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
