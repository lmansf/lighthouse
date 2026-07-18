# add-mobile-apps — design

## Shape: a fifth consumer, not a third engine

Mobile binds the **Rust engine exclusively**. There is no third parity
implementation and no new twin obligations: the TS twin stays the dev-flow +
parity oracle it is today (`docs/ts-twin.md` — "does not ship"), and every
shared behavior keeps landing in both engines exactly as now. Mobile-specific
behavior lives in the shell crate and the UI, never as engine forks. The
deliberate divergences below are PARITY-documented, not silent:

- **PARITY (platform): vault acquisition.** Desktop offers link-in-place
  references (`vault.rs` `Reference{path,name,kind}`, bare absolute paths);
  mobile v1 offers copy-in only (`vault::add_file` / `/api/upload` — existing
  code, no schema change). The `Reference` schema is untouched by this change;
  its evolution to bookmark/SAF representations belongs to
  `add-mobile-linked-folders`.
- **PARITY (platform): freshness.** Desktop runs the notify watcher; mobile
  runs the engine's designed watcher-less mode — per-query mtime+size
  revalidation plus a reconcile pass on every foreground activation. Correctness
  is identical by construction (`watch.rs:7-9` names this a first-class mode);
  only latency-to-notice differs, and the UI labels it honestly.
- **PARITY (platform): answer ladder.** Desktop: cloud → local 7B → extractive.
  Mobile v1: cloud → extractive (the local rung returns in
  `add-mobile-local-inference`). The ladder's engine code is unchanged — the
  local rung simply reports unavailable, which the engine already degrades
  through with an honest note (`llm.rs:453-496`).

## Crate split

`lighthouse-desktop` becomes lib + bin:

```
native/crates/lighthouse-desktop/
  src/lib.rs        — shared shell: run() builder, commands.rs (all 28),
                      transport plumbing, bootstrap_env, smoke driver,
                      #[tauri::mobile_entry_point]
  src/main.rs       — desktop bin: thin wrapper calling lib run()
  src/desktop/      — cfg(desktop): tray, widget windows, whisper.rs,
                      global-shortcut, autostart, single-instance,
                      window-state, boot_guard, updater (supervise.rs
                      update loop), llama supervision (supervise.rs)
  src/mobile/       — cfg(mobile): lifecycle (suspend/resume →
                      background-conserve policy reuse), share-sheet/
                      document-picker ingestion, app-lock, backup exclusion,
                      first-run asset consent flow
  gen/apple/, gen/android/  — committed tauri init projects
```

Crate-type gains `staticlib`/`cdylib`/`rlib` alongside the bin. The command
surface (28 `#[tauri::command]`s) moves to the lib **unchanged** — it is
already thin wrappers over `lighthouse-core`, and `tauriTransport.ts` carries
the same invoke/Channel contract on mobile webviews. Single-window design:
mobile multi-window exists since Tauri 2.11.0 but is its newest surface; the
widget/explorer satellite windows are desktop-only scope. The embedded axum
loopback server (`start_embedded_server`) stays desktop/dev-only; mobile is
pure-IPC (no TCP port, which is also the cleanest store-review posture).

Plugins: keep dialog/opener/notification (mobile-partial is sufficient — no
folder picker needed for copy-in v1), add biometric (mobile-only), gate the
six desktop-only plugins behind `cfg(desktop)`.

## Engine changes (small, wire-compatible)

- **TLS roots:** `reqwest`'s `rustls-tls-native-roots` swaps to
  `rustls-platform-verifier` on mobile targets (Android discovery is
  known-broken; iOS unverified). Desktop keeps its current stack. Cargo
  `[target.'cfg(any(target_os="ios",target_os="android"))'.dependencies]`
  split; no code-path divergence above the client constructor.
- **Mobile resource defaults:** the existing env-tunable caps get
  mobile-tuned defaults set by the shell at bootstrap (index max file bytes,
  max query chunks, OCR concurrency 1, analytics row caps) so the engine +
  WKWebView/System WebView coexist under a ~2–4 GB jetsam budget. No new
  settings keys — `bootstrap_env` sets the envs; `settings.rs` is untouched
  except hiding desktop-only keys from the mobile surface (runtime-gated in
  the UI exactly as `useRagStore.desktop` gates today).
- **Semantic gate:** unchanged in this change. `semantic_enabled()`'s
  `is_desktop_app()` check becomes a capability probe in
  `add-mobile-local-inference`; until then mobile is lexical-only by the
  existing ≥80%-coverage fallback design.
- **OCR models:** desktop bundles them; mobile downloads them first-run behind
  an explicit consent screen, pinned SHA-256s from the existing
  `mirror-hf-assets` release, verified with the digest discipline already in
  `fetch-local-model.mjs`. Until downloaded (or if declined), extraction
  degrades exactly as today when models are absent: files stay name-findable
  (`ocr.rs:75-114`), and the consent screen is re-offerable from settings.

## Failure degradation (rule-required)

Every mobile failure lands on an existing engine degradation, never a broken
answer: cloud-provider error → extractive fallback with the honest note;
OCR models absent → name-findable extraction; embeddings absent → lexical
retrieval (by design in v1); watcher absent → poll model (by design on
mobile); TLS/platform failure on egress → provider error path → extractive;
suspended mid-stream → the chat stream ends with the standard interrupted
state and the answer cache holds what was persisted. The **6144-token local
window does not bind v1** (no local model rung); it re-enters with
`add-mobile-local-inference`, where prompt budgets (`llm.rs:976-1075`, tuned
to 6144/7B) must be re-derived for the 1–4B tier's context sizes — recorded
there, not here.

## Data safety on a pocket device

- **Backup exclusion:** the vault dir, `.rag-vault` state, app-state dir, and
  above all `secret.key` are excluded from iCloud backup
  (`isExcludedFromBackup`) and Android backup (`android:allowBackup=false` +
  `dataExtractionRules`). Without this, OS backups silently upload documents
  and the sealing key to Apple/Google — a promise violation. The Files-app
  exposure (below) is the sanctioned way data leaves the sandbox.
- **Files-app exposure:** `UIFileSharingEnabled` +
  `LSSupportsOpeningDocumentsInPlace` make the vault a visible folder — the
  manual desktop↔mobile transfer path (decision 6: no sync).
- **App-lock:** biometric/passcode gate via tauri-plugin-biometric, opt-in at
  onboarding; app-switcher snapshot redaction and `FLAG_SECURE` on Android for
  vault and chat views.
- **Secrets:** the sealed AES-GCM store works as-is with the 0600-file
  sealing-secret fallback inside the sandbox. The `keychain` cargo feature
  (keyring: apple-native) is validated on iOS during the spike; if it passes,
  mobile enables it, else file fallback ships (acceptable in-sandbox) — either
  way byte-compatible `secrets.json`.
- **Chat history:** moves from webview `localStorage` (OS-evictable on mobile,
  origin-scheme-dependent) to engine-side storage via a settings-adjacent
  store file in the app-state dir, keeping the existing persist-consent
  semantics. Desktop keeps localStorage until a later unification — divergence
  is in the store layer (`useChatStore`), PARITY-commented.

## Frontend: one tree, two shells

The contracts/transport seam stays the single chokepoint. Phone: a new
navigation shell (drawer + stack) hosting the existing self-contained panels;
`ChatPanel` is already a narrow column. iPad ≥ ~700 pt width: two-pane layout
retaining Sidebar semantics (closest to desktop; Split View/Stage Manager
tested). Interaction retrofits are promotions of existing fallbacks, not new
flows: Attach-popover (already in the composer) replaces drag-to-chat; the
Move-to submenu moves into a per-row overflow menu replacing `openOnContext`
right-click; hover-revealed actions become always-visible at mobile densities
via the existing density/fontScale tokens. Platform chrome work: `100dvh`,
safe-area insets, keyboard viewport (Android visualViewport quirks), Android
back-button (stack pop, then background — never exit-on-back mid-flow),
`AnalyticsChart` responsive sizing. Accessibility pass: VoiceOver/TalkBack
labels on the new shell, Dynamic Type mapped onto fontScale, focus order.

## Release machinery

Two new reusable workflows rather than widening the 75-minute desktop matrix:
`mobile-build.yml` (iOS lane on macOS runners — Xcode, rust iOS targets,
ASC API-key signing, TestFlight upload; Android lane — NDK, AAB signed with
the upload keystore under Play App Signing, internal-track upload; both
secrets-gated fail-loud like desktop) and `mobile-smoke.yml` (simulator +
emulator boot running the ported `SMOKE_DRIVER_JS` — it drives
`__TAURI_INTERNALS__.invoke`, which mobile retains — with fixture seeding via
`simctl get_app_container`/`adb push` and verdicts scraped from device logs
instead of process exit codes). Mobile smoke gates mobile store submission
only; it does not block desktop publishing. Per-PR cheap tripwire in
`native.yml`: `cargo check --target aarch64-linux-android -p lighthouse-core`.
Version stamps: the five-file lockstep is unchanged; `gen/` projects derive
versionName/CFBundleShortVersionString from `tauri.conf.json` and versionCode
via Tauri's `major·10⁶ + minor·10³ + patch`. Store compliance artifacts live
in `gen/`: `PrivacyInfo.xcprivacy` (required-reason: file-timestamp APIs —
the engine's mtime freshness keys — plus UserDefaults if used),
`ITSAppUsesNonExemptEncryption=true` + annual BIS self-classification
(calendar item in docs/mobile.md), `POST_NOTIFICATIONS` runtime request
before the first briefing alert, OS floors iOS 16.1+ / Android minSdk 30.

## The spike is the gate

Nothing beyond §0/§1 of tasks.md starts until the timeboxed spike exits with:
core compiled for both triples inside size budget (< ~80 MB per-arch library
target), 16 KB-page-aligned Android cdylib, TLS verified against a live
provider endpoint on-device, extractive ask answering on simulator and
emulator, and Fluent v9 Menu/Popover/Dialog behaving in both webviews. Spike
failure modes route to the pre-agreed ladder (decision 1) — that reroute would
be a new proposal, not an amendment of this one; a DataFusion-only failure
routes to the scoped `analytics` feature-gate contingency instead (analytics
becomes desktop-only on mobile v1, pins/briefings re-run surfaces degrade to
stored-state rendering, exactly the twin's existing posture).
