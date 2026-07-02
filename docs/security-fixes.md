# Security fixes log

A running record of security-relevant fixes, most recent first. Each entry notes
the issue, its pre-fix severity, the fix, and where it landed. Severities are
calibrated for a single-user local-first desktop app (an attacker who already
controls the user's machine is discounted; another device on the network, or the
vendor's cloud, counts as a real boundary crossed).

---

## 2026-07-02 — Regression fix: same-origin check broke all mutations (v0.2.5)

- **`isSameOrigin` 403'd the app's own requests** — _High (functional regression I
  introduced in v0.2.4)._ After the loopback-hardening changed the renderer to load
  `127.0.0.1`, the same-origin check compared `Origin.host` to `req.url.host` — but
  Next reports `req.url` host as `localhost`, so the `localhost` vs `127.0.0.1`
  mismatch rejected **every mutating POST** (file inclusion toggle, model install,
  upload, settings) with 403. Users saw file selection and local-model install as
  "broken." **Fix:** require the Origin to be a loopback host on the same port
  (rather than an exact host-string match); still blocks cross-site (non-loopback
  Origin), DNS-rebinding (non-loopback Host), other-loopback-port pages, and
  header-less callers lacking the token. Verified end-to-end + with a unit test
  covering all cases. `src/server/http.ts`.
- **Stale local-model detection** — `main.js findModel()` now requires the same
  ≥100 MB size as the picker's `installedModel()`, so a leftover stub/partial
  `.gguf` from an old install isn't loaded (and doesn't show a dead "Installed").
  With the 403 fixed, uninstall + reinstall now work to clear a cached model.
- **Subtle version badge** added (bottom-left, `NEXT_PUBLIC_APP_VERSION` from
  package.json) so the running build is identifiable.

---

## 2026-07-02 — Auto-updater (Phase A), lint gate, PII verification

- **Auto-updater implemented (Phase A, notify-only)** — `electron/updater.js`,
  `electron/preload.js`, `main.js`, `splash.html`. Checks for updates on launch
  during the splash (non-blocking, 8s-bounded, best-effort), and surfaces an
  "Update available" tray item / splash line that opens the release page. It
  **never downloads or executes an installer in-process** while builds are
  unsigned (electron-updater's hash is integrity, not authenticity). Auto-install
  stays gated behind `UPDATER_CAN_AUTO_INSTALL = false` until code signing +
  notarization land. The privileged "restart to update" IPC is gated to the boot
  window so live app content can't trigger an install. See
  `docs/auto-updater-design.md`.
- **Lint gate is now blocking** — `eslint@^8.57.1` + `eslint-config-next` pinned in
  devDependencies; `next lint` passes clean, so `release.yml`'s check job runs
  `npm run lint` as a hard gate (was advisory / `continue-on-error`).
- **Historical file-name PII purge — verified unnecessary.** Audited the Supabase
  backend (project `yyiqwpcqpohzyrzwyxqk`): the `click_events` table (the only
  place file/folder names were ever sent) is **empty (0 rows)**, as is `events`.
  No file/folder-name PII accumulated server-side, so no purge was needed. (The
  client-side leak was fixed on 2026-07-01; new events send only the coarse kind.)

---

## 2026-07-02 — Release hardening (v0.2.4, branch `feat/release-hardening-0.2.4`)

- **Bundled binaries/model fetched unpinned with no integrity check** — _Medium
  (supply chain)._ `scripts/fetch-local-model.mjs` resolved llama.cpp `latest` and
  the HF voice from `main` with an optional, unset SHA-256, so the executables baked
  into every installer were unverified.
  **Fix:** pin exact versions (llama.cpp `b9859`, piper `2023.11.14-2`, voice commit
  `e21c7de8…`) and verify each asset against a committed `ASSET_SHA256` map; the
  build now **fails closed** on any missing/mismatched digest. `--record` bootstraps
  digests on a version bump. `scripts/fetch-local-model.mjs`.
- **Installers unsigned / un-notarized** — _Medium (trust/UX)._ Added code-signing
  scaffolding that stays inert on unsigned builds and activates automatically once
  cert secrets are provided: `build/entitlements.mac.plist` (hardened-runtime),
  `build/notarize.cjs` (afterSign hook — no-ops without `APPLE_*`), `mac`
  hardenedRuntime/entitlements, and conditional signing env in `release.yml`
  (`CSC_IDENTITY_AUTO_DISCOVERY` gated on `secrets.CSC_LINK`). Certs are still
  required from the maintainer to actually sign; see `docs/auto-updater-design.md`
  §3 for the key-custody caveat (prefer cloud/HSM signing over a raw cert in CI).
- **Auto-updater** — designed (not yet implemented): `docs/auto-updater-design.md`
  — launch-time, splash-integrated, `electron-updater`, **notify-only while
  unsigned** (no in-process download/execute of unverifiable installers), flipping
  to auto-install only once signing + notarization are live.

---

## 2026-07-01 — Review remediation (branch `security/harden-review`)

Source: full multi-agent security + code-quality review of `origin/main` (v0.2.3),
adversarially verified. 43 findings triaged; the items below were fixed in code.

### Local API surface

- **Local API was reachable off-machine and failed open** — _High._
  `next start` bound to `0.0.0.0`, exposing every unauthenticated file/link/open
  route to the LAN, and `isSameOrigin()` returned `true` whenever the `Origin`
  header was absent (any curl/script/other-process bypassed it).
  **Fix:** bind the server to `127.0.0.1` only (`-H` + `HOSTNAME`); require a
  per-launch token (injected by the desktop shell) for header-less callers; add a
  loopback **Host allowlist** to defeat DNS rebinding; pin the top frame with a
  `will-navigate` guard. `electron/main.js`, `src/server/http.ts`.

- **Aggregate upload size was unbounded** — _Low (DoS)._ Added a 200 MB
  per-request cap on top of the existing per-file/count caps. `app/api/upload/route.ts`.

### Privacy & telemetry

- **Private file/folder names were sent to the vendor as "anonymous"** — _High._
  The file-tree click-capture logged `node.name`, shipped to the hosted usage
  endpoint keyed to the user's email + contact id.
  **Fix:** log only the coarse `folder`/`file` kind, never the name.
  `src/features/explorer/FileExplorer.tsx`.

- **Usage telemetry was opt-out and mislabeled** — _High (privacy/consent)._
  Capture defaulted to on and the checkbox said "anonymous."
  **Fix:** capture now defaults to **opted out**; the checkbox is unchecked by
  default with an accurate label (email + feature usage, never files/names/
  contents); a trial mint resets to opted-out; the explicit choice is persisted
  on both register and skip. `usage.ts`, `OnboardingPanel.tsx`, `license.ts`.

### Licensing & payments (Supabase Edge Function — requires deploy)

- **License forgery via public default secret + row-less token trust** — _Medium
  (revenue)._ `aesKey()` fell back to a source-committed default when
  `LICENSE_SECRET` was unset, and `check()` derived paid/trial standing from the
  token's own claims when no DB row existed.
  **Fix:** fail closed when `LICENSE_SECRET` is unset (handler degrades to a
  controlled error / offline grace, never a forgeable "valid"); require an
  authoritative DB row to grant entitlement — never trust decoded token claims for
  a row-less guid. `supabase/functions/license/index.ts`.
  _Takes effect on `supabase functions deploy license`; `LICENSE_SECRET` must be
  set first (it is)._

### Credentials & secrets at rest

- **State/credential files written world-readable and non-durably** — _Medium._
  `writeJson` used default perms and no fsync (OAuth tokens, model API key,
  curation state).
  **Fix:** write with owner-only `0600` perms + fsync data and directory.
  `src/server/config.ts`.

- **Microsoft OAuth tokens stored in the cloud-synced Documents vault** — _Medium._
  Long-lived refresh/access tokens (tenant-wide read scope) lived under the vault,
  which defaults to Documents (OneDrive/iCloud synced, backed up).
  **Fix:** store connector tokens in the app's private `userData` dir via
  `LIGHTHOUSE_CONNECTORS_DIR`. `config.ts`, `electron/main.js`.
  _Follow-up: full OS-keychain encryption (Electron `safeStorage`) needs a
  main-process IPC path — the Next server runs as plain Node._

### Connectors, model & build

- **Graph bearer token could be replayed to arbitrary URLs** — _Info._
  Paging follow-on URLs from Graph responses were fetched with the token attached.
  **Fix:** only ever send the token to `*.graph.microsoft.com`.
  `src/server/sources/microsoft/graph.ts`.

- **Prompt injection from retrieved document content** — _Low._ Retrieved text was
  concatenated into the LLM prompt with no instruction/data separation.
  **Fix:** fence context blocks and mark them untrusted in the system prompt.
  `src/server/llm.ts`.

- **PowerShell command injection in the build-time archive extractor** — _Low._
  An archive/asset name containing a `'` could break out of the `Expand-Archive`
  quotes. **Fix:** escape single quotes. `scripts/fetch-local-model.mjs`.

- **Installer could bundle runtime secret-state** — _Low._ Added electron-builder
  excludes for `.rag-vault/connectors`. `package.json`.

### Quality gates

- **No CI gate; `npm test` ran only the typechecker** — _High (quality)._
  Releases built + published with no typecheck/test/lint step.
  **Fix:** `release.yml` gains a `check` job (typecheck + tests hard-gate, lint
  advisory) that `build` depends on; `npm test` now runs the real suite; added a
  committed `.eslintrc.json`. _Follow-up: pin `eslint`/`eslint-config-next` and
  make lint blocking._

### Known / deferred (tracked, not yet fixed)

- **Installers ship unsigned/un-notarized** — SmartScreen/Gatekeeper blocks; needs
  signing certs in CI.
- **Model/binary downloads unpinned, no checksum** — supply-chain; pin version +
  commit SHA-256s.
- **npm audit: 12 advisories** — all in the build toolchain (electron-builder →
  tar/cacache/node-gyp), dev-time only, not shipped; resolve via a deliberate
  electron-builder bump.
- **Entitlement is client-side/honor-system** — server-side enforcement needs
  offline-verifiable (asymmetric-signed) licenses to avoid breaking offline use.
