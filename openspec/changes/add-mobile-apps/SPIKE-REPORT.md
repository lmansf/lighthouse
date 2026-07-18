# Mobile de-risking spike — report (add-mobile-apps §1)

**Status: IN PROGRESS.** This report is filled *only* from observed results.
Every criterion below is `PENDING` until a real build/run reports its verdict;
no line is marked PASS/FAIL/DEFERRED until there is evidence (a CI job
conclusion, a measured number, a captured error). This is the repo's
verification-honesty convention, and it is non-negotiable for a go/no-go gate.

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
| 1.1a | `lighthouse-core` compiles for `aarch64-apple-ios` (+ size) | PENDING | mobile-spike.yml `ios-core` job |
| 1.1b | `lighthouse-core` compiles for `aarch64-linux-android` (+ size, 16 KB align) | PENDING | mobile-spike.yml `android-core` job |
| 1.2 | TLS swap to `rustls-platform-verifier` (compiles on mobile; live HTTPS from sim/emulator) | PENDING | code change + live leg |
| 1.3 | Throwaway Tauri mobile scaffold answers the zero-network extractive ask on iOS sim + Android emulator | PENDING | scaffold + `SMOKE_DRIVER_JS` |
| 1.4 | Fluent UI v9 Menu/Popover/Dialog/focus behave in WKWebView + Android System WebView | PENDING | webview validation |

## Measurements

_(filled from CI step summaries as jobs complete)_

- iOS `liblighthouse_core` staticlib size: _pending_
- Android `liblighthouse_core` cdylib size: _pending_
- Android LOAD-segment alignment: _pending_

## Go / no-go

_Recorded once 1.1 (the compile gate) reports. Not before._
