# Lighthouse Native Rewrite — Scope & Feasibility Report

**Ask:** scope the requirements to rewrite Lighthouse in a faster, uniform, low-level
language, optimized for speed and efficiency — and report whether it is achievable.

**Verdict up front: achievable, with high confidence.** The recommended target is
**Rust** for 100 % of application logic, with **Tauri 2** as the desktop shell
(system webview instead of a bundled Chromium). Every capability the app has today
has a proven native-Rust equivalent, and the two heaviest compute components the
product bundles — `llama-server` (llama.cpp) and Piper TTS — are *already* native
C/C++ binaries that integrate more cleanly from Rust than they do from Node today.
Estimated effort is **11–19 engineer-weeks** for the recommended plan (§8). The
honest caveat: the single longest user-visible latency in the product — local-LLM
inference (~1 min/answer on a laptop CPU) — is already native and **does not get
faster** from an app rewrite; what gets dramatically faster is everything the app
layer itself does (§5).

---

## 1. What Lighthouse is today (baseline)

A local-first RAG vault: a desktop app in which users curate which files an AI can
see, with TF-IDF retrieval over included files and a grounded, streamed chat.

| Layer | Today | Size |
|---|---|---|
| Desktop shell | Electron 33 (`electron/main.js` + updater + preload) | 779 lines JS |
| Web/app server | Next.js 15 (App Router), spawned as a child process, loopback-only | 13 API routes, ~1,000 lines |
| Core engine | TypeScript in `src/server/` — vault walk/state, extraction, TF-IDF retrieval, LLM/TTS orchestration, licensing client, connectors | ~3,900 lines |
| UI | React 19 + Fluent UI 2 (Griffel), Zustand stores | ~4,800 lines TSX |
| Local inference | **llama.cpp `llama-server`** child process (native, bundled) | binary |
| Local TTS | **Piper** child process (native, bundled) | binary |
| Licensing backend | Supabase Edge Functions (Deno) + Stripe — server-side, out of app scope | 4 functions |

- **~11.5 k lines** of first-party TS/JS (excluding tests/scripts), **945 packages**
  in `package-lock.json`.
- Runtime stack at rest: Electron main process + Chromium renderer + a separate
  Node process running `next start` + (optionally) `llama-server`.
- The architecture's decoupling seam is `src/contracts/` (`RagService`,
  `ChatService`, `AuthService` interfaces) — features never import each other,
  they call the contracts. **This seam is what makes an incremental rewrite
  practical**: implementations behind the interfaces can be swapped without
  touching feature code.

### Wire protocol (must be preserved or transparently replaced)

- `POST /api/chat` → **NDJSON stream** of `ChatChunk` (`{delta, done}` lines; the
  final line carries `references`) — `app/api/chat/route.ts:49-69`.
- 12 further routes (`rag`, `upload`, `open`, `profile`, `settings`, `model`,
  `license`, `register`, `event`, `usage`, `connect`, `tts`) — JSON request/response,
  plus a WAV body from `tts`.
- Local-API auth: loopback bind + host allowlist + Origin check + per-launch
  `x-lighthouse-token` shared secret (`src/server/http.ts`) — exists only because
  the UI↔engine transport is an open TCP port.

---

## 2. Why the app feels slow today (measured from the code, not vibes)

The TS engine is correct but structurally bounded. The caps below exist purely to
protect Node's single event loop, and they cost retrieval quality:

| Bottleneck | Where | Consequence |
|---|---|---|
| Full synchronous re-walk of vault + every linked folder per API call, cached only 3 s | `vault.ts:93-106` (`WALK_TTL_MS`) | A large linked tree freezes the app ("blocks the server's event loop and the entire app reads as frozen" — the code's own words) |
| No persistent index: every query re-reads, re-chunks, re-tokenizes, re-scores every included file | `vault.ts:832-971` | Query latency grows linearly with corpus size; all work is discarded after each question |
| 1 MB per-file read cap | `vault.ts:573` | Content past the first megabyte is invisible to retrieval |
| 4,000-chunk global cap per query | `vault.ts:824` | Large vaults are silently truncated mid-corpus |
| Extraction on the query path (first touch), single-threaded | `extract.ts` + `vault.ts:884` | First query after adding PDFs pays full parse cost, serially |
| JS-based parsers: unpdf/pdf.js, mammoth, SheetJS | `extract.ts:41-63` | 5–50× slower than native parsers; parse cost is why extraction had to be cached and capped |
| Piper spawned per request, ~0.5–1 s model load each time | `tts.ts:14-17` (the file says "revisit with a persistent process") | Read-aloud has a fixed per-answer stall |
| UI polls the full tree every 4 s (plus focus/visibility refreshes) because `fs.watch` is unreliable cross-platform | `src/shell/AppShell.tsx` | Combined with the 3 s server walk cache, the vault is re-walked near-continuously even when idle |
| Usage telemetry ring buffer re-parses and rewrites the whole JSONL file on every append | `src/server/usage.ts` | O(buffer) disk work per batch of click events (capped 5,000 events / ~1 MB) |
| Uploads fully buffered in memory | `app/api/upload/route.ts` | The 25 MB/file, 50-file, 200 MB/request caps exist to bound Node heap; streaming writes remove the constraint |
| Electron + separate Next server + V8 | `electron/main.js:265-306` | ~hundreds of MB idle RSS across 3+ processes; multi-second cold start behind a splash screen (`waitForServer` polls up to 40 s) |

What is **already fast** and will not improve: llama.cpp inference, Piper synthesis,
Anthropic API latency, model download bandwidth. These dominate perceived chat
latency when they are active. A rewrite improves everything *around* them —
retrieval, indexing, extraction, startup, memory, footprint — and removes the
event-loop fragility class entirely.

---

## 3. Functional requirements inventory (what a rewrite must reproduce)

Grouped by subsystem; each is a hard requirement unless marked optional.

### 3.1 Vault & curation engine (`src/server/vault.ts`, `config.ts`)
- Directory walk → `FileNode` tree; POSIX-relative ids; dotfile skip; folder recursion.
- **References (link-in-place)**: `extN` id namespace, overlap rejection,
  idempotent re-link, descendant resolution; never copies or deletes real files.
- Inclusion model: explicit per-node flags, **ancestor-exclusion wins**, default
  from A/B experiment (`opt_in`/`opt_out`), server-authoritative intersection at
  query time.
- Ops: `setIncluded` (recursive), `moveNode` (flag remapping), `addFile`
  (collision suffixes), `addReference`/`removeReference`, `removeFromVault`
  (recoverable trash `.rag-vault/trash/<date>/`), `setSourceAvailable`.
- State: `vault/.rag-vault/state.json`; **atomic + fsync'd writes, 0600 perms**
  (`config.ts:129-152`); path-escape guards on every id→path resolution.
- Privacy-safe presence telemetry (counts only, no names) diffed per scan.

### 3.2 Retrieval
- TF-IDF cosine over 120-word chunks (25 overlap) + filename/path match blend
  (+0.2 nudge), singularizer, stop-words; name-only synthetic candidates scored
  0.5–0.9; per-file best-chunk references, top-k contexts, score normalization.
- **Catalog/listing intent**: "show me all files / list my datasets / how many
  PDFs" enumerates rather than ranks, with kind/extension narrowing
  (`vault.ts:667-799`).
- Attachment scoping: explicit per-question file set bypasses the global
  included set.

### 3.3 Document extraction (`src/server/extract.ts`)
- PDF, DOCX, XLSX/XLS → text; lazy parser load; **disk cache keyed
  mtime+size**, versioned schema, failures logged and *not* cached; 64 MB source
  cap, 1 MB output clamp (byte-accurate on UTF-8).
- Graceful degradation: unparseable file stays findable by name.

### 3.4 Chat & model orchestration (`src/server/llm.ts`, `localModel.ts`)
- Three providers behind one streaming generator: **Anthropic Messages API**
  (SSE over fetch, no SDK), **local OpenAI-compatible server** (llama-server /
  Ollama / LM Studio; 120 s header timeout for cold model load), **extractive
  no-network fallback** (word-paced streaming).
- Grounded system prompt with citation contract `[n]`; history threading (last 8
  turns), retrieval-query blending for bare follow-ups.
- **Model lifecycle**: on-demand 4.2 GB GGUF download from Hugging Face
  (redirect-following, `.part` temp + rename, Content-Length verification,
  progress polling), GGUF magic validation, uninstall via marker-file handshake
  with the shell (mmap-lock aware), llama-server supervision on
  `127.0.0.1:8080`.

### 3.5 TTS (`src/server/tts.ts`, `src/lib/speech.ts`)
- Piper synth → WAV; bundled voice discovery; espeak-ng data path; Web Speech
  API fallback in the UI when not bundled; capability probe endpoint.

### 3.6 Desktop shell (`electron/main.js`, `updater.js`, `preload.js`)
- Window + splash + error page; tray with hide-to-tray close; single instance;
  launch-at-login (opt-out, persisted); native dialogs (add files/folder, link
  in place, choose vault); open-cited-file natively; open external links in OS
  browser; navigation pinning + CSP injection; per-launch API token; child
  process supervision (Next server, llama-server) with log files; auto-updater
  (notify-only Phase A today, gated install path; GitHub releases feed).

### 3.7 Licensing & accounts (client side of `src/server/license.ts`, `usage.ts`, `experiment.ts`, `profile.ts`)
- 14-day repeatable trial + optional $14.99/mo subscription (`PAID_ENABLED`
  gate). Three operating modes: **hosted** (POST `{op:start|check|…}` to a
  Supabase Edge Function with a public URL + anon key), **local-dev**
  (self-contained AES-256-GCM licensing behind `LICENSE_ENFORCE`), and
  **disabled**. **Secrets live only in the Edge Functions**; lock is a UI
  state, the vault is never touched; Stripe checkout opens in the OS browser
  and the store polls `check` (up to ~10 min) to unlock. All telemetry is
  best-effort and error-swallowed so a failure can never break a launch.
- Usage click-telemetry: consent-gated (off by default), coarse
  type+label only (never file names), JSONL ring buffer, batched publish.
  A/B experiment assignment: pilot-email override → server-balanced →
  deterministic SHA-256-of-contactId fallback, resolved once per install.
- Local state files under `.rag-vault/`: `profile.json` (provider/model/key —
  key never sent to the client, only `hasApiKey`), `license.json`,
  `identity.json`, `contact.json`, `launch.json`, `usage.json`,
  `experiments.json`. **The Supabase/Stripe backend is out of rewrite scope** —
  it is not part of the desktop runtime.

### 3.8 Cloud connectors (`src/server/sources/`)
- `SourceConnector` trait/interface + registry: per-source optional
  capabilities, id-prefix routing (`${sourceId}::…`), local vault as fallback
  owner, cloud items merged into the vault ranker at query time.
- Microsoft SharePoint/OneDrive connector (real, working): Entra **device-code
  OAuth** (public client, no secret; refresh with 60 s skew; tokens in a
  connectors dir *outside* the vault), Graph enumeration as a **bounded BFS**
  (≤1,500 nodes, depth ≤6, ≤12 drives), enable-to-**mirror** semantics
  (bytes sha1-named under `sharepoint-mirror/`, extension preserved for the
  extractor, ≤50 MB/file, bounded concurrency 4, cancel on oversize), token
  sent only to `graph.microsoft.com` hosts, `disconnect()` wipes tokens+mirror.

### 3.9 UI (React feature components — `src/features/`, `src/shell/`)
- Explorer (complex): file tree indexed by parent, hierarchical include
  toggles, selection mode + bulk apply, upload/link/copy flows, SharePoint
  connect dialog (device-code UI), remove-to-trash confirm, OS drag-drop
  (link-first on desktop), custom drag MIME to chat.
- Chat (complex): NDJSON stream consumption, Markdown rendering
  (react-markdown + GFM), attachment pills (drag from explorer / OS drop →
  link-or-upload-then-attach), read-aloud switch + per-message speak, cited
  file open, transcript persisted to `sessionStorage` once per settled turn.
- Onboarding slides, model picker (provider/model/key + local-model
  install/uninstall with 1–5 s status polling), license gate + purchase/
  activate/feedback dialogs (largest feature file), bug-report FAB, one-time
  feedback nudge, launch-at-login prompt, settings gear.
- Fluent v9 theme (single source in `src/shell/theme.ts`, contrast-checked);
  app version badge; Zustand stores (`useRagStore` carries batched upload —
  25 files/64 MB per batch — and the device-code polling loop).
- Desktop-bridge touchpoints a new shell must re-provide: real path for an
  OS-dropped file (today `webUtils.getPathForFile` via preload), native link
  dialog, update-state events. Tauri equivalents exist (native drag-drop
  events carry paths; dialog + updater plugins).

### 3.10 Distribution & ops
- Windows NSIS installer (+ branded art), macOS DMG (hardened runtime,
  entitlements, notarize hook), Linux AppImage (configured; CI currently
  builds Windows x64 + macOS arm64 only); `extraResources` packing of
  llama/piper/voice assets; GitHub Releases publishing via CI; double-click
  no-terminal launchers; one-line `install.sh`.
- Build-time asset pipeline (`scripts/fetch-local-model.mjs`): pinned +
  **SHA-256-verified, fail-closed** downloads of llama.cpp `llama-server`
  (CPU build, per-OS/arch asset) and Piper + `en_US-lessac-medium` voice —
  this pattern carries over unchanged to the new build.
- CI (`release.yml`): gate job (typecheck + tests + lint) → build matrix →
  conditional code signing (only when `CSC_LINK` secret exists) → draft
  GitHub Release. Rust equivalent: `tauri-action` with the same gate.
- 9 `node:test` suites today (extraction, vault references ×E2E, model
  download/uninstall ×E2E vs a local mock HF, profile-recursion guard,
  experiment assignment ×E2E vs a mocked Edge Function, speech fallback, dnd)
  — the behavioral seed corpus for parity testing.

---

## 4. Language evaluation ("uniform, low-level, speed/efficiency")

| Criterion | **Rust** | C++ | Go | Zig |
|---|---|---|---|---|
| Raw speed / no GC | ✅ | ✅ | ~ (GC; fine here) | ✅ |
| Memory safety while parsing untrusted PDFs/DOCX/XLSX | ✅ compile-time | ❌ manual | ✅ | ~ |
| Desktop shell story | **Tauri 2 (stable, 2.9.x)**, plugins for tray/updater/dialog/autostart | Qt (LGPL/commercial), heavy | Wails (webview) OK, less mature perms/updater | none mature |
| Document parsing ecosystem | calamine (xlsx/xls), pdfium-render / pdf-extract, docx via zip+quick-xml or dotext | pdfium/MuPDF direct | libraries exist, cgo for pdfium | would hand-roll |
| Search/indexing | **tantivy** (Lucene-class) or bespoke | bespoke | bleve | bespoke |
| llama.cpp / Piper integration | spawn (as today) **or in-process** via maintained `llama-cpp-2` bindings; ort/piper-rs for TTS | native | cgo friction | C interop good |
| HTTP + SSE streaming client | reqwest + eventsource | libcurl | net/http | immature |
| Single static binary, cross-compile, installer tooling | ✅ (`tauri-action` CI: NSIS/MSI, DMG, AppImage/deb/rpm, signed updater) | painful | ✅ | partial |
| Hiring/velocity risk | moderate (borrow checker ramp) | high (safety burden) | low | high (ecosystem) |

**Recommendation: Rust.** It is the only candidate that is simultaneously
low-level (no GC, native binaries), memory-safe against hostile documents — a
real requirement for an app whose core feature is *parsing arbitrary user files*
— and equipped with a production desktop framework whose flagship benefit is
exactly this migration (Electron → Tauri: ~96 % smaller app, roughly half the
RAM, system webview instead of bundled Chromium).

Go is a reasonable general choice but is neither "low-level" in the sense asked
nor stronger than Rust on any axis that matters here. C++ forfeits memory
safety where this app can least afford it. Zig's ecosystem cannot cover PDF/
DOCX/XLSX/GUI/updater today without writing it all by hand.

### The uniformity question, stated honestly

"Uniform" has two defensible readings:

- **Option A (recommended): uniform logic language.** 100 % of application
  *logic* — engine, API, shell, process supervision — becomes Rust (~5,600 of
  today's ~11,500 lines: `src/server/` ≈3.9 k, API routes ≈0.9 k,
  `electron/` ≈0.8 k; parts of the stores' orchestration also migrate). The UI
  remains web-rendered inside Tauri's system webview (TypeScript/React
  initially, optionally slimmed later). Rationale:
  the explorer/chat UI is ~4,800 lines of interaction polish (drag-and-drop,
  streamed Markdown, virtualized trees) whose wholesale re-creation in a native
  GUI toolkit is the single largest regression risk in the project, while
  contributing nothing to speed — the UI was never the bottleneck.
- **Option B: uniform everything.** UI rebuilt in a Rust-native toolkit
  (Slint or egui/iced). Truly one language, smallest possible footprint
  (~5–10 MB, no webview dependency), but +6–10 engineer-weeks and material UX
  risk on Markdown rendering, rich text selection, OS drag-in, accessibility,
  and IME support. **Scope it as a follow-on**, not the first migration: the
  Rust core from Option A is 100 % reusable beneath a Slint UI later, because
  the core/UI seam mirrors today's `src/contracts/` seam.

---

## 5. Target architecture (Option A)

```
┌────────────────────────── Tauri 2 shell (Rust) ──────────────────────────┐
│ window/tray/menus • dialogs • single-instance • autostart • signed updater│
│ child-process supervision: llama-server, (piper — or in-process via ort)  │
├────────────────────────── lighthouse-core (Rust crate) ──────────────────┤
│ vault: parallel walk (jwalk/rayon), notify-based FS watcher               │
│ index: persistent incremental inverted index (tantivy or bespoke TF-IDF   │
│        with identical scoring), mmap reads, no 1 MB / 4 k-chunk caps      │
│ extract: calamine • pdfium-render (or pdf-extract) • docx via quick-xml,  │
│          parallel extraction pool, same mtime+size disk cache             │
│ chat: reqwest SSE → Anthropic / local OpenAI-compatible; extractive       │
│       fallback; identical prompt + NDJSON chunk semantics                 │
│ license/usage/experiment: same JSON POSTs to Supabase Edge Functions      │
│ connectors: registry trait + Microsoft Graph device-code implementation   │
│ state: serde_json, atomic+fsync writes, 0600 — byte-compatible with       │
│        today's state.json / profile.json (no user migration needed)       │
├───────────────────────────── UI (system webview) ─────────────────────────┤
│ existing React tree served as static assets; RagService/ChatService/      │
│ AuthService reimplemented over Tauri invoke + Channel streaming           │
│ (feature components untouched — the contracts seam absorbs the swap)      │
└───────────────────────────────────────────────────────────────────────────┘
```

Key structural changes and why they pay:

1. **No local HTTP server, no port.** UI↔core traffic moves to Tauri IPC
   (`invoke` + `Channel` for streams). Deletes the entire
   loopback-auth/DNS-rebinding/token surface (`src/server/http.ts`) and the
   `waitForServer` boot poll — the engine is in-process and ready at launch.
   (A `--serve` flag can retain the HTTP façade for the web/dev deployment if
   that target stays supported.)
2. **Persistent incremental index** replaces per-query re-everything: watch the
   vault + linked roots (notify), extract/index on change in a rayon pool,
   answer queries from the index in microseconds–milliseconds. The 3 s walk
   cache, 1 MB cap, and 4,000-chunk cap all become unnecessary; retrieval sees
   the *whole* corpus. The UI's 4 s tree poll becomes a push: the watcher emits
   an IPC event and the explorer updates live, with zero idle work.
3. **State files stay byte-compatible** (`state.json`, `profile.json`,
   extraction cache format may version-bump) so existing users upgrade in place.
4. **llama-server & Piper unchanged initially** (same bundled binaries, same
   supervision semantics, including the mmap-aware uninstall handshake) — then
   optional in-process llama.cpp (`llama-cpp-2`) and Piper-via-ort as follow-on
   optimizations that remove process spawn/HTTP hops.
5. **Auto-update improves**: tauri-plugin-updater requires signed update
   manifests by design, which is the end-state the current Electron design doc
   says it is waiting for.

### Expected wins (order-of-magnitude, to be validated by Phase 0 benchmarks)

| Metric | Today (Electron + Next + Node) | Target (Tauri + Rust) |
|---|---|---|
| Installer size (excl. llama/piper/voice assets) | ~80–150 MB | **~5–25 MB** |
| Idle RAM (all processes, excl. llama-server) | ~350–600 MB | **~60–150 MB** |
| Cold start to interactive | multi-second splash (server boot poll, up to 40 s worst case) | **< 1 s** |
| Retrieval on a 10k-file vault | linear re-scan per query, capped/truncated | **ms-class from persistent index, uncapped** |
| First-query-after-add (PDF-heavy) | serial JS parse on query path | parallel native parse off the query path (5–50× per-document) |
| Read-aloud start | +0.5–1 s Piper spawn per answer | warm engine, near-instant |
| Runtime dependency count | 945 npm packages + Node + Chromium | ~150–250 crates compiled into one binary + OS webview |
| Event-loop freezes on big linked trees | by design possible (mitigated by caps) | structurally eliminated (parallel walk off the UI/IPC threads) |
| LLM inference, TTS synthesis quality/speed, Anthropic/network latency | — | **unchanged** (already native / network-bound) |

---

## 6. Compatibility & parity requirements

- **Behavioral parity harness (hard requirement):** golden tests generated from
  the current implementation — fixture vault in CI, snapshot of `retrieve()`
  outputs (references, scores, listing-intent answers), extraction outputs for
  the PDF/DOCX/XLSX fixtures, chat NDJSON framing, state.json round-trips. Port
  the 9 existing `node:test` suites as the seed. Rust and TS engines run
  side-by-side against the same fixtures until diffs are zero or intentional.
- **Small contracts that are easy to miss:** chat errors are injected as an
  italic `delta` line, never a broken stream; `/api/tts` answers **501** when
  no voice is bundled and the UI falls back to Web Speech (this fallback stays,
  since a web/dev deployment has no Piper); upload preserves folder structure
  via per-file relative paths and suffixes name collisions `" (n)"`; model
  install/uninstall is observable via polled progress states
  (`downloading/ready/uninstalling/error/removable`).
- **Scoring fidelity:** if tantivy's BM25 replaces hand-rolled TF-IDF, ranking
  changes must be an explicit, reviewed decision. Default plan: port the exact
  TF-IDF + name-match + listing-intent logic first (it is ~500 lines and fully
  specified by the code), benchmark, and only then consider BM25 behind a flag.
- **Platform matrix:** Windows 10/11 (WebView2 evergreen bootstrap in the
  installer), macOS 11+ (WKWebView, notarization), Linux (webkit2gtk for
  AppImage). CI must build and smoke-test all three per PR (tauri-action).
- **Webview delta risk:** Fluent UI/Griffel must render correctly on WKWebView
  and WebView2 (today it only ever meets bundled Chromium). Budget a
  cross-webview UI QA pass; keep the CSP equivalent to `electron/main.js:73-85`.
- **Secrets & privacy invariants:** tokens/profile outside the vault dir; 0600
  atomic writes; counts-only telemetry; context-as-untrusted-data prompt
  hardening — all carry over unchanged.

## 7. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| UI regression from shell swap (drag-in, dialogs, deep-links) | High | Option A keeps the React tree; contracts-seam swap only; cross-webview QA matrix |
| Retrieval ranking drift | Medium | Port scoring verbatim + golden snapshots before any algorithm upgrade |
| DOCX extraction crate maturity < mammoth | Medium | DOCX is zip+XML: extract `w:t` runs via quick-xml (small, testable); keep fixtures |
| PDF edge cases (encrypted, scanned, exotic encodings) | Medium | pdfium-render (Chrome's PDF engine, BSD) as primary; fallback pdf-extract; keep "empty text, findable by name" degradation |
| Team Rust ramp-up | Medium | Phase 1 is a pure library with exhaustive tests — the safest place to learn; borrow-checker cost front-loaded |
| WebView2 absence on older Win10 | Low | NSIS bootstrap installs evergreen runtime (standard Tauri path) |
| Updater migration (electron-updater → tauri updater) | Low | Notify-only today anyway; tauri updater requires signing — aligns with existing design doc's end state |
| Licensing/Supabase flows | Low | Pure JSON POSTs; no server-side change at all |
| In-process llama.cpp destabilizing the app | Low | Deferred optimization; child-process model retained until core is stable |

## 8. Phased migration plan & effort

Strangler pattern along the existing contracts seam; the app ships at every phase.

> **Execution status:** Phases 1–2 are implemented in [`native/`](../native/README.md)
> — `lighthouse-core` (the full engine, state-compatible with `.rag-vault/`)
> and `lighthouse-server` (all 13 routes, wire-compatible, NDJSON chat), with
> 33 parity/wire tests and a `native.yml` CI job. Phases 3–5 (Tauri shell, IPC
> transport swap, persistent index) remain.

| Phase | Scope | Exit criteria | Effort (1–2 eng) |
|---|---|---|---|
| **0. Baseline & harness** | Benchmarks (startup, RSS, retrieval latency vs corpus size), golden-output capture, fixture vault, CI scaffold | Reproducible numbers + snapshot suite | 1–2 wks |
| **1. `lighthouse-core` crate** | Vault walk/state/refs/trash, extraction (pdf/docx/xlsx + cache), TF-IDF retrieval + listing intent, chat streaming (3 providers), license/usage/experiment clients, model download, connector registry + Microsoft Graph device-code connector | Side-by-side parity: zero unexplained diffs vs TS on the harness | 3–5 wks |
| **2. API façade** | axum server exposing the 13 routes 1:1 (same NDJSON/JSON/auth) | Existing Electron+React app runs unmodified against the Rust server | 2–3 wks |
| **3. Tauri shell** | Window/tray/splash/dialogs/single-instance/autostart, llama-server & Piper supervision incl. uninstall handshake, signed updater, installers via tauri-action | Feature-parity desktop build on Win/mac/Linux; Electron deleted | 2–4 wks |
| **4. UI transport swap** | `contracts/real/*` reimplemented over Tauri invoke/Channels; static-export React served by Tauri; HTTP façade behind `--serve` flag or removed | No local port in desktop build; UI code untouched above contracts | 2–4 wks (overlaps 3) |
| **5. Performance hardening** | FS watcher + persistent incremental index, parallel extraction pool, warm TTS, remove caps, perf CI gates | ≥10× retrieval at 10k files; RSS & startup targets met | 2–3 wks |
| *(Optional B)* | Slint/egui native UI replacing the webview | — | +6–10 wks |

**Total (Option A): ~11–19 engineer-weeks** (≈3–5 calendar months for one
engineer, ≈6–10 weeks for two). Skills needed: one engineer comfortable in Rust
(or budgeted ramp), familiarity with Tauri or equivalent desktop packaging, and
CI for signing/notarization (already partially in place for macOS).

## 9. What explicitly does NOT change

- Product behavior, inclusion semantics, privacy posture, prompts, citation
  contract, trial/subscription model.
- Supabase Edge Functions, Stripe wiring, registration backend.
- Bundled llama.cpp / Piper binaries and the opt-in 4.2 GB model download flow.
- User data on disk: vault layout, `state.json`, `profile.json`, trash format.

## 10. Appendix — runtime configuration surface to re-honor

Environment variables the desktop runtime reads today (all must keep working or
be consciously retired; the Supabase-function env is server-side and untouched):

`VAULT_DIR`, `LIGHTHOUSE_PORT`, `LIGHTHOUSE_API_TOKEN`, `LIGHTHOUSE_DESKTOP`,
`LIGHTHOUSE_RESOURCES_PATH`, `LIGHTHOUSE_SETTINGS_FILE`, `LIGHTHOUSE_MODELS_DIR`,
`LIGHTHOUSE_CONNECTORS_DIR`, `LIGHTHOUSE_LOCAL_LLM_URL`,
`LIGHTHOUSE_LOCAL_LLM_MODEL`, `LIGHTHOUSE_LOCAL_MODEL_URL`,
`LIGHTHOUSE_LOCAL_MODEL_FILE`, `ANTHROPIC_API_KEY`, `LICENSE_API_URL`,
`SUPABASE_ANON_KEY`, `CHECKOUT_API_URL`, `PAID_ENABLED`, `LICENSE_ENFORCE`,
`LICENSE_SECRET` (local-dev only), `SHAREPOINT_CLIENT_ID`,
`SHAREPOINT_AUTHORITY`, `SHAREPOINT_REDIRECT_URI`, app version stamp
(`npm_package_version` / `NEXT_PUBLIC_APP_VERSION` → Cargo/Tauri version).

Note: several exist only because UI, server, and shell are separate processes
(`LIGHTHOUSE_API_TOKEN`, `LIGHTHOUSE_PORT`, `LIGHTHOUSE_SETTINGS_FILE`,
`LIGHTHOUSE_DESKTOP`). In the single-process target they collapse into plain
configuration, shrinking the attack/complexity surface further.

## 11. Capability verdict

**Yes — the rewrite is achievable, and this codebase is unusually well prepared
for it.** The contracts seam (`src/contracts/`) was built for implementation
swaps; the engine is small (~6.7 k lines of portable logic) and fully
spec'd by its own tests and comments; the heavy native pieces are already
external binaries; and the licensing backend needs no change. The recommended
Rust + Tauri 2 target removes the three structural costs of the current stack —
bundled Chromium, a second Node process, and a single event loop doing file I/O
— rather than merely speeding them up. The main honest constraints: local-LLM
answer time is inference-bound and will not improve; the UI layer stays
TypeScript in the recommended option (full-native UI is a scoped follow-on);
and ranking-fidelity work is real engineering that must be protected by golden
tests, not assumed.
