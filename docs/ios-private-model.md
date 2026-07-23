# On-device private model on iOS — Phase A spike & decision

**Status:** decided (spike gate). **Target release:** 0.13.5 (patch, per CLAUDE.md
versioning policy — an on-device narration backend is a feature, not a rewrite).
**Author dated:** 2026-07-20. **Owner sign-off:** pending.
**§42 Phase-A refresh (2026-07-23):** §4 re-verified on the current toolchain for
the Tier-2 build (owner-queued §42, full-ship order). Tier-1 shipped in 0.13.5+
as decided; the loopback bridge (§5 option 1) is live as
`PrivateModelServer.swift`, and the §6 tiered budgeter is live (§32). Refreshed
facts below are marked "(§42 refresh)".

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
  0.13.5, so the roster is honest from day one. **0.13.5 scope = Tier-1
  (Foundation Models) + the seam + the availability reversal.** Tier-2's bundled
  GGUF, its `increased-memory-limit` entitlement (§4), and Background Assets
  delivery (§5) land in a follow-up (0.13.6+) — none of them are needed for a
  Tier-1 device, and deferring them keeps 0.13.5 free of the llama.cpp-iOS build
  and the ~1 GB payload.
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

**(§42 refresh, verified 2026-07-23 against llama.cpp master):**

- `build-xcframework.sh` exists at the repo root and is the canonical Apple
  route (note: `docs/build.md` no longer documents iOS at all — cite the script,
  not the doc). It builds iOS **device** (`-DCMAKE_SYSTEM_NAME=iOS
  -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES="arm64"`) and
  **simulator** (`-DCMAKE_OSX_SYSROOT=iphonesimulator
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"`) slices with **`-DGGML_METAL=ON
  -DGGML_METAL_EMBED_LIBRARY=ON`** on both, combines the static libs into
  per-platform dynamic libraries, generates dSYMs "for App Store validation",
  and assembles the XCFramework. Embedding the Metal shader library avoids a
  loose `.metallib` (an App-Store validation trap).
  [build-xcframework.sh](https://github.com/ggml-org/llama.cpp/blob/master/build-xcframework.sh)
- **Deployment-floor conflict (new finding):** the script pins
  `IOS_MIN_OS_VERSION=16.4`, while our committed `project.yml`
  `deploymentTarget` is **iOS 14.0**. Embedding a framework whose minOS
  exceeds the app's trips store validation. Phase B decision rule: **first**
  try overriding `IOS_MIN_OS_VERSION` to our floor (it is a plain variable; no
  evidence llama.cpp needs ≥16.4 APIs) and let the ios-build lane prove it;
  **only if that fails**, raising the app floor is an owner decision (it would
  drop iPhone 6s/7/SE1-class devices from the whole app — all 2–3 GB devices
  that are below the Tier-2 memory bar anyway, but the app itself currently
  supports them). Do not raise the floor silently.
- **`llama-cpp-2` (utilityai) still has no iOS support** (re-checked
  2026-07-23: `llama-cpp-sys-2`'s build.rs wires Android NDK cross-compiles
  only; nothing for the iOS toolchain). **Decision reaffirmed: build llama.cpp
  ourselves via `build-xcframework.sh` and FFI directly through a thin
  in-repo `-sys` shim** (full control of iOS+Metal flags, no third-party build
  script between us and the store).
  [llama-cpp-sys-2 build.rs](https://docs.rs/crate/llama-cpp-sys-2/latest/source/build.rs)
- **No JIT anywhere**: llama.cpp inference is ahead-of-time compiled code +
  Metal shaders (embedded, compiled by the OS's Metal stack) — no runtime
  code generation, satisfying iOS's no-JIT rule by construction.
- Metal compute in-process needs **no entitlement**; the constraint is **memory**
  (§4.3). The xcframework compile itself is macOS-only — the dev container
  verifies flags/routes from upstream; the `ios-build` lane is where the
  framework actually builds (same CI split as §3.7).

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
Apache/MIT (matches the proposal's "no Gemma-term encumbrance").

**(§42 refresh — asset pinned, 2026-07-23):**

- **Primary:** `qwen2.5-1.5b-instruct-q4_k_m.gguf` from the **official**
  `Qwen/Qwen2.5-1.5B-Instruct-GGUF` repo — **1.12 GB**, **Apache-2.0**.
  Consent copy says "~1.1 GB" (the earlier 0.9–1.0 GB estimate was low).
- **Fallback:** `HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF` Q4_K_M —
  **1.06 GB**, **Apache-2.0**.
- **Attribution (About screen, verbatim):** "Includes Qwen2.5-1.5B-Instruct ©
  Alibaba Cloud, used under the Apache License 2.0." (If the fallback ships
  instead: "Includes SmolLM2-1.7B-Instruct © Hugging Face, used under the
  Apache License 2.0.") Apache-2.0 obligations: ship the license text and
  preserve the copyright/NOTICE attribution — the license text lands beside
  the existing third-party notices.
- **Byte-exact size + SHA256 of the download artifact are pinned in Phase B
  §2** from the macOS lane: `huggingface.co` is egress-blocked in the dev
  container (policy 403 — recorded honestly, not routed around). The user's
  device downloads from the official repo's resolve URL; the egress-ledger
  entry records the real final host (Hugging Face CDN) + purpose, mirroring
  the desktop model download's ledger shape.

### 4.3 Memory

Add **`com.apple.developer.kernel.increased-memory-limit`** (the iOS entitlements
file is currently empty) — justified in the Phase B PR as needed to hold a ~1 GB
model + KV cache. It is honored only on some devices, so Tier-2 **must** call
`os_proc_available_memory()` before load and **degrade to extractive** if the budget
is short. No JIT anywhere (iOS forbids it). [entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit)

**(§42 refresh — the real numbers and the bar, 2026-07-23):**

- **KV-cache math** (Qwen2.5-1.5B: 28 layers, GQA 2 KV heads, head_dim 128,
  f16 KV): 2 × 28 × 2 × 128 × 2 B = **28,672 B/token ≈ 28 KiB/token**. At the
  chosen context that is **168 MiB @ 6144** (224 MiB @ 8192, 112 MiB @ 4096).
- **Chosen advertised context: 6144.** The model natively supports far more,
  but 6144 keeps KV ≤ 168 MiB, matches the desktop llama tier's proven §36
  budget shape, and `/health` advertises it so the tier machinery resolves
  honestly. Phase B registers a **distinct `llama-mobile` tier** (its own
  per-call-type output reserves per the §39 registry floor) rather than
  borrowing the desktop tier's entry.
- **Peak load estimate:** weights ~1,043 MiB (1.12 GB) + KV 168 MiB + Metal
  compute/scratch ~250 MiB + safety margin ~200 MiB ≈ **1.7 GiB required
  AVAILABLE at load time** (`os_proc_available_memory()` returns remaining
  headroom, so the app baseline is already excluded). **The Phase-A bar:
  refuse below 1.7 GiB available** — tune on device in Phase B, never lower
  than the measured real peak.
- **What that bar means in devices:** a 4 GB iPhone's default per-app limit
  (~2 GiB) minus a running app baseline leaves *just under* the bar — the
  entitlement is what clears it (raising the cap to ~3 GiB-class on 4 GB
  devices). 3 GB devices (iPhone XR/XS/SE2-class) cannot clear it even with
  the entitlement → honest "can't hold it" state. **Minimum device bar:
  4 GB-RAM iPhones (iPhone 11 and later, excluding 3 GB SE models)** — the
  "iPhone 12–14-class" acceptance target sits comfortably inside it.
- **Entitlement honesty (field-verified risk):** developer-forum reports show
  the raised limit sometimes **not taking effect in App Store/TestFlight
  builds** ([thread 770868](https://developer.apple.com/forums/thread/770868)).
  Consequence: the entitlement is a *request*, never an assumption — the
  pre-load `os_proc_available_memory()` check is the only truth, and the
  below-bar honest state must be reachable on ANY device. TestFlight
  acceptance must verify the raised limit on a real device build, not assume
  it from the entitlements file.

### 4.4 Delivery

**(§42 refresh — OWNER DECISION 2026-07-23, supersedes Background Assets):**
the model is delivered by **reusing the engine's own `local_model.rs` download
machinery** — resumable range requests, GGUF magic validation, byte-progress
UI — pointed at the pinned official model URL and storing under **Application
Support (the §41 state layout)**. Explicit user consent states the size
(~1.1 GB) before any bytes move; **wifi-only by default with a cellular
opt-in**; the download is user-initiated egress **recorded in the egress
ledger** (host + purpose) exactly like the desktop model download.
Resume/validate/uninstall paths are all first-class and tested. **Never
bundled** — the `.ipa` gains ~no size (CI payload assertion, §25 pattern).

Why not Background Assets (recorded for the record): one proven download
machinery across desktop + iOS (resume, validation, progress, ledger already
built and tested), full visibility in our own egress ledger, and no
system-managed downloader semantics between the user's consent and the bytes.
The prior paragraph's Background Assets route stays viable if App Review ever
objects — nothing in the engine seam cares which downloader filled the file.
App Review posture: model weights are **data, not executable code** (no JIT,
§4.1), downloaded after explicit consent — the standard ML-app pattern.

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

- **Phase B LANDED (0.14.1, §32 "token diet v2")** — the re-derived budget is
  the tiered budgeter, one seam in BOTH engines (`budget.rs` /
  `src/server/budget.ts`): tiers `apple-fm-4096` / `apple-fm-8192` /
  `llama-6144` / `remote-large`, per-call-type OUTPUT reserves (narration 900
  on the 4k tier), input sized to 90% of the window minus the reserve at
  chars/4, per-segment ceilings, and a deterministic drop planner with a
  refinement kernel. The tier resolves from the bridge's `/health`
  `contextSize` advertisement (this section's §3.3 pre-summarize note is now
  the §3c FACT SHEET: narration sees engine-computed counts + a row sample +
  labeled aggregates, never raw rows; the verified table rides `meta.table`).
  Overflow is a TWO-LAYER defense: the engine's 90% budget, then the bridge's
  pre-check, with `FM_OVERFLOW`/`FM_GUARDRAIL` terminal markers → an honest
  engine footer + a shell.log-only counter (zero expected in acceptance).
  `LIGHTHOUSE_FORCE_TIER` runs any local model under any tier — the
  device-free acceptance rig.
- **Warm-start** reuses the existing state machine (`warm_wait_verdict` /
  `warming_label`, `synth.rs:418-440`; pinned in `test/localWarmWait.test.mjs`):
  - **Tier-1 is resident** → `availability == .available` means no load latency →
    `warm_wait_verdict` returns `Proceed` immediately (no "warming up…").
  - **Tier-2 loads weights** → a *real* warm; the `is_local` guard (§5.1) flips on so
    the poll loop shows the honest "Private model warming up… (Ns)" during the GGUF
    load, then proceeds. `warming_label` strings stay byte-identical across twins.

### Guided-generation spike — verdict (0.14.1, §32 §7)

The loopback contract now carries a **dark** `POST /v1/intent` endpoint
(PrivateModelServer.swift) for structured-intent planning: the design is a
`@Generable` form over ENUMERATED schema elements (tables/columns the engine
supplies) from which the ENGINE compiles and validates SQL — the model never
writes SQL text and the single-SELECT guard stays intact. **Verdict: deferred,
endpoint dark.** The `@Generable` macro / `GenerationSchema` surface is not in
the stable-signature set PrivateModelServer.swift deliberately sticks to
across the iOS 26/27 SDKs (no-arg `LanguageModelSession` + String
`streamResponse` are), so the endpoint answers
`501 {"spike":"guided-gen","status":"dark"}` as a capability probe until that
surface stabilizes. No engine call site exists. Adopting guided generation for
NL→SQL intent is a recorded follow-up on the 0.14.1 PR.

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
3. **Exact Tier-2 GGUF byte size + license text** — RESOLVED (§42 refresh):
   asset + published size + license pinned in §4.2; the byte-exact size and
   SHA256 of the artifact are captured in Phase B §2 from the macOS lane
   (the dev container cannot reach huggingface.co — egress policy).
4. **Which bridge** (§5, loopback vs channel) — RESOLVED: loopback shipped
   (`PrivateModelServer.swift`); the Tier-2 llama backend answers the same
   in-process listener contract.
5. **Tier-1 generation** cannot be validated in CI (§3.7) — requires a physical
   Apple-Intelligence device; Phase B records this gap rather than faking a CI proof.
6. **(§42) Deployment-floor conflict** — `build-xcframework.sh` defaults to
   `IOS_MIN_OS_VERSION=16.4` vs our committed floor of iOS 14.0 (§4.1).
   Phase B tries overriding to our floor first; raising the app floor is an
   owner decision, never silent.
7. **(§42) Entitlement effectiveness in store builds** — field reports of the
   increased-memory-limit not applying in App Store builds (§4.3). The
   pre-load `os_proc_available_memory()` bar is the only truth; TestFlight
   device acceptance must verify the raised limit rather than assume it.
