# Lighthouse native engine (Rust)

The in-progress native rewrite scoped in [`docs/rewrite-scope.md`](../docs/rewrite-scope.md):
a Rust port of the TypeScript backend, wire- and state-compatible with the
existing app so the two engines can run side-by-side during the migration.

## What's here

| Crate | Ports | Status |
|---|---|---|
| `lighthouse-core` | `src/server/` — vault engine (walk/state/references/trash/inclusion), TF-IDF retrieval + catalog listing intent, document extraction (PDF via `pdf-extract`, DOCX via zip+`quick-xml`, XLSX/XLS via `calamine`) with the same mtime+size disk cache, chat streaming (Anthropic SSE / local OpenAI-compatible / extractive fallback with the identical grounding prompt), profile/onboarding, licensing client (hosted + local-dev AES-256-GCM + disabled), usage ring buffer, A/B experiment assignment, model download/uninstall lifecycle, Piper TTS spawn, source registry + Microsoft Graph device-code connector. **Phase 5:** persistent incremental index (`index.rs` — per-file chunk/TF cache keyed mtime+size, disk-persisted, parallel rebuilds via rayon, stat-validated per query so correctness never depends on events) + `notify` FS watcher (`watch.rs` — event-driven walk-cache/index invalidation + a generation counter pushed to the UI); the legacy 1 MB-per-file and 4,000-chunk caps are replaced by generous env-tunable bounds | **Phases 1 + 5 complete** — 34 tests incl. a perf gate |
| `lighthouse-server` | `app/api/*` — all 13 routes over axum, byte-compatible JSON shapes, the NDJSON `ChatChunk` chat stream, multipart upload with the same caps/collision suffixes, and the layered loopback/Origin/token auth of `src/server/http.ts` | **Phase 2 complete** — end-to-end wire tests |
| `lighthouse-desktop` | `electron/main.js` — Tauri 2 shell: window + close-to-tray, tray/app menus, native Add/Link/Choose-vault dialogs, single instance, launch-at-login (autostart plugin), llama-server supervision incl. the mmap-aware uninstall marker handshake, notify-only GitHub-releases update check, bundled llm/tts resources. **Phase 4:** the full IPC command surface mirroring the 13 routes (chat streams over a `Channel`); with the static-export UI bundled (`npm run build:ui-static`) the app runs with **no TCP port at all** — `src/shell/tauriTransport.ts` intercepts every `fetch("/api/…")` in the unmodified React tree and carries it over invoke | **Phases 3 + 4 complete** — headless E2E-verified (see below) |

State files (`state.json`, `profile.json`, `license.json`, `experiments.json`,
the extraction cache, connector tokens) are read and written in the same
formats as the TS engine — an existing vault works unchanged, in both
directions.

## Measured (Linux x64, this container)

| Metric | Native | Today (Electron + `next start` child) |
|---|---|---|
| API server binary | **7.9 MB** release (6.7 MB stripped) | Node runtime + 945-package `node_modules` + `.next` build |
| Cold start → first API response | **15 ms** | multi-second (`waitForServer` polls 500 ms × up to 80) |
| Idle RSS (server process) | **6.4 MB** | a full Node + Next server process |
| Retrieval, 10,000-file corpus (release) | **cold index+query 276 ms; warm query 128 ms** — full corpus scored | re-reads/re-chunks per query, silently truncated at 4,000 chunks |
| Static-export UI bundle | **2.1 MB** embedded in the shell binary | served by the Next process |
| Complete desktop app binary (shell + engine + UI) | **22.2 MB** release (19.5 MB stripped) + OS webview | Electron runtime (bundled Chromium + Node) + `node_modules` + `.next` |
| Desktop data transport | **Tauri IPC — no TCP port, no loopback-auth surface** | localhost HTTP + Origin/token defenses |

Webview memory is the OS's (WebKitGTK/WebView2/WKWebView — order of a
browser tab) and replaces bundled Chromium; the engine side is the 6.4 MB
process above instead of a Node server.

## Headless E2E evidence (Phases 3–4)

Run under `xvfb` with `LIGHTHOUSE_DIAG=1`, the shell logs its own webview
diagnostics. Observed in this container with the exported UI embedded:

```
[diag] {"ready":"complete","title":"Lighthouse","scripts":31,"bodyLen":323864,
        "tauri":true,"fetchHead":"(r,n)=>{…interceptor…}","errors":[]}
[diag] fetch-ok nodes=0 desktop=true
```

— the React tree hydrates in the system webview with zero JS errors, the
fetch interceptor is live, and a real `/api/rag` round-trips through IPC into
the Rust engine, which persists its state files (`experiments.json`,
`contact.json`, `usage-snapshot.json`) under the auto-created vault. No
`embedded API` line appears: no port existed.

## Run

```bash
cd native
cargo test --workspace           # engine parity + wire-protocol + perf suites
cargo run -p lighthouse-server   # HTTP façade on 127.0.0.1:3777 (web/dev parity)

# Desktop app (Linux build needs webkit2gtk/gtk dev packages):
npm run build:ui-static          # export the React UI into the shell (IPC mode)
cargo run -p lighthouse-desktop  # or: cargo build --release -p lighthouse-desktop
```

Without the UI export, the shell embeds the placeholder splash and boots its
embedded loopback server instead (the Electron-era architecture) —
`LIGHTHOUSE_SERVE=1` forces that server on even in IPC mode. Installer bundles
build via `.github/workflows/desktop-release.yml` (manual dispatch).

Both binaries honor the same environment as the Next.js server (`VAULT_DIR`,
`ANTHROPIC_API_KEY`, `LIGHTHOUSE_*`, `LICENSE_*`, `SHAREPOINT_*`, …) — see
`docs/rewrite-scope.md` §10 — and read/write the same on-disk state.

## Deliberate parity notes

- The retrieval **scoring math** is the TS engine's, verbatim (120/25
  chunking, TF-IDF cosine, name-match nudges, listing intent). Phase 5 changed
  the *envelope* on purpose: content is served from the persistent index, the
  1 MB/4,000-chunk caps became `LIGHTHOUSE_INDEX_MAX_FILE_BYTES` (8 MB) and
  `LIGHTHOUSE_MAX_QUERY_CHUNKS` (200k), and ranking runs on worker threads —
  more content is scored than the TS engine ever saw, by design.
- PDF text comes from a different parser than the TS engine (`pdf-extract` vs
  pdf.js), so extracted text can differ in whitespace/ordering for complex
  layouts. Both engines treat extraction output as searchable text, not a
  rendered document; the cache schema/versioning contract is identical.
- The SharePoint connector and hosted-licensing client are faithful ports but
  need live services to exercise; they are covered by not-connected/disabled
  wire tests only. The Tauri shell's dialogs/tray/menus compile and the app
  boots headlessly, but interactive flows (pickers, tray clicks, OS drag-drop
  path correlation) need a real desktop session to exercise.
- The updater is **notify-only** (GitHub releases poll → tray notice), the
  same Phase A posture as the Electron design doc; flip to
  `tauri-plugin-updater` (signed manifests) once signing keys exist.
- Read-aloud still spawns Piper per request (~0.5–1 s model load). A warm
  persistent process needs Piper's streaming protocol validated against the
  real binary, which isn't fetchable in this environment — left as the one
  Phase 5 line item deferred, with this note as the tracking marker.
