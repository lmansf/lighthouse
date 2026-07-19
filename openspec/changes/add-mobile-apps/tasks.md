# Tasks — mobile apps (one PR per numbered section; §1 gates everything after it)

## 0. Enrollments + naming (owner, wall-clock — start immediately, blocks §5/§7 only)
- [ ] 0.1 Enroll the Apple Developer Program (also unblocks the dormant desktop
  macOS signing item in `docs/maintainer-provisioning.md`); create the App ID
  for `com.lighthouse.app` and verify the "Lighthouse" listing name.
- [ ] 0.2 Register the Google Play organization account (D-U-N-S); reserve the
  `com.lighthouse.app` applicationId (immutable after first upload) and verify
  the listing name.
- [ ] 0.3 Record store secrets in the repo's secrets-gated pattern (ASC API
  key, Apple Distribution cert, Android upload keystore, Play service
  account) — absent secrets must skip lanes loudly, never half-sign.

## 1. De-risking spike (timeboxed ~1 month; go/no-go for everything below)
- [x] 1.1 Cross-compile `lighthouse-core` for `aarch64-apple-ios` and
  `aarch64-linux-android`: resolve DataFusion 54 + parquet codec and
  `notify`/kqueue build issues; measure per-arch release-library size against
  the < ~80 MB budget; verify 16 KB page alignment on the Android cdylib.
  VERIFY: both `cargo build --target` invocations green in a scratch CI lane.
  — **PASS** (`mobile-spike.yml` run #2, `de097f8`): both triples cross-compile
  with NO source changes; DataFusion/parquet/arrow, ring asm, and notify all
  build. iOS staticlib slice 7.2 MB (< 80 MB); Android cdylib 16 KB-aligned
  (`0x4000`). See `SPIKE-REPORT.md` (incl. the DCE caveat on the bare-cdylib
  size). 1.2–1.4 remain DEFERRED (need device lanes + §0 enrollments).
- [~] 1.2 Swap TLS root discovery to `rustls-platform-verifier` behind a
  mobile-target cfg in `native/Cargo.toml` + the reqwest client constructors
  (`llm.rs`, `embed.rs`, `local_model.rs`, `updates.rs` call sites); prove a
  live HTTPS provider models-list call from simulator and emulator.
  — **1.2a COMPILE-PASS** (`mobile-spike.yml` run #3, `2724ab4`): the swap
  (`rustls-platform-verifier` 0.5.3 via `BuilderVerifierExt` + explicit ring
  provider, wired into `llm.rs` through `src/mobile_tls.rs`, cfg-gated to
  ios/android) compiles + links on both triples; host build byte-identical.
  1.2b (widen to the other clients + a live handshake from a booted device)
  stays DEFERRED — device lane not stood up.
- [~] 1.3 Scaffold a throwaway Tauri mobile app linking the lib crate; port
  `SMOKE_DRIVER_JS` and prove the zero-network extractive ask answers on iOS
  simulator and Android emulator (fixture vault seeded via
  `simctl get_app_container` / `adb push`).
  — **1.3 ENGINE LEG (Android) PASS** (`mobile-spike.yml` `android-engine-smoke`,
  run `29666664490`, commit `b134739`): the CLI cross-compiled for
  `x86_64-linux-android`, pushed to a booted API-34 emulator, answered the same
  grounded `--local --json` ask the desktop headless smoke uses — on-device
  `exit=0`, answer cites the fixture fact ("42"), `provenance.origin=device`,
  0 tokens / 0 egress. **iOS-simulator engine leg ALSO PASS** (`ios-engine-smoke`,
  commit `8a47091`, `aarch64-apple-ios-sim` via `xcrun simctl spawn`): same on-sim
  `exit=0` + grounded "42" + `origin=device`, 0 egress. Proves the pure-Rust
  extract→retrieve→answer pipeline EXECUTES on BOTH mobile runtimes. STILL
  DEFERRED: the Tauri-**shell** wrapping on both platforms (needs the §2 crate
  split + a booted app). See `SPIKE-REPORT.md`.
- [ ] 1.4 Validate Fluent UI v9 Menu/Popover/Dialog/focus in WKWebView and
  Android System WebView; validate `keyring` apple-native on iOS for the
  sealing secret (file fallback is the recorded alternative).
- [ ] 1.5 Write the spike report into `docs/mobile.md` (§7.1 seeds from it):
  measurements, pass/fail per exit criterion, and — on failure — the reroute
  recommendation per the pre-agreed ladder. GO decision recorded before §2.

## 2. Crate split (engine-side, desktop-neutral — lands first, ships alone)
- [ ] 2.1 Restructure `lighthouse-desktop` into lib + bin per design.md:
  `lib.rs` run-builder + `#[tauri::mobile_entry_point]`, `src/desktop/`
  modules behind `cfg(desktop)` (tray, widget, whisper, shortcuts, autostart,
  single-instance, window-state, boot_guard, updater loop, llama
  supervision), crate-type `staticlib`/`cdylib`/`rlib` added. The 28 commands
  and `bootstrap_env` move unchanged. VERIFY: desktop builds byte-equivalent
  behavior (grep-verify every moved call site — the crate cannot compile in
  the dev container); `cargo check --target aarch64-linux-android -p
  lighthouse-desktop --lib` compiles with desktop modules absent.
- [ ] 2.2 Commit `tauri ios init` / `tauri android init` projects under
  `gen/`; wire icons via `tauri icon` from the existing source art
  (`scripts/gen-icons.mjs` gains the mobile outputs as committed artifacts).
- [ ] 2.3 Add the per-PR Android tripwire to `.github/workflows/native.yml`:
  NDK setup + `cargo check --target aarch64-linux-android -p lighthouse-core`.
  VERIFY: tripwire red on a deliberately non-portable draft commit, green on
  revert.

## 3. Mobile shell (engine before UI: §3 lands before §4)
- [ ] 3.1 `src/mobile/` bootstrap: app-container path mapping for
  `bootstrap_env` (VAULT_DIR in app Documents, state/models/connectors dirs),
  mobile-tuned engine cap envs per design.md, suspend/resume lifecycle events
  driving the existing background-conserve policy logic (park pollers, no
  timers while suspended).
- [ ] 3.2 Backup exclusion: `isExcludedFromBackup` on vault/state/`secret.key`
  (iOS) and `android:allowBackup=false` + `dataExtractionRules` (Android);
  unit-test the iOS attribute application on the paths the shell creates.
- [ ] 3.3 Ingestion: share-sheet target + document-picker flows feeding
  `vault::add_file` (copy-in); iOS Files-app exposure via plist keys; Android
  ACTION_SEND/OPEN_DOCUMENT handling. Multi-file, size-capped per the
  existing upload limits, with the existing dedupe/trash semantics.
- [ ] 3.4 First-run consent flow for the OCR models: consent screen →
  pinned-SHA-256 download from the mirror release (reuse the digest +
  resumable machinery), decline → name-findable degrade + re-offer in
  settings. Egress-ledger entries recorded for the downloads.
- [ ] 3.5 App-lock: tauri-plugin-biometric gate (opt-in at onboarding),
  snapshot redaction on iOS, `FLAG_SECURE` on Android for vault/chat views.
- [ ] 3.6 Foreground briefings/pins recheck: poll the engine's `due(now)`
  predicates on activation; `POST_NOTIFICATIONS` runtime request before the
  first alert on Android 13+.
- [ ] 3.7 Chat-history store: engine-side history file in the app-state dir
  behind the existing persist-consent semantics; `useChatStore` reads/writes
  through the transport on mobile (PARITY comment for the desktop
  localStorage path). Tests in both engines for the new store file's
  round-trip + consent-delete.

## 4. Frontend touch pass (after §3; sequenced over the usability patch's files)
- [ ] 4.1 Phone navigation shell (drawer + stack) hosting the existing nav
  panels; iPad two-pane at ≥700 pt; mobile detection via the shell capability
  flag (the existing `useRagStore.desktop` pattern, not user-agent sniffing).
- [ ] 4.2 Touch interaction retrofits: per-row overflow menu in
  `FileExplorer.tsx` carrying the context-menu action set; always-visible row
  actions at mobile density; Attach-popover and Move-to promoted as primary;
  44 pt targets via density/fontScale tokens.
- [ ] 4.3 Platform chrome: `100dvh` + safe-area insets + keyboard-viewport
  handling; Android back-button stack behavior; `AnalyticsChart` responsive
  sizing; onboarding/settings small-screen pass; desktop-only settings keys
  hidden by the capability flag.
- [ ] 4.4 Accessibility: VoiceOver/TalkBack labels + focus order on the new
  shell; Dynamic Type/system font scale mapped onto fontScale tokens.
- [ ] 4.5 Web E2E (Playwright, mobile viewports): navigation shell, ingestion
  → ask → cited answer, overflow-menu actions, back-button flows,
  keyboard-viewport composer. Screenshots at iPhone/iPad/Android-phone sizes.
  DEFERRED (built app): on-device gesture/IME verification.

## 5. Release machinery (needs §0 secrets; store uploads manual-first)
- [ ] 5.1 `mobile-build.yml`: iOS lane (macOS runner, Xcode, rust targets,
  ASC API-key signing, TestFlight upload) + Android lane (NDK, signed AAB
  under Play App Signing) — secrets-gated fail-loud; first uploads to each
  store performed manually per store requirements, then automated.
- [ ] 5.2 `mobile-smoke.yml`: simulator + emulator boot-and-ask gate running
  the ported smoke driver, verdicts via device-log scrape; required check for
  mobile store lanes only.
- [ ] 5.3 Store metadata: privacy labels / Data safety form (zero ambient
  egress story), `PrivacyInfo.xcprivacy` with required-reason file-timestamp
  declarations, `ITSAppUsesNonExemptEncryption=true`, OS floors (iOS 16.1+,
  minSdk 30), review notes + demo vault fixture for App Review.
- [ ] 5.4 Extend `supply-chain.yml` to the Gradle tree (and pods if any):
  dependency audit + SBOM for the mobile projects.
- [ ] 5.5 Diagnostics export: user-initiated, consent-gated log/state bundle
  share-sheet flow (no crash reporting — decision 8); document retrieval path
  in `docs/mobile.md`.

## 6. Version + release (0.13.0)
- [ ] 6.1 Bump the five-stamp lockstep to 0.13.0; confirm Tauri-derived
  versionCode/CFBundleVersion in `gen/` follow; release notes led by the
  mobile launch; desktop ships the same 0.13.0 through the existing
  `desktop-release.yml` path.
- [ ] 6.2 TestFlight internal + Play internal-track rollout; physical-device
  matrix pass (min-floor iPhone, M-series iPad, mid-range Android) recorded
  in `docs/mobile.md`; store submission after mobile smoke green.

## 7. Docs + promises (author alongside; merge-blocking)
- [ ] 7.1 New `docs/mobile.md`: divergence list (copy-in, reconcile-on-
  foreground, no 7B, consent-gated first-run downloads), fallback ladder,
  spike report, device matrix, compliance calendar (BIS annual, Play
  target-API bumps, Apple renewal).
- [ ] 7.2 `docs/data-flows.md`: mobile egress restatement (provider calls +
  consent-gated pinned downloads; no update-check GET on mobile; store-
  mediated updates); README platform matrix + install section; launch-copy
  per-platform honest-limits lines.
- [ ] 7.3 CLAUDE.md: versioning note updated for the 0.13.0 decision, the
  stale Cargo.lock "×3" corrected to the real stamp count, release mechanics
  gains the mobile lanes + the Android tripwire + the gen/ stamp surfaces.

## 8. Full verification (final)
- [ ] 8.1 `cargo test --workspace` (native/), `node --test "test/**/*.test.mjs"`,
  `tsc --noEmit`, `next lint`, Playwright E2E, Android tripwire green, mobile
  smoke green on both simulators, desktop release-smoke green on all three
  OSes (proving the crate split changed nothing on desktop).
