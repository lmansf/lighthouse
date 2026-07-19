# Mobile de-risking spike — report (add-mobile-apps §1)

**Status: 1.1 PASS + 1.2a compile-PASS + 1.3 engine-leg PASS (Android),
all measured in CI; the remaining device legs (1.2b live-TLS, the 1.3
iOS-simulator engine leg + the Tauri-shell wrapping, 1.4 webview) DEFERRED with
evidence.** This
report is filled *only* from observed results. A line is marked PASS/FAIL only
where there is evidence (a CI job conclusion, a measured number, an on-device
log line); everything requiring a running iOS simulator, a full mobile project,
or the §0 store enrollments — none of which exist yet — is **DEFERRED with the
reason**, never claimed. This is the repo's verification-honesty convention,
non-negotiable for a go/no-go gate.

**Headline:** the single biggest named unknown — *does `lighthouse-core`
(DataFusion 54 + parquet/arrow + the pure-Rust extraction stack + ring/rustls +
notify) even cross-compile for the mobile triples?* — is **GREEN on both**
`aarch64-apple-ios` and `aarch64-linux-android`, observed in
`mobile-spike.yml` run #2 (`de097f8`). That is a strong GO signal for the
Tauri-2 strategy. It is not the *whole* gate: the device-dependent legs below
are deferred, so the full GO is "leaning yes, pending the deferred legs." **No
reroute is taken here** — the fallback ladder is an owner decision.

**Second signal (1.3 engine leg): the engine doesn't just compile — it RUNS on
Android.** The cross-compiled `lighthouse` CLI, pushed to a booted `x86_64`
API-34 emulator, answered the same grounded, zero-network `--local --json` ask
the desktop headless smoke uses: `exit=0`, the answer cites the fixture fact
("42"), `provenance.origin=device`, 0 tokens / 0 egress. So the pure-Rust
pipeline (extract → index → lexical retrieve → extractive answer) EXECUTES on
the Android runtime, not just links. This is the *engine* leg only (via the CLI,
arch-agnostic); the ask *inside the Tauri mobile shell*, and the same run on an
iOS simulator, remain deferred (they need the §2 crate split + booted app / a
macOS-simulator lane).

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
| 1.2a | TLS swap to `rustls-platform-verifier` **compiles + links** on both mobile triples | **PASS** | run #3 (`2724ab4`): `ios-core` + `android-core` both green with the swap wired into `llm.rs` |
| 1.2b | Live HTTPS handshake through the platform verifier from a booted sim/emulator | **DEFERRED** | needs a running device + the §2 scaffold |
| 1.3-engine (Android) | The zero-network extractive ask EXECUTES on a booted Android emulator — engine via the cross-compiled CLI (arch-agnostic), not yet the Tauri shell | **PASS** | `android-engine-smoke` green (run `29666664490`, commit `b134739`): on-device `SPIKE_RESULT … ran=yes exit=0 grounded_42=yes`; answer cites "42", `provenance.origin=device`, 0 tokens / 0 egress |
| 1.3-engine (iOS sim) | Same ask on an iOS simulator | **DEFERRED** | not run — needs a macOS + booted-simulator lane; only the Android emulator leg was stood up |
| 1.3-shell | The same ask INSIDE a Tauri mobile app (both platforms) | **DEFERRED** | needs the §2 crate split + `tauri ios/android init` app linking the lib crate; the engine leg above de-risks the pipeline, the shell wrapping remains |
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
- **TLS swap (1.2) compiles on both triples (run #3, `2724ab4`).**
  `rustls-platform-verifier` **0.5.3** resolves against the existing `rustls`
  0.23 + `ring` (one unified `rustls`, no duplicate), and the wiring
  (`ClientConfig::builder_with_provider(ring) → with_safe_default_protocol_versions
  → with_platform_verifier → with_no_client_auth`, handed to reqwest via
  `use_preconfigured_tls`) type-checks and links for both `aarch64-apple-ios`
  and `aarch64-linux-android`. Host `cargo check` stays green (the branch is
  `cfg`-compiled away off-mobile). The cross-compile cache grew 539 MB → 761 MB,
  reflecting the added rustls-platform-verifier / rustls / webpki artifacts. The
  Android-`rustls-native-certs`-is-broken blocker therefore has a compiling fix.
- **1.3 engine leg RUNS on Android (run `29666664490`, commit `b134739`).** The
  `lighthouse` CLI cross-compiled for `x86_64-linux-android`, pushed to a booted
  API-34 emulator (`Boot completed in 30292 ms`), answered
  `ask "What is the Q3 revenue target for the smoke test?" --vault … --local
  --json` on-device: `exit=0`; the extractive answer surfaces the fixture line
  "…the Q3 revenue target … is **42** million dollars" and `references` cites
  `docs/smoke-fixture.md` (score 1.0), with `provenance.origin=device`,
  `totalTokens=0`, `reported=false`. I.e. the local-model path fell back to
  passages and made ZERO network calls, so the mobile TLS branch stayed
  compiled-but-uncalled (no JVM/JNI is needed for `--local`). This proves the
  pure-Rust extract→index→retrieve→answer pipeline EXECUTES on the Android
  runtime, not just links. (The pushed `x86_64` CLI is ~116 MB unstripped — an
  executable on the emulator's arch, **NOT** a shipping-footprint number; the
  arm64 library budget is still proxied by the 7.2 MB iOS staticlib above.)

## Go / no-go

**Compile gate (1.1): GO.** DataFusion 54 + parquet/arrow, the pure-Rust
extraction/crypto stack (`ring`, `rustls`, `aes-gcm`, `pdf-extract`/`lopdf`,
`calamine`, `zip`+`quick-xml`, `ocrs`/`rten`), and `notify` all cross-compile
for both device triples with no source changes, within budget, 16 KB-aligned.
The named unknowns from design.md (DataFusion build scripts, `ring` asm, notify
kqueue on iOS, Android page alignment) are all cleared. **No `analytics`
feature-gate contingency is needed for compilation** — SQL analytics
cross-compiles as-is.

**TLS-swap compile leg (1.2a): now closed** in commit `2724ab4` — the
Android-`rustls-native-certs` blocker has a compiling fix, wired into the async
provider client and proven on both triples.

**Engine-execution leg (1.3 engine, Android): now closed** in commit `b134739`
(`android-engine-smoke` green) — the zero-network extract→retrieve→answer
pipeline runs on a booted Android emulator and produces a grounded, zero-egress
answer. This is the most reassuring runtime signal short of the full app: the
engine's cross-compiled code doesn't just link, it executes correctly on the
device runtime. The equivalent iOS-simulator engine leg was not run and stays
deferred.

**Full spike gate: not yet closed.** The remaining legs are all
**device-/shell-dependent**: 1.2b (a live HTTPS handshake through the platform
verifier from a booted device), the 1.3 *iOS-simulator* engine leg + the 1.3
*Tauri-shell* wrapping (the ask inside the actual mobile app, both platforms),
and 1.4 (Fluent in both webviews). They require the §0 Apple/Play enrollments,
the §2 crate split, `tauri ios/android init` projects, and a booted
iOS-simulator lane, which this spike did not stand up. The recommendation is
**proceed to stand those up** (they are now the only thing between here and a
GO), on the strength of the compile gate, the TLS-swap compile, and — now — the
engine actually executing a grounded zero-network ask on Android.

### Exact next steps to close the deferred legs
1. **1.2b** — the swap already compiles (1.2a done). Widen the
   `#[cfg(mobile)]` helper from `llm.rs` to the other client builders
   (`embed.rs`, `local_model.rs`, `provider_auth.rs`), then exercise a live
   provider models-list call from a booted simulator + emulator to confirm the
   platform verifier trusts a real chain end-to-end.
2. **1.3** — the Android *engine* leg is DONE (`android-engine-smoke`: the CLI
   proves the pipeline runs on the emulator). What remains: (a) the same engine
   leg on an **iOS simulator** — a macOS lane that cross-compiles the CLI for
   `aarch64-apple-ios-sim`, boots a simulator via `simctl`, seeds the fixture
   with `simctl get_app_container`, and asserts the extractive answer; (b) the
   **shell** leg on both platforms — `tauri ios init` / `tauri android init`
   throwaway projects linking a lib-crate `lighthouse-desktop` (the §2 crate
   split is the real prerequisite), port `SMOKE_DRIVER_JS`, and assert the ask
   answers inside the booted app.
3. **1.4** — with 1.3's app booted, drive Fluent v9 Menu/Popover/Dialog/focus
   in WKWebView + Android System WebView; validate `keyring` apple-native for
   the sealing secret.

_This spike proved the cheapest-to-falsify, highest-information criteria first —
the compile gate (1.1), the TLS-swap compile (1.2a), and the engine actually
executing a grounded zero-network ask on Android (1.3 engine leg) — and stopped
there with an honest ledger, leaving the iOS-simulator, live-TLS, Tauri-shell,
and webview legs deferred rather than half-standing-up the device lanes._
