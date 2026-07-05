# Lighthouse native engine (Rust)

The in-progress native rewrite scoped in [`docs/rewrite-scope.md`](../docs/rewrite-scope.md):
a Rust port of the TypeScript backend, wire- and state-compatible with the
existing app so the two engines can run side-by-side during the migration.

## What's here

| Crate | Ports | Status |
|---|---|---|
| `lighthouse-core` | `src/server/` — vault engine (walk/state/references/trash/inclusion), TF-IDF retrieval + catalog listing intent, document extraction (PDF via `pdf-extract`, DOCX via zip+`quick-xml`, XLSX/XLS via `calamine`) with the same mtime+size disk cache, chat streaming (Anthropic SSE / local OpenAI-compatible / extractive fallback with the identical grounding prompt), profile/onboarding, licensing client (hosted + local-dev AES-256-GCM + disabled), usage ring buffer, A/B experiment assignment, model download/uninstall lifecycle, Piper TTS spawn, source registry + Microsoft Graph device-code connector | **Phase 1 complete** — 31 parity tests |
| `lighthouse-server` | `app/api/*` — all 13 routes over axum, byte-compatible JSON shapes, the NDJSON `ChatChunk` chat stream, multipart upload with the same caps/collision suffixes, and the layered loopback/Origin/token auth of `src/server/http.ts` | **Phase 2 complete** — end-to-end wire tests |

State files (`state.json`, `profile.json`, `license.json`, `experiments.json`,
the extraction cache, connector tokens) are read and written in the same
formats as the TS engine — an existing vault works unchanged, in both
directions.

## Measured (release build, Linux x64, this repo's demo vault)

| Metric | `lighthouse-server` (Rust) | Today (Electron + `next start` child) |
|---|---|---|
| Server binary / runtime | **7.9 MB** (6.7 MB stripped) | Node runtime + 945-package `node_modules` + `.next` build |
| Cold start → first API response | **15 ms** | multi-second (`waitForServer` polls 500 ms × up to 80) |
| Idle RSS (server process) | **6.4 MB** | a full Node + Next server process |
| Full-vault `GET /api/rag` | ~4 ms | same engine work + JS/event-loop overhead |

(The Chromium/renderer side is unchanged until Phase 3 swaps Electron for a
system webview; these numbers replace only the `next start` process.)

## Run

```bash
cd native
cargo test --workspace          # parity + wire-protocol suites
cargo run -p lighthouse-server  # http://127.0.0.1:3777 (PORT / LIGHTHOUSE_PORT to override)
```

The server honors the same environment as the Next.js one (`VAULT_DIR`,
`ANTHROPIC_API_KEY`, `LIGHTHOUSE_*`, `LICENSE_*`, `SHAREPOINT_*`, …) — see
`docs/rewrite-scope.md` §10. Point the Electron shell's `startServer()` at this
binary instead of `next start` to drive the existing UI with the native engine.

## Deliberate parity notes

- The per-query retrieval algorithm is ported **verbatim first** (same 120/25
  chunking, TF-IDF math, name-match nudges, caps, and 3 s walk cache) so
  behavior can be diffed before the persistent-index upgrade (Phase 5) changes
  the performance envelope. One structural fix is already in: ranking runs on a
  blocking worker thread, so a large corpus can't freeze other requests the way
  it blocks Node's event loop today.
- PDF text comes from a different parser than the TS engine (`pdf-extract` vs
  pdf.js), so extracted text can differ in whitespace/ordering for complex
  layouts. Both engines treat extraction output as searchable text, not a
  rendered document; the cache schema/versioning contract is identical.
- The SharePoint connector and hosted-licensing client are faithful ports but
  need live services to exercise; they are covered by not-connected/disabled
  wire tests only.

## Not yet started (per the scope doc's phases)

- **Phase 3** — Tauri shell (window/tray/dialogs/updater, llama-server + Piper
  supervision incl. the uninstall marker handshake).
- **Phase 4** — UI transport swap (contracts over Tauri IPC instead of HTTP).
- **Phase 5** — persistent incremental index + FS watcher, parallel extraction
  pool, warm TTS process, benchmark CI gates.
