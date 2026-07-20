# On-device private model on iOS — Phase A spike & decision

**Status:** decided (spike gate). **Target release:** 0.13.5 (patch, per CLAUDE.md
versioning policy — an on-device narration backend is a feature, not a rewrite).
**Author dated:** 2026-07-20. **Owner sign-off:** pending.

This is the decision gate for re-enabling a **private, on-device model on
iOS/iPadOS** — nothing leaves the device — as a **narration-tier** backend:
DataFusion still computes every number deterministically (`docs/analytics-beam.md`
— "the model never does arithmetic"); the on-device model only does NL→intent and
prose synthesis over already-computed tables. Nothing in Phase B may contradict
this document without updating it.

---

## 0. Provenance correction (read first)

The kickoff brief cited `docs/roadmap-personas-2026-07.md §23, §24, §27`. **Those
sections do not exist** — that file tops out at §22, and a repo-wide grep for
`§23|§24|§27` returns nothing. The mobile local-model decision this spike reverses
is **not** a roadmap section; its authoritative sources are:

- **`openspec/changes/add-mobile-apps/proposal.md` + `design.md`** (owner-resolved
  2026-07-18) — where mobile local generation was **deferred, not removed**, behind
  existing seams.
- In code, the mobile drop is tagged **"iOS field patch 1 §3"** (`fp1 §3`), one
  item in a field-patch *series* (fp1–fp4) — these `§N` are patch items, not
  roadmap sections.
- The reversal is **already named in the codebase**: `add-mobile-local-inference`
  (referenced 4× in `add-mobile-apps/{proposal,design}.md`). No change directory
  exists for it yet — **this spike doc is its precursor.**

Everything below is written against those real sources. The `add-mobile-apps`
proposal explicitly planned this reversal: *"in-process llama.cpp later, behind the
existing `LIGHTHOUSE_LOCAL_LLM_URL` / `LIGHTHOUSE_EMBED_URL` seams"* and a
*"device-RAM-gated 1–4B Q4_K_M generation tier, permissively-licensed models only
(Apache-2.0/MIT … no Gemma-term encumbrance)."* This decision honors that plan.

---

## 1. Decision summary (TL;DR)

| | Tier-1 | Tier-2 | Below floor |
|---|---|---|---|
| **Backend** | Apple Foundation Models (`SystemLanguageModel`, on-device) | bundled small GGUF via llama.cpp + Metal, in-process | none |
| **Devices** | iOS/iPadOS 26+ **and** Apple-Intelligence-eligible (iPhone 15 Pro+, M1+ iPad, A17 Pro iPad mini) with AI enabled | iOS ≥ app floor with enough RAM for a ~1 GB model | anything else |
| **Download** | **zero** (weights are the OS's) | ~1 GB via **Background Assets** (opt-in, cellular-aware) | — |
| **Roster** | "private" provider present (sensible default — zero-setup, fully private) | "private" provider present after the model is on device | "private" **absent** — the existing empty-provider truths stand |

- **Ship Tier-1 first** behind the engine seam; **Tier-2 is a stageable
  follow-up** — but the seam **and** the availability verdict ship together in
  0.13.5, so the roster is honest from day one.
- **`PrivateCloudComputeLanguageModel` is EXCLUDED** — it is off-device. Staying on
  `SystemLanguageModel.default` guarantees we never construct it (§3.6).
- **App floor stays where it is today** (whatever the committed
  `IPHONEOS_DEPLOYMENT_TARGET` is — Phase B §0 confirms and does not lower it). The
  *model floor* (iOS 26 + eligible device) is stricter and is probed at runtime,
  never assumed from the app floor.

---

## 2. Why an on-device model at all (narration tier)

`synth.rs:1199-1203` already treats narration as **skippable**: with a model, one
`collect()` narrates over step *results* (never raw tables); with no model, "the
deterministic tables below ARE the answer." The on-device model plugs in at exactly
that narration layer and nowhere else. So:

- **Correctness is unaffected** by which model narrates — the numbers come from
  DataFusion. A weak 1.5B model narrating a correct table is still correct.
- This is what makes a small on-device model **sufficient**: it never has to be
  right about arithmetic, only fluent about a table it is handed.

---

## 3. Tier-1 — Apple Foundation Models (confirmed against current docs)

The on-device system LLM, framework introduced iOS/iPadOS/macOS **26.0** (WWDC25).

### 3.1 Availability probe
`SystemLanguageModel.default.availability` → `SystemLanguageModel.Availability`:
`.available` | `.unavailable(UnavailableReason)`, where `UnavailableReason`
(iOS 26+, exactly three) is `.appleIntelligenceNotEnabled`, `.deviceNotEligible`,
`.modelNotReady`. This is the single truth the roster keys off — the reason maps to
honest copy (§7).
[availability enum](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum)

### 3.2 Streaming — SNAPSHOTS, not deltas (key integration detail)
`session.streamResponse(to:options:)` → `LanguageModelSession.ResponseStream<String>`
(an `AsyncSequence`). **Its elements are cumulative snapshots** ("the partial
content generated so far"), **not** incremental deltas.

> **Design consequence:** the desktop transport (`stream_local` → `sse_deltas`,
> `llm.rs:932-980`) yields **deltas** (`Item = Result<String>`). The Swift boundary
> **must diff consecutive snapshots into deltas** before forwarding, so the engine's
> `DeltaStream` contract is met unchanged. This snapshot→delta adapter is the one
> genuinely new piece of streaming glue.

[streamResponse](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/streamresponse(to:options:)) ·
[ResponseStream](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/responsestream)

### 3.3 Context window: 4096 tokens
On-device model context = **4096 tokens** (input + instructions + output all count;
TN3193, WWDC26-241). iOS 26.4 added `contextSize` + `tokenCount(for:)` to measure
proactively. **This is smaller than the desktop 6144/7B budget** — the engine must
pre-summarize (§6). [TN3193](https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window)

### 3.4 Overflow + guardrail errors → clean fallback
- Overflow (**version-dependent — handle both**): iOS 26
  `LanguageModelSession.GenerationError.exceededContextWindowSize(_:)`; iOS 27 (beta)
  `GenerationError` is deprecated → `LanguageModelError.contextSizeExceeded(_:)`.
- Guardrail/refusal: `guardrailViolation(_:)` and `refusal(_:)`.

Either → the Swift backend signals a **clean fallback verdict** to the engine, which
then uses its existing extractive/templated narration (`synth.rs` skippable path).
**Never a crash; never raw error text to the user.**
[GenerationError](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/generationerror) ·
[LanguageModelError](https://developer.apple.com/documentation/foundationmodels/languagemodelerror)

### 3.5 Device/OS floor
Requires iOS 26 **and** an Apple-Intelligence device **with AI enabled**: iPhone
15 Pro / 15 Pro Max, iPhone 16+; iPad M1+ and iPad mini (A17 Pro); Mac M1+. Non-Pro
iPhone 15 and earlier are excluded — this is precisely why Tier-2 exists.
[device list](https://support.apple.com/en-us/121115)

### 3.6 Private Cloud Compute is excluded — cleanly
`PrivateCloudComputeLanguageModel` (iOS 27 beta) is a **separate class** constructed
explicitly (`LanguageModelSession(model: PrivateCloudComputeLanguageModel())`) and
gated by a managed entitlement. **We never construct it.** Using only
`SystemLanguageModel.default` is a structural guarantee the private path is
on-device. [PCC class](https://developer.apple.com/documentation/foundationmodels/privatecloudcomputelanguagemodel)

### 3.7 Simulator / CI reality (honesty flag)
Foundation Models runs in the Simulator **only** on an Apple-Intelligence-enabled
**macOS 26 Apple-Silicon host** (the simulator borrows the host's models); it cannot
be enabled in a VM. **A typical hosted/virtualized macOS CI runner will therefore
return `.unavailable` and cannot exercise real generation.**

> **Verification split:** CI (the `ios-build` lane) compiles + links the Swift
> backend and unit-tests the availability-gating + fallback paths. **Real on-device
> generation is device-gated**, verified on a physical Apple-Intelligence device —
> the same "only surfaces in real builds" convention CLAUDE.md already documents for
> the desktop crate. Phase B says so explicitly and does not pretend CI proves the
> generation path. [forum thread 787199](https://developer.apple.com/forums/thread/787199)

### 3.8 iOS 27 provider protocol (noted, not adopted now)
iOS 27 (beta) adds `LanguageModel` / `LanguageModelExecutor` so third-party models
(e.g. MLX) can sit behind the same `LanguageModelSession` API. A concrete
`MLXLanguageModel` symbol is shown only illustratively in WWDC26-339, **not** in
Apple's reference — **unconfirmed**. Attractive as a future "Tier-1.5" (below-floor
devices reusing the session API with a bundled MLX model), but **out of scope for
0.13.5**: it is beta and unverified. Revisit at iOS 27 GA.

---

## 4. Tier-2 — bundled small GGUF (llama.cpp + Metal, in-process)

For eligible-OS-but-below-Apple-Intelligence devices (and as the deterministic
fallback wherever Tier-1 is unavailable but the device has the RAM).

### 4.1 Feasibility — confirmed, with cost
- llama.cpp **cross-compiles for `aarch64-apple-ios` with Metal** via CMake
  (`-DCMAKE_SYSTEM_NAME=iOS -DGGML_METAL_EMBED_LIBRARY=ON`; `build-xcframework.sh`
  produces device+simulator static libs). Embedding the Metal shader library avoids
  a loose `.metallib` (an App-Store validation trap). Static-link/dyld pitfalls are
  known and manageable (llama.cpp #10747/#10922).
  [build.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
- **`llama-cpp-2` (utilityai) has no iOS support** — its mobile feature is Android
  only, and `llama-cpp-sys-2`'s cmake/bindgen build is not wired for the iOS
  toolchain (needs `xcrun`/macOS). **Decision: build llama.cpp ourselves as a static
  lib / XCFramework and FFI directly through a thin `-sys` shim** (full control of
  iOS+Metal flags), rather than depend on `llama-cpp-2`. This is real engineering
  cost — flagged, and the reason Tier-2 is stageable behind Tier-1.
- Metal compute in-process needs **no entitlement**; the constraint is **memory**
  (§4.3). [llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs)

### 4.2 Model choice (Apache-2.0 only)
Narration-tier (fluent prose over a handed table, low world-knowledge demand) →
smallest clean model wins.

| Model | License | Q4_K_M ≈ | Notes |
|---|---|---|---|
| **Qwen2.5-1.5B-Instruct** (default pick) | Apache-2.0 | ~0.9–1.0 GB | non-reasoning, strong instruction-following, smallest |
| SmolLM2-1.7B-Instruct | Apache-2.0 | ~1.06 GB | predictable, purpose-built on-device |
| Qwen3-1.7B | Apache-2.0 | ~1.1–1.3 GB | run **non-thinking** mode (reasoning traces waste the 4k-ish budget) |
| Granite-3.3-2B-Instruct | Apache-2.0 | ~1.5 GB | strongest grounded-summarization; +~500 MB |

**Decision: default Tier-2 = Qwen2.5-1.5B-Instruct** (smallest, no reasoning
traces, clean narration); Granite-3.3-2B is the upgrade if narration quality proves
insufficient. **Explicitly avoid Llama-3.2-1B and Gemma** — custom licenses, not
Apache/MIT (matches the proposal's "no Gemma-term encumbrance"). The exact GGUF +
its byte size + license text are pinned in Phase B when the asset is chosen.

### 4.3 Memory
Add **`com.apple.developer.kernel.increased-memory-limit`** (the iOS entitlements
file is currently empty) — justified in the Phase B PR as needed to hold a ~1 GB
model + KV cache. It is honored only on some devices, so Tier-2 **must** call
`os_proc_available_memory()` before load and **degrade to extractive** if the budget
is short. No JIT anywhere (iOS forbids it). [entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit)

### 4.4 Delivery
Base app stays slim; the ~1 GB model ships via **Background Assets** (iOS 16+;
system-managed, optionally Apple-hosted; essential/prefetched/on-demand policies) —
Apple's current path over the legacy On-Demand Resources — respecting the
cellular-download opt-in. **Not** bundled in the base `.ipa`.
[Background Assets](https://developer.apple.com/documentation/backgroundassets)

---

## 5. The engine seam (how the desktop path stays byte-identical)

**Finding that shapes the design:** the desktop "local" path is **already the seam**.
`stream_answer` branches on `provider_id == "local"` (`llm.rs:496`) → `stream_local`
(`llm.rs:1153`), which POSTs the OpenAI-compatible `/v1/chat/completions` (+ `/health`)
contract at **`local_llm_url()`** (`llm.rs:110`, overridable via
`LIGHTHOUSE_LOCAL_LLM_URL`). **None of `stream_local` / `sse_deltas` / `local_health`
/ `SYSTEM_PROMPT` / `build_prompt` / the warm-wait machine is `#[cfg(desktop)]`** —
they are pure engine code. The only desktop-only piece is *supervising the server*
that answers that URL (`desktop/supervise.rs`, `cfg(desktop)`).

**Decision — introduce `PrivateModel` at the token-stream boundary, not by
rewriting `stream_local`:**

- Define a small `PrivateModel` seam in `lighthouse-core` = *build prompt (shared) →
  stream tokens → done*, yielding the existing `DeltaStream`
  (`Stream<Item = Result<String>>`). Prompt/label construction (`SYSTEM_PROMPT`
  `llm.rs:194` / `llm.ts:227`, `build_prompt` `llm.rs:196`) stays **shared and
  byte-identical across desktop + twin + iOS** (PARITY comments).
- **Desktop impl = the existing llama-server HTTP client, UNCHANGED** (`stream_local`
  as-is). Desktop rendering + streaming are bit-for-bit the 0.13.4 tree.
- **iOS impl** = a Swift Foundation-Models backend bridged into the same
  `DeltaStream`. Two viable bridges, decided in Phase B §2 (both keep the engine
  contract identical):
  1. **Loopback responder** — the iOS shell serves the `local_llm_url()`
     `/v1/chat/completions` + `/health` contract in-process (Foundation Models
     behind it), so `stream_local` literally works unchanged. Lowest engine churn;
     matches the proposal's "behind the existing seam" plan.
  2. **Tauri channel/FFI** — a thin mobile command streams Foundation-Models tokens
     over a channel that the engine adapts into `DeltaStream`.
  Either way the **snapshot→delta adapter (§3.2)** lives on the Swift side, and Swift
  stays thin (API calls only — the `lighthouse-desktop` grep-verify convention).
  Recommendation: prefer (1) for the smallest diff; confirm on device in Phase B.

### 5.1 The five availability choke points to reverse (all twin-mirrored + pinned)
`fp1 §3` removed the mobile private model with **platform-blanket** verdicts. Make
each **availability-driven** — true when an on-device transport is present for *this*
device — moving both engines together and updating the pin in the same commit:

| Verdict | Rust | TS twin | Pin to move |
|---|---|---|---|
| `local_model_supported` | `local_model.rs:138-140` | `localModel.ts:149-151` | `local_model.rs::local_model_supported_only_on_desktop`, `test/localModelPlatform.test.mjs` |
| roster filter `modelProvidersFor` | — | `src/contracts/mocks/providers.ts:82-86` | provider roster tests |
| default provider | `profile.rs:98-107` `default_provider_for` | `profile.ts:74-81` | `profile.rs::default_provider_is_platform_aware` |
| warm-wait `is_local` guard | `synth.rs:455-456` | `synth.ts:350-356` | `test/localWarmWait.test.mjs` |
| semantic/embeddings gate (future) | `semantic_enabled()` `is_desktop_app()` | twin | deferred with the embeddings tier |

The predicate becomes e.g. `local_model_available(platform, backend_present)` — on
desktop it stays `== "desktop"` (byte-identical), on iOS it consults the plugin's
availability verdict (Tier-1 available OR Tier-2 present). Below-floor → still
`false` → the `MOBILE_NO_PROVIDER_TRUTHS` empty state stands.

---

## 6. Context budget + warm-start

- **Pre-summarize to the 4096-token window** (§3.3): the engine already feeds
  narration the **step results / aggregated top-N table, never raw rows**
  (`synth.rs:1199`). Phase B re-derives the local prompt budget for the 1–4B tier
  (the proposal notes `llm.rs:976-1075` was tuned to 6144/7B and "must be re-derived
  … recorded [in add-mobile-local-inference]"). If the summarized context still
  overflows, catch the overflow error (§3.4) → extractive fallback.
- **Warm-start** reuses the existing state machine (`warm_wait_verdict` /
  `warming_label`, `synth.rs:418-440`; pinned in `test/localWarmWait.test.mjs`):
  - **Tier-1 is resident** → `availability == .available` means no load latency →
    `warm_wait_verdict` returns `Proceed` immediately (no "warming up…").
  - **Tier-2 loads weights** → a *real* warm; the `is_local` guard (§5.1) flips on so
    the poll loop shows the honest "Private model warming up… (Ns)" during the GGUF
    load, then proceeds. `warming_label` strings stay byte-identical across twins.

---

## 7. Roster & honest copy (availability-driven)

- Private provider (`providers.ts:22-32`, id `"local"`, label `"Local model
  (private)"`) reappears on iOS **only** when the plugin reports a usable backend for
  this device. On a Tier-1 device it is the **sensible default** (zero-setup, fully
  private) — `default_provider_for` selects it.
- **No download CTA for Tier-1** (nothing to download). Tier-2 shows a Background-
  Assets fetch, not the desktop llama-server download UI.
- New/adjusted labels (byte-pinned in Phase B, per-tier honest): e.g. "Runs on this
  device using Apple's on-device model" (Tier-1) / "…a built-in private model"
  (Tier-2). `model_status` already carries a first-class `"unsupported"` status
  (`local_model.rs` `Progress.status`; `localModel.ts:194`) — it becomes
  availability-aware; below-floor keeps `"unsupported"` + the two empty-provider
  truths (`MOBILE_NO_PROVIDER_TRUTHS`). The keyless `extractive` footer
  (`llm.rs:1286`, which names "the private local model") gets per-platform wording.

---

## 8. Twin-invariant impact

Per `docs/ts-twin.md`: prompt/label strings (`SYSTEM_PROMPT`, `build_prompt`,
`warming_label`, roster labels, `MOBILE_NO_PROVIDER_TRUTHS`) stay **byte-identical**
across `synth.rs`/`synth.ts`, `llm.rs`/`llm.ts`, `meta.rs`/`meta.ts` (PARITY
comments where they diverge). What **legitimately diverges** and therefore must be
**platform-gated, never asserted equal across engines**:

- **Transport** — in-process Swift/Foundation-Models vs loopback HTTP vs desktop
  llama-server (a PARITY comment at the seam).
- **Generated narration TEXT** — a different model produces different prose, so any
  golden-output equality test is **platform-gated**; only the *deterministic* tables
  / footers / SQL remain byte-comparable.

Pure logic — the availability verdict, tier selection, and context-budget/summarize
math — is tested in **both** cargo + node. `CACHE_VERSION` is **untouched** (no
extraction-semantics change).

---

## 9. Version

0.13.5, one patch level, seven stamps per CLAUDE.md (`package.json`,
`package-lock.json` ×2, `native/Cargo.toml`, `tauri.conf.json`, `native/Cargo.lock`
lighthouse-* crates by pattern, `gen/apple/project.yml`, `gen/apple/…/Info.plist`).
The Phase A doc commit itself carries no stamp bump; Phase B §6 bumps.

---

## 10. Open questions / to verify on device or at GA

1. **iOS 27 error rename** `exceededContextWindowSize` → `contextSizeExceeded` is
   beta — the Swift backend handles both spellings; confirm the final symbol at GA.
2. **`MLXLanguageModel`** concrete symbol/owner (§3.8) — protocol is real, conformer
   illustrative; verify against the shipping SDK before any Tier-1.5 work.
3. **Exact Tier-2 GGUF byte size + license text** — pinned when the specific asset
   is selected in Phase B.
4. **Which bridge** (§5, loopback vs channel) — decide on device by smallest diff /
   best latency; both preserve the engine contract.
5. **Tier-1 generation** cannot be validated in CI (§3.7) — requires a physical
   Apple-Intelligence device; Phase B records this gap rather than faking a CI proof.
