# Mobile de-risking spike — report (add-mobile-apps §1)

**Status: 1.1 PASS (measured in CI); 1.2–1.4 DEFERRED with evidence.** This
report is filled *only* from observed results. A line is marked PASS/FAIL only
where there is evidence (a CI job conclusion, a measured number); everything
requiring a running simulator/emulator, a full mobile project, or the §0 store
enrollments — none of which exist yet — is **DEFERRED with the reason**, never
claimed. This is the repo's verification-honesty convention, non-negotiable for
a go/no-go gate.

**Headline:** the single biggest named unknown — *does `lighthouse-core`
(DataFusion 54 + parquet/arrow + the pure-Rust extraction stack + ring/rustls +
notify) even cross-compile for the mobile triples?* — is **GREEN on both**
`aarch64-apple-ios` and `aarch64-linux-android`, observed in
`mobile-spike.yml` run #2 (`de097f8`). That is a strong GO signal for the
Tauri-2 strategy. It is not the *whole* gate: the device-dependent legs below
are deferred, so the full GO is "leaning yes, pending the deferred legs." **No
reroute is taken here** — the fallback ladder is an owner decision.

## What this spike decides

Whether the **Tauri-2-on-the-existing-workspace** strategy (proposal decision 1)
is viable, or whether to fall back to the pre-agreed ladder
(`uniffi-bindgen-react-native` → native shells over UniFFI). **A FAIL does not
trigger a reroute here** — the fallback is an owner decision; this spike only
produces the evidence.

## Environment split (why results come from CI, not this container)

The change is authored in a dev container that can build **neither** mobile
triple — no Xcode iOS SDK, no Android NDK — and cannot build the desktop Tauri
crate (no webkit/gtk). So the actual cross-compiles, and any
simulator/emulator/webview legs, run in a **throwaway CI lane**
(`.github/workflows/mobile-spike.yml`, `workflow_dispatch`) on `macos-latest`
(iOS) and `ubuntu-latest` + NDK (Android). Anything not runnable there is
reported as **DEFERRED with the reason**, never claimed.

Stack risk going in (read from `native/Cargo.lock`): crypto backend is **`ring`**
(no `aws-lc-sys` — the easier cross-compile); `rustls-native-certs` is present
and is the Android-runtime-broken piece the TLS swap (1.2) targets — it still
*compiles*, so it does not block 1.1. Named unknowns from design.md: DataFusion
54 + parquet/arrow build scripts, `ring` asm for the device triples, `notify`
kqueue on iOS, and Android 16 KB page alignment.

## Exit criteria (from design.md "The spike is the gate")

Go requires all of: core compiled for both triples within the **< ~80 MB**
per-arch library budget; the Android cdylib **16 KB-page-aligned**; TLS verified
against a live provider from **simulator + emulator**; the zero-network
extractive ask answering on **both**; and Fluent UI v9 Menu/Popover/Dialog
behaving in **WKWebView + Android System WebView**.

## Results

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1.1a | `lighthouse-core` compiles for `aarch64-apple-ios` | **PASS** | `ios-core` job green (run #2, `de097f8`); staticlib linked |
| 1.1b | `lighthouse-core` compiles for `aarch64-linux-android` | **PASS** | `android-core` job green; cdylib linked |
| 1.1c | Android cdylib is 16 KB-page-aligned (Android 15) | **PASS** | LOAD alignment `0x4000` via `-Wl,-z,max-page-size=16384` |
| 1.1d | Per-arch library within the < ~80 MB budget | **PASS (preliminary)** | iOS self-contained staticlib slice **7.2 MB**; see caveat |
| 1.2 | TLS swap to `rustls-platform-verifier` (compiles on mobile; live HTTPS from sim/emulator) | **DEFERRED** | needs the reqwest/rustls provider unification worked over cross-compile cycles (§2) + a running device for the live leg |
| 1.3 | Throwaway Tauri scaffold answers the zero-network extractive ask on iOS sim + Android emulator | **DEFERRED** | needs `tauri ios/android init` projects + booted simulator/emulator (macOS/NDK CI) — heavier than a bare cross-compile lane |
| 1.4 | Fluent UI v9 Menu/Popover/Dialog/focus behave in WKWebView + Android System WebView | **DEFERRED** | needs the running app from 1.3 to inspect the live webview |

## Measurements (observed, `mobile-spike.yml` run #2, commit `de097f8`)

Toolchain: rustc **1.97.1**; Android **NDK r29** (`29.0.14206865`), linker
`aarch64-linux-android24-clang`; macOS-latest iOS SDK. Crypto backend `ring`
(no `aws-lc-sys`). Cold cross-compile ≈ 8 min/arch; warm ≈ 1–1.5 min.

- **iOS `liblighthouse_core.a` (staticlib): 7.2 MB** (7,597,904 bytes). A Rust
  staticlib bundles the referenced dependency closure, so this is a real early
  proxy for the engine's arm64 footprint — comfortably under the ~80 MB budget.
- **Android `liblighthouse_core.so` (cdylib): 0.4 MB** (446,688 bytes) —
  **NOT a valid footprint.** A bare `cdylib` of a lib crate with **no
  `extern "C"` exports** dead-code-eliminates almost everything: nothing in the
  C ABI references the engine, so the linker strips DataFusion et al. The
  *compile* is the real signal (PASS); the definitive per-arch `.so` size must
  be re-measured once the mobile shell (§3) exports real entry points that
  retain the engine. The 7.2 MB iOS staticlib is the trustworthy size proxy for
  now.
- **Android LOAD-segment alignment: `0x4000` (16 KB) — PASS.** Forced by the
  NDK linker flag; the Android-15 page-size requirement is satisfiable.

## Go / no-go

**Compile gate (1.1): GO.** DataFusion 54 + parquet/arrow, the pure-Rust
extraction/crypto stack (`ring`, `rustls`, `aes-gcm`, `pdf-extract`/`lopdf`,
`calamine`, `zip`+`quick-xml`, `ocrs`/`rten`), and `notify` all cross-compile
for both device triples with no source changes, within budget, 16 KB-aligned.
The named unknowns from design.md (DataFusion build scripts, `ring` asm, notify
kqueue on iOS, Android page alignment) are all cleared. **No `analytics`
feature-gate contingency is needed for compilation** — SQL analytics
cross-compiles as-is.

**Full spike gate: not yet closed.** The device-dependent legs (1.2 live TLS,
1.3 the zero-network ask on sim/emulator, 1.4 Fluent in both webviews) remain
DEFERRED — they require the §0 Apple/Play enrollments, `tauri ios/android init`
projects, and booted simulator/emulator lanes, which this spike did not stand
up. The recommendation is **proceed to stand those up** (they are now the only
thing between here and a GO), on the strength of the compile gate being green.

### Exact next steps to close the deferred legs
1. **1.2** — add `rustls-platform-verifier` as a mobile-target dep; unify its
   rustls/crypto-provider with reqwest's (`ring`), route the client builders
   (`llm.rs`, `embed.rs`, `local_model.rs`, `provider_auth.rs`) through one
   `#[cfg(mobile)]` helper via `use_preconfigured_tls`; re-run this lane to
   confirm it still cross-compiles, then a booted-simulator models-list call.
2. **1.3** — `tauri ios init` / `tauri android init` throwaway projects linking
   a lib-crate `lighthouse-desktop` (the §2 crate split is the real
   prerequisite); port `SMOKE_DRIVER_JS`; seed a fixture vault via
   `simctl get_app_container` / `adb push`; assert the extractive answer.
3. **1.4** — with 1.3's app booted, drive Fluent v9 Menu/Popover/Dialog/focus
   in WKWebView + Android System WebView; validate `keyring` apple-native for
   the sealing secret.

_This spike deliberately proved the cheapest-to-falsify, highest-information
criterion first (the compile gate) and stopped there with an honest ledger,
rather than half-standing-up the device lanes._
