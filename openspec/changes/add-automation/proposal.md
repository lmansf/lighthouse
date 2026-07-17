# add-automation

## Why

Beam answers questions inside the app, but the engine cannot yet be *scripted*
or *called by another tool*. Everything that reaches `synth::answer_pipeline`
today arrives through a UI transport — the desktop IPC command
(`commands.rs::chat_ask`) or the loopback route (`routes.rs::chat_post`) — and
the only thing resembling a headless ask, `LIGHTHOUSE_SMOKE`, drives a **webview**
that fetches `/api/chat` (`lighthouse-desktop/src/main.rs:548` `SMOKE_DRIVER_JS`);
it is an end-to-end UI probe, not a direct engine call. There is no
`lighthouse ask "…"`, no way for an agent to query the vault as a tool, and no
way to fork or export a line of inquiry from a script. The engine that ships is
not reachable except through a window.

This change (Phase C of the H-series, after Phase A `add-beam-loop` and Phase B
`add-semantic-layer`) makes the Beam engine **scriptable and callable**, honoring
the SAME privacy posture as the app:

- **A `lighthouse` CLI** — the FIRST true headless Rust ask. `lighthouse ask
  "question"` calls the engine in-process (no webview, no loopback HTTP), streams
  the answer, and prints a **provenance line** (where it was answered + what it
  egressed). Flags cover local-only, a vault path, and JSON output.
- **An MCP server** — `lighthouse-mcp` exposes the engine as an MCP stdio server
  so an agent can query the vault as a tool, running **in-process against
  `lighthouse-core`** (inheriting the ask chokepoint), never shelling the loopback
  server.
- **Investigation branching + export** — `fork` a line of inquiry into a fresh
  investigation; `export` an investigation to a shareable in-vault markdown
  artifact that REFERENCES conversations, never embeds transcripts.

The load-bearing risk shapes the whole change. The app's audit + egress
attribution is not enforced inside `answer_pipeline`; it is wired by each
TRANSPORT, inline — `chat_post` (`routes.rs:1105-1161`) and `chat_ask`
(`commands.rs:1016-1051`) each, by hand, resolve `investigations::resolve_ask_context`
+ `profile::model_config()`, wrap `audit::AnswerAudit::start`…`.finish`, and only
then call `answer_pipeline`. **Any new ask entry that calls `answer_pipeline`
without that wrapper silently creates an unaudited, unattributed egress path** —
exactly the kind of hole a CLI and an MCP server would open. So §1 extracts that
sequence into ONE shared helper that the CLI and MCP MUST use, before either
binary exists.

## What Changes

- **The shared ask chokepoint (do first).** A new `lighthouse-core` module
  `ask` exposes `run_headless_ask(question, included_ids, history, opts) ->
  impl Stream<Item = ChatChunk>` that wires the exact invariant the two UI
  transports assemble inline: `resolve_ask_context` (scope + local-only swap +
  recall prefs) over `profile::model_config()` (or the local config under
  `--local`), `AnswerAudit::start` before the stream and `.finish(provider,
  file_ids, artifacts, cost)` after the final chunk, with `answer_pipeline` in
  between. The CLI and the MCP `ask_vault` tool are thin drivers over this helper,
  so a headless ask is audited and egress-attributed identically to an app ask —
  by construction, not by remembering. **Decision:** v1 does NOT retrofit
  `chat_post`/`chat_ask` onto the helper (they already wire the identical sequence,
  and retrofitting the `async_stream!` bodies risks a subtle streaming/`finish`-
  timing divergence). The helper is documented as the CANONICAL path for every NEW
  ask entry; retrofitting the two transports is a designed follow-on gated on a
  byte-identical streaming parity test (design.md). This keeps the change purely
  additive to existing wire behavior.
- **The `lighthouse-cli` crate.** A new non-Tauri workspace member producing the
  `lighthouse` binary. `ask "<q>"` drives `run_headless_ask`, streams the answer to
  stdout, and ALWAYS emits a provenance line (`origin` from `ChunkMeta` — `device`
  or the provider id — plus the token/cost meter and the egress verdict). Flags:
  `--local` forces the local provider (zero-network) via the same local config
  `resolve_ask_context` swaps to; `--vault <path>` points the engine at a vault
  directory; `--json` emits a machine-readable `{answer, provenance, references,
  analytics?}` object; `--investigation <id>` / `--include <file-id>` pass through
  to the helper. A local-only-marked scope forces local automatically (the engine
  decides, at `resolve_ask_context`). `fork`/`export` are thin subcommands over the
  §4 engine functions.
- **The `lighthouse-mcp` crate.** A second non-Tauri workspace member producing an
  MCP **stdio** server, in-process against `lighthouse-core`. Its tools are a
  SMALL, read-only-leaning starter set: `ask_vault` (over `run_headless_ask`, so it
  inherits the chokepoint), `list_files` (`vault::list_nodes`), `list_investigations`
  (`investigations::listing`), and `run_analytics_sql` (`analytics::run_direct` — a
  guarded read-only SELECT). Stdio only in v1; IF it ever binds a port it adopts
  `auth.rs`'s loopback-host + `LIGHTHOUSE_API_TOKEN` model (design.md), never a
  bare LAN listener.
- **Investigation `fork` (structure-only).** `investigations::fork(id, new_name)`
  mints a FRESH investigation copying only the parent's `scope_file_ids`,
  `provider_policy`, and `conversation_refs` — structure. Derived membership (pins
  carry a single `investigationId`; notes live in one folder, `investigations.rs:4-10`)
  is deliberately NOT duplicated: the branch is a new line seeded with the parent's
  scope + conversation context, minting its own id and its own notes folder, under
  the same case-insensitive-unique-name rule as `create`.
- **Investigation `export` (references, not transcripts).** `export_markdown(id)`
  renders an investigation's STRUCTURE + derived membership — scope files,
  conversation refs (by id; an optional caller title map for legibility), the
  derived pin list and note list — to a standalone markdown document, reusing the
  `briefings.rs:243` `render_markdown` idiom. The export is WRITTEN in-vault through
  the `exportChat` precedent: `investigations::notes_subdir(id)` (the write-artifact
  allowlist, non-egress) + `vault::write_artifact`. It may REFERENCE conversations
  but MUST NOT embed transcripts — the engine never stores them (`investigations.rs:9-10`).
- **Twin discipline.** The CLI and MCP are Rust-only ENTRY PLUMBING (like the
  desktop shell and the headless server): a `docs/ts-twin.md` Rust-only row + a
  `PARITY:` note, NO `src/server` mirror. BUT `fork` and `export_markdown` are
  shared engine behavior over a twinned store, so they DO get byte-compatible
  `src/server/investigations.ts` mirrors (the store, id minting, and view
  derivation are already twinned there).

## Capabilities

### New Capabilities

- `shared-ask`: the shared headless ask chokepoint — one helper
  (`ask::run_headless_ask`) that wires `resolve_ask_context` + `model_config` +
  `AnswerAudit::start/finish` + `answer_pipeline`, so every NON-UI ask entry is
  audited and egress-attributed by construction. The load-bearing invariant: a new
  ask entry that skips the wrapper skips the audit + egress ledger.
- `headless-cli`: the `lighthouse` binary — the first true headless Rust ask.
  `ask` streams an answer and a provenance line; `--local` forces zero-network and
  a local-only scope forces it automatically; `--vault`/`--json`/`--investigation`/
  `--include` flags; `fork`/`export` subcommands. A non-Tauri crate that builds in
  the dev container and is picked up by `cargo build/test --workspace`.
- `mcp-server`: the `lighthouse-mcp` stdio server, in-process against
  `lighthouse-core`. A small read-only-leaning tool set (`ask_vault`, `list_files`,
  `list_investigations`, `run_analytics_sql`) that inherits the ask chokepoint and
  honors the same posture; stdio-only in v1, no write surface.
- `investigation-branch-export`: `fork` (a structure-only branch copying scope +
  policy + conversation refs, derived membership NOT duplicated) and `export` (an
  in-vault markdown artifact rendering structure + derived membership, referencing
  conversations without embedding transcripts, written through the `notes_subdir`
  allowlist). Both twinned in `investigations.ts`.

## Non-goals

- **No full MCP write surface in v1.** The starter tools are read-only-leaning:
  `ask_vault` (which egresses exactly as the app would, under the chokepoint),
  `list_files`, `list_investigations`, and a guarded read-only `run_analytics_sql`.
  Creating/renaming/archiving investigations, `exportChat` writes, `defineMetric`,
  `addConversationRef`, upload, and move are OUT — a designed follow-on, not v1.
- **No external-file export.** `export` writes only into the vault, through the
  `notes_subdir(id)` write-artifact allowlist (the `exportChat` precedent). It never
  writes an arbitrary path, never emails, never uploads — the artifact is a vault
  note like any other.
- **No transcript embedding.** Export REFERENCES conversations by id (with an
  optional caller-supplied title map); it never embeds transcript text, because the
  engine deliberately never stores transcripts (`investigations.rs:9-10`). Fork
  copies refs (ids), never content.
- **The CLI/MCP are entry plumbing, not new engine capability.** They add no new
  answer behavior — they call the SAME `answer_pipeline`/`run_direct` the app calls.
  No `src/server` mirror of the binaries (Rust-only plumbing, the desktop-shell
  precedent); only `fork`/`export` (shared store behavior) mirror in `investigations.ts`.
- **No version bump.** This is an H-suite phase; it stays on the current line and
  does not move the five version stamps.
- **No `CACHE_VERSION` bump.** The CLI and MCP call the existing `answer_pipeline`
  with no change to the `CachedAnswer` wire shape; `fork`/`export` touch the
  investigations store (its own `{v:1}` envelope, unchanged — fork reuses existing
  `Investigation` fields) and render markdown, neither of which is the shared
  extract cache. `CACHE_VERSION` stays at 12 and the `{v:1}` investigations envelope
  stays at 1.

## Impact

- **Engine (Rust, ships):** NEW `native/crates/lighthouse-core/src/ask.rs` —
  `run_headless_ask(question, included_ids, history, opts) -> impl Stream<Item =
  ChatChunk>` + a small `AskOpts { local, vault?, investigation_id?,
  attachment_ids }`; registered `pub mod ask;` in `lib.rs`. `investigations.rs` —
  `fork(id, new_name) -> Result<Investigation, String>` (structure-only copy under
  `store_lock`, id + folder minted fresh, uniqueness enforced) and
  `export_markdown(id, titles?) -> Result<String, String>` (render over
  `InvestigationView` reusing the `briefings::render_markdown` idiom). No new
  persisted field on `Investigation`; the `{v:1}` envelope is unchanged.
  `settings.rs`/`settings_test.rs` are UNTOUCHED — no new `DesktopSettings` field
  (the helper reads the existing profile/config; the CLI's flags are per-invocation,
  not persisted state).
- **New non-Tauri crates:** `native/crates/lighthouse-cli` (`lighthouse` bin) and
  `native/crates/lighthouse-mcp` (`lighthouse-mcp` bin), added to
  `native/Cargo.toml` `members`. Both depend ONLY on `lighthouse-core` (+ a small
  arg/JSON-RPC dep), NOT on Tauri/webkit/gtk — so, unlike `lighthouse-desktop`, they
  compile on plain ubuntu and in the dev container, and `cargo build/test
  --workspace` picks them up automatically.
- **Op surface (for the app):** the `investigations` op (`routes.rs:129`,
  `commands.rs`, `app/api/rag/route.ts`) gains `action:"fork"` and `action:"export"`
  arms; `export` composes `export_markdown` + `notes_subdir` + `write_artifact`
  (the `exportChat` precedent) and returns the saved artifact id/name. A "Branch"/
  "Export" affordance in the investigations nav lands AFTER the engine function
  (engine-before-UI).
- **PARITY (`src/server/investigations.ts`):** `fork` and `export_markdown` mirror
  byte-compatibly (id minting, uniqueness, the markdown render literal); the CLI and
  MCP binaries have NO twin (Rust-only plumbing) — recorded as a `docs/ts-twin.md`
  Rust-only row with a `PARITY:` note.
- **CI:** `native.yml`'s `cargo build/test --workspace` builds and tests the two new
  crates with no workflow edit (workspace pickup). A new Rust-NATIVE headless smoke
  (`lighthouse ask` answering one zero-network grounded ask, exit code = verdict)
  slots beside the existing webview boot smoke in `release-smoke.yml` — the first
  smoke that exercises the engine WITHOUT a webview.
- **Docs:** `docs/ts-twin.md` gains a Rust-only row for the CLI/MCP binaries;
  `docs/data-flows.md` §8 (audit) gains a note that the headless ask honors the SAME
  egress ledger + audit record as an app ask (via the shared chokepoint). No NEW
  egress: `ask_vault`/`ask` egress exactly what the configured provider already
  receives; `list_files`/`list_investigations`/`run_analytics_sql` are on-device;
  `--local` and a local-only scope force the zero-network path; `export` is a
  non-egress in-vault write.
