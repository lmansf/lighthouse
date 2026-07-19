# Mobile apps — Lighthouse on iPhone, iPad, and Android

## Why

Lighthouse ends at the desk. The vault, the grounded chat, the analytics — all
of it lives on three desktop OSes, while the people it serves (the analyst with
a question on the train, the security director approving a deployment from a
tablet) carry phones. The 2026-07-18 mobile scoping effort audited every
subsystem and the mid-2026 mobile landscape and concluded the port is far more
tractable than a desktop app usually is:

- `lighthouse-core` is a clean in-process library — zero child processes, four
  existing shells (desktop/server/cli/mcp), env-configured paths, and a single
  audited entry (`ask::run_headless_ask`). A mobile shell is a **fifth
  consumer**, inheriting the audit log, egress ledger, sealed secrets, and
  managed-policy enforcement by construction.
- The whole document pipeline is pure Rust (pdf-extract/lopdf, calamine,
  zip+quick-xml, ocrs/rten OCR, aes-gcm, DataFusion) — it ports with a
  recompile, not a rewrite.
- The UI is a static-export SPA whose every `/api` call rides one transport
  chokepoint (`src/shell/tauriTransport.ts` → invoke/Channel) — the exact
  mechanism Tauri 2 carries unchanged to iOS and Android, and the same seam
  that already survived the Electron→Tauri swap with the React tree untouched.
  Of ~21,900 TSX lines, ~20k are reusable with touch retrofits.
- The degradation ladder (cloud provider → local model → zero-network
  extractive; hybrid → lexical retrieval; watcher → poll freshness) is
  designed-in and CI-proven — it is exactly the honest v1 mobile posture.

Four constraints shape the port and are accepted up front: iOS forbids child
processes (the supervised `llama-server` pair cannot exist — in-process
llama.cpp later, behind the existing `LIGHTHOUSE_LOCAL_LLM_URL` /
`LIGHTHOUSE_EMBED_URL` seams); the 4.2 GB Mistral-7B exceeds phone memory
ceilings (mobile local generation means a 1–4B tier, fast-follow); link-in-place
+ the live watcher cannot port (iOS bookmarks / Android SAF are different data
models with no reliable change events — v1 is copy-in with
reconcile-on-foreground); and distribution is store-mediated (the bespoke
minisign self-updater does not ship on mobile).

## Decisions (owner-resolved, 2026-07-18)

The scoping plan's open decisions are resolved as follows; this proposal is
authored against them:

1. **Strategy: Tauri 2 mobile targets on the existing workspace** (one
   codebase, one parity discipline, one release train). Fallback ladder if the
   de-risking spike fails is pre-agreed: `uniffi-bindgen-react-native`, then
   native SwiftUI/Compose shells over UniFFI. The desktop-paired companion app
   is a possible future change, never v1.
2. **Version line:** mobile is an approved rewrite-scale overhaul; it ships as
   **0.13.0**. Desktop patches continue on 0.12.x until the mobile change
   merges. Android `versionCode` uses Tauri's derived
   `major·10⁶ + minor·10³ + patch` (monotonic while patch < 1000). CLAUDE.md's
   versioning + release-mechanics sections are updated as part of this change
   (its Cargo.lock "×3 stamps" note is already stale — 5 crate stamps today).
3. **Promise divergences are approved and documented, never silent:** mobile v1
   is copy-into-vault (no link-in-place), reconcile-on-foreground (no live
   watcher), no 7B private model, and first-run OCR-model download is
   consent-gated so the "every outbound request user-initiated" egress contract
   stays checkable-against-code. Launch copy and `docs/data-flows.md` gain
   per-platform restatements.
4. **Local model posture:** v1 ships cloud providers + the zero-network
   extractive fallback only. Fast-follow one: in-process embeddings with the
   same 137 MB nomic GGUF (byte-identical embedding space). Fast-follow two: a
   device-RAM-gated 1–4B Q4_K_M generation tier, permissively-licensed models
   only (Apache-2.0/MIT — Qwen/Mistral-small/Phi class; no Gemma-term
   encumbrance). Both are follow-on changes, not this one.
5. **Client scope:** chat-first v1. **Universal iOS app** — iPhone gets the new
   navigation shell; iPad keeps a two-pane arrangement closest to desktop (it
   is the strongest Apple beachhead for the analyst persona). Android phones
   and tablets ship from the same responsive shell.
6. **Cross-device sync stays out.** Any sync backend remains a recorded policy
   reversal per `docs/data-flows.md`; the Files-app-visible vault is the manual
   transfer path.
7. **Store accounts:** owner enrolls the Apple Developer Program and registers
   a Google Play **organization** account (D-U-N-S; skips the 12-tester/14-day
   gate). No F-Droid/sideload channel for v1 (revisit after launch). Verify
   "Lighthouse" listing names and `app.lhvault` availability before
   first upload — the Play applicationId is immutable. The bundle/app identifier
   is `app.lhvault` across desktop, iOS, and Android (unified in 0.12.8).
8. **Crash reporting: none.** Telemetry stays deleted. Mobile gets a
   user-initiated, consent-gated diagnostics/log export instead.

## What Changes

- **Workspace restructure (§1):** split `lighthouse-desktop` (currently
  `[[bin]]`-only; Tauri mobile requires a lib crate) into a shared library
  carrying the engine-facing command layer (`commands.rs`, transport, smoke
  driver) plus a desktop bin; `cfg(desktop)`-gate the desktop-only half — tray,
  widget windows, whisper.rs hooks, global-shortcut, autostart, single-instance,
  window-state, the bespoke updater, and `supervise.rs` llama supervision (all
  confirmed to have no Tauri-mobile equivalent). Commit `tauri ios|android
  init` projects under the desktop crate's `gen/`.
- **Engine portability (§2):** cross-compile `lighthouse-core` for
  `aarch64-apple-ios` and `aarch64-linux-android` (timeboxed go/no-go spike
  first — DataFusion 54 + parquet codecs, `notify`/kqueue, binary size, and
  Android 16 KB page alignment are the named unknowns); swap TLS root discovery
  to `rustls-platform-verifier` on mobile targets (`rustls-native-certs` is
  known-broken on Android); mobile-tuned resource caps
  (`LIGHTHOUSE_INDEX_MAX_FILE_BYTES`, `LIGHTHOUSE_MAX_QUERY_CHUNKS` defaults)
  sized to the ~2–4 GB jetsam budget shared with the webview.
- **Mobile shell (§3):** `#[tauri::mobile_entry_point]` bootstrap mapping
  `bootstrap_env` to app-container paths; suspend/resume lifecycle reusing the
  background-conserve policy logic; share-sheet + document-picker ingestion
  into the existing copy-mode vault (`vault::add_file` / `/api/upload`); vault
  visible in the iOS Files app (`UIFileSharingEnabled` +
  `LSSupportsOpeningDocumentsInPlace`); vault, `secret.key`, and state excluded
  from iCloud/Android auto-backup; biometric app-lock (tauri-plugin-biometric)
  + screenshot protection on sensitive views; first-run consent-gated OCR-model
  download with pinned SHA-256s; foreground-only briefings/pins recheck via the
  engine's pure `due(now)` predicates.
- **Frontend touch pass (§4):** a phone navigation shell (drawer/stack over the
  existing self-contained nav panels) replacing `AppShell.tsx`/`Sidebar.tsx` on
  phones; iPad keeps two panes; per-row overflow menus replacing right-click
  context menus; hover-revealed actions made always-visible; the existing
  Attach-popover and Move-to submenu promoted to touch-primary (HTML5 drag-drop
  is dead on touch); `100dvh` + safe-area + keyboard-viewport fixes; Android
  back-button handling; chat history moved off webview `localStorage`
  (OS-evictable on mobile) to engine-side storage; 44 pt touch targets via the
  existing density/fontScale tokens; VoiceOver/TalkBack + Dynamic Type pass.
- **Release machinery (§5):** mobile build lanes (macOS/Xcode for iOS with App
  Store Connect API-key signing; NDK lane for Android under Play App Signing)
  following the existing secrets-gated fail-loud pattern; per-PR
  `cargo check --target aarch64-linux-android -p lighthouse-core` tripwire; the
  smoke gate re-plumbed — `SMOKE_DRIVER_JS` ports as-is (mobile keeps
  `__TAURI_INTERNALS__.invoke`), verdicts move to simctl/adb; store metadata
  (privacy labels, `PrivacyInfo.xcprivacy` required-reason declarations for the
  engine's file-timestamp APIs, `ITSAppUsesNonExemptEncryption` + BIS
  self-classification, `POST_NOTIFICATIONS`); TestFlight internal + Play
  internal tracks; version stamps extended per decision 2.
- **Docs + promises (§6):** per-platform promise restatement in launch copy,
  `docs/data-flows.md` (mobile egress contract: provider calls + consent-gated
  pinned downloads; the 6-hourly update-check GET does not exist on mobile),
  README platform matrix, CLAUDE.md release mechanics + versioning, and a new
  `docs/mobile.md` recording the divergence list and the fallback ladder.

Engine files/modules touched: `native/crates/lighthouse-desktop/` (crate split:
`Cargo.toml`, `main.rs`, `commands.rs`, `supervise.rs`, `whisper.rs`,
`boot_guard.rs`, `tauri.conf.json`, capabilities, new `lib.rs` + mobile entry),
`native/crates/lighthouse-core/src/{config.rs, settings.rs, embed.rs, watch.rs,
local_model.rs, ocr.rs, secrets.rs}` (mobile env/caps/gates; no wire-shape
changes), `native/Cargo.toml` (targets/profiles), `src/shell/` +
`src/features/` + `app/` (touch pass), `.github/workflows/` (new mobile lanes +
tripwire), `scripts/fetch-local-model.mjs` (mobile asset split). The TS twin
(`src/server/`) is untouched except PARITY comments — mobile binds the Rust
engine exclusively.

## Environment split (verification honesty)

This change is authored where neither the desktop crate (no webkit/gtk) nor the
mobile toolchains (no Xcode, no NDK) can build. Everything runnable in the dev
container is verified here — `lighthouse-core` tests, the TS twin suite, tsc,
lint, and the Android `cargo check` tripwire once an NDK lane exists in CI.
Built-app-only gates (simulator/emulator smoke, device testing, store
submission) are deferred to CI and the maintainer's machines and are documented
as deferred, never claimed.

## Non-goals

- **Local generation on mobile** — follow-on change (`add-mobile-local-inference`:
  in-process embeddings first, then the small-model tier).
- **Linked external folders on mobile** (security-scoped bookmarks / SAF tree
  grants, `Reference` schema evolution) — follow-on change
  (`add-mobile-linked-folders`).
- **Desktop-paired companion mode** (LAN bind + QR pairing + pinned TLS) —
  possible follow-on, requires its own security review and egress addendum.
- **Background execution** (BGTaskScheduler/WorkManager reconcile) — v1
  promises foreground freshness only.
- **Cross-device sync, accounts, telemetry, crash reporting** — out, per
  decisions 6 and 8.
- **SQL analytics on mobile is not cut by default** — it ships if the spike
  proves DataFusion cross-compiles within size/memory budgets; the contingency
  (a scoped `analytics` feature gate) is a spike outcome, not a plan change.
- **Widget/hotkey/whisper surfaces** — permanently desktop-only.
- **SharePoint connector on mobile** — stays dormant, as on desktop.
