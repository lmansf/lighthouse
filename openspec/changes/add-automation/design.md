# add-automation — design

## The headline invariant: the audit chokepoint lives in the TRANSPORT, not the pipeline

`synth::answer_pipeline` (`synth.rs:711`) is where an answer is computed, keyed,
cached, and streamed — but it does NOT audit itself and does NOT resolve scope or
provider. Those are wired by each TRANSPORT, by hand, immediately before the call:

```
// routes.rs::chat_post :1105-1161  (and commands.rs::chat_ask :1016-1051, identical shape)
let (attachment_ids, cfg, preferred_conversation_ids) =
    investigations::resolve_ask_context(investigation_id, attachment_ids, profile::model_config());
let audit = audit::AnswerAudit::start(&question);
let provider = cfg.provider_id.clone().unwrap_or_else(|| "none".into());
// … stream answer_pipeline(question, included, attachment_ids, history, cfg, cache, plan, prefs) …
//    collecting final_files, artifacts, answer_cost from the final chunk …
audit.finish(&provider, final_files, artifacts, answer_cost);
```

`AnswerAudit::start` captures the egress baseline (`egress::host_counts`), and
`.finish` records the per-question egress DELTA (`egress::hosts_since`) plus the
provider and file ids. **This wrapper is the ONLY thing that puts an ask into the
audit + egress ledger.** A new entry point that calls `answer_pipeline` and forgets
the wrapper answers correctly but leaves NO audit record and NO egress attribution —
a silent hole. A CLI and an MCP server are exactly the kind of new entry point that
would forget. So the first thing this change builds — before either binary exists —
is a helper that makes the wrapper impossible to skip.

## §1 — The shared ask helper (foundation; the CLI and MCP consume it)

A new `lighthouse-core/src/ask.rs`:

```
pub struct AskOpts {
    pub local: bool,                         // --local: force the local provider
    pub vault: Option<PathBuf>,              // --vault: point the engine at a vault dir
    pub investigation_id: Option<String>,    // run inside an investigation
    pub attachment_ids: Vec<String>,         // --include: explicit attachments
}

pub fn run_headless_ask(
    question: String,
    included_ids: Vec<String>,
    history: Vec<ChatTurn>,
    opts: AskOpts,
) -> impl Stream<Item = ChatChunk>;          // + a thin `finish` on stream end
```

Internally it reproduces the transport wrapper EXACTLY:

1. Base config: `profile::model_config()`, or `profile::local_model_config()` when
   `opts.local` — the same swap `resolve_ask_context` performs for a `local-only`
   investigation, so `--local` and a local-only investigation reach the identical
   zero-network config.
2. `investigations::resolve_ask_context(opts.investigation_id, opts.attachment_ids,
   cfg)` → `(attachments, cfg, preferred_conversation_ids)`. A `local-only`
   investigation swaps `cfg` to local HERE regardless of `--local`; local-only-marked
   scope files stay readable (the private model may read them). Most-restrictive
   wins: `--local` OR a local-only investigation ⇒ device.
3. `AnswerAudit::start(&question)` before the stream; `.finish(&provider,
   final_files, artifacts, answer_cost)` when the final `done` chunk lands, with
   `answer_cost = audit::ask_new_cost(&meta)` (None on a cache replay, so the running
   total never double-counts — the `chat_post` rule verbatim).
4. `answer_pipeline(question, included_ids, attachments, history, cfg,
   CacheCtl::default-ish, PlanCtl::none, preferred_conversation_ids)` in between.
   Cache controls default to the privacy-safe values (memory-only, no disk mirror,
   `plan_only:false`) — a headless ask takes the ordinary answer path.

The helper yields `ChatChunk`s unchanged, so a caller sees the SAME stream the app
sees, including the final chunk's `ChunkMeta` (`origin`, `cost`, `manifest`) and any
`AnalyticsMeta` (`certified`/`trust`). The provenance the CLI prints is READ from
that stamp — not recomputed, not model text.

**`--vault` / opts.vault** points the engine at a vault directory. The engine
already resolves its vault/state roots from configuration + a `VAULT_DIR`-style
override (the mechanism the test harness uses under its shared env lock); the CLI
sets that override from `--vault` before the first engine read, exactly as the boot
smoke sets `LIGHTHOUSE_SMOKE_STATE` before the app reads state. This is a wiring
detail of the binary, not a new engine concept.

**Decision — do NOT retrofit `chat_post`/`chat_ask` in v1.** They already assemble
the identical sequence inline, so folding them onto `run_headless_ask` is tempting
DRY. But both are `async_stream!` bodies with subtle, load-bearing details — the
`audit.finish` fires AFTER the whole stream drains, `answer_cost` is read from the
final chunk mid-drain, and the NDJSON framing wraps each chunk — and a byte-identical
streaming equivalence is not something to assert without a dedicated parity test. The
default guidance (keep risk low) applies: v1 leaves the two transports exactly as they
are and documents `run_headless_ask` as the CANONICAL path for NEW ask entries (the
CLI, the MCP `ask_vault` tool). A retrofit that routes all four entries through the
one helper is a clean follow-on the moment a `run_headless_ask`-vs-`chat_post`
byte-identical-stream test exists. Encoding the invariant as a shared helper NOW is
what matters; collapsing the existing callers onto it can wait.

## §2 — The `lighthouse-cli` crate (the first true headless ask)

A new non-Tauri workspace member, `native/crates/lighthouse-cli`, producing the
`lighthouse` binary. It depends on `lighthouse-core` (+ a tiny arg parser and
`serde_json`), NOT on Tauri/webkit — so it builds where `lighthouse-desktop` cannot
(plain ubuntu, the dev container) and `cargo build/test --workspace` picks it up with
no `native.yml` edit.

```
lighthouse ask "<question>" [--local] [--vault <path>] [--json]
                            [--investigation <id>] [--include <file-id> …]
lighthouse fork   <investigation-id> --name "<new name>"   [--vault <path>]
lighthouse export <investigation-id> [--json]              [--vault <path>]
```

- **`ask`** drives `run_headless_ask`, streaming answer deltas to stdout. On the
  final chunk it ALWAYS emits a provenance line built from `ChunkMeta`:
  - `origin` — `device` (local / extractive) or the cloud provider id.
  - the cost meter — provider-reported tokens + the LABELED dollar estimate, or
    "not reported" when a provider is silent (never a `chars/4` guess), `$0.00` for
    device.
  - the egress verdict — `device` egresses nothing; a cloud answer names the
    provider host. (The CLI can surface the exact host delta via the same
    `egress::hosts_since` primitive `AnswerAudit` uses; at minimum it states
    device-vs-provider, which the `origin` already carries honestly.)
  Default: answer on stdout, one human provenance line after it. `--json`: a single
  `{answer, provenance:{origin, inputTokens, outputTokens, totalTokens, reported,
  costEstimateUsd, sourceFileCount}, references, analytics?}` object — the provenance
  is a FIELD, so it is present in JSON mode too (the "ALWAYS emits provenance" rule
  holds in both modes). Exit code 0 on a completed answer, non-zero on engine
  failure / no answer (scriptable).
- **`--local`** forces `profile::local_model_config()` — zero-network. A local-only
  investigation forces the same automatically inside `resolve_ask_context`, so
  `lighthouse ask … --investigation <local-only-id>` is device even without `--local`.
- **`fork`/`export`** are thin subcommands over the §4 engine functions (`export`
  composes the render with `notes_subdir` + `write_artifact`, the non-egress in-vault
  write). `export --json` returns the saved artifact `{savedId, savedName}`.

The audit record is written for every `ask` (the helper's `AnswerAudit`), so a
scripted ask is as legible as an app ask — the audit ledger and egress panel see it.

## §3 — The `lighthouse-mcp` crate (in-process, stdio, read-only-leaning)

A second non-Tauri member, `native/crates/lighthouse-mcp`, producing an MCP server
over **stdio** (JSON-RPC on stdin/stdout), in-process against `lighthouse-core`.
**In-process, NOT shelling the loopback server** — so the MCP tools inherit the ask
chokepoint directly (no second transport to re-audit, no port to secure) and there is
one code path to reason about.

Tools (a SMALL, safe, read-only-leaning starter set — thin wrappers over the shared
helper + the read subset of the `routes.rs` op surface):

| Tool | Wraps | Posture |
|---|---|---|
| `ask_vault(question, local?, investigation?, included_file_ids?)` | `ask::run_headless_ask` | egresses exactly as the app would; audited; `--local`/local-only force device |
| `list_files()` | `vault::list_nodes` | on-device read |
| `list_investigations()` | `investigations::listing` | on-device read (derived membership included) |
| `run_analytics_sql(sql, file_ids)` | `analytics::run_direct` | guarded read-only SELECT (`guard_sql`); on-device DataFusion |

`ask_vault` returns the collected answer text + the provenance object + references
(and `analytics` when the answer is analytical). Because it is `run_headless_ask`, it
is audited and egress-attributed like every other ask — the reason MCP is in-process.

**Transport posture.** Stdio only in v1: no port, so no network-auth surface. IF a
future version binds a loopback port, it adopts `auth.rs`'s model verbatim —
`is_same_origin`'s loopback-host allowlist (defeats DNS rebinding) + same-port origin
+ the `LIGHTHOUSE_API_TOKEN` shared secret via `x-lighthouse-token` — never a bare
LAN listener. Recorded as a design constraint so a later port can't skip it.

**Write surface is a non-goal (v1).** `run_analytics_sql` is read-only by the guard;
the other three are reads. No `create`/`rename`/`setArchived`/`fork`/`export`/
`defineMetric`/`exportChat`/upload/move tool — an agent cannot mutate the vault or the
stores through MCP in v1. `ask_vault`'s egress is the one posture-bearing action, and
it rides the same ledger as the app.

## §4 — Investigation `fork` + `export`

Both build on `investigations.rs`'s existing model, whose central fact (`:4-10`) is
that a record persists STRUCTURE only and membership (pins, notes) is DERIVED at read
time — never duplicated on the record.

### `fork(id, new_name) -> Result<Investigation, String>` — structure-only branch

Under `store_lock`, load the parent, then mint a FRESH investigation via the same
path `create` uses (new `created_ms`, new `investigation_id(name, created_ms)`, new
`sanitize_folder_name(new_name)`), copying ONLY:

- `scope_file_ids` (the parent's scope, verbatim — dangling ids stay harmless),
- `provider_policy` (a fork of a `local-only` line stays `local-only`),
- `conversation_refs` (the parent's conversation context seeds the branch).

`new_name` is trimmed, non-empty, and unique case-insensitively (archived records
count) — the `create` rule. The fork is NOT archived. What is DELIBERATELY NOT copied:
derived membership. Pins carry a single `investigationId` (they belong to exactly one
investigation) and notes live in one folder (membership = location); duplicating them
would mean either two-way bookkeeping to drift or moving another investigation's pins.
The branch is a NEW line seeded with the parent's scope + conversation context, with
its own id and its own (empty) notes folder — which is precisely what "branch a line
of inquiry" means against a derived-membership model. Twinned in
`investigations.ts::fork` byte-compatibly (same id minting, same uniqueness).

### `export_markdown(id, titles?) -> Result<String, String>` — references, not transcripts

Render the investigation's `InvestigationView` (record + derived `pin_refs` +
`note_refs`) plus its `conversation_refs` to a standalone markdown document, reusing
the `briefings::render_markdown` idiom (`briefings.rs:243` — `# title`, then `## `
sections). The document states the STRUCTURE + derived membership:

- name, created time, archive state, provider policy;
- scope files (the `scope_file_ids`, or "whole vault" when empty);
- conversation refs — by id, or `title (id)` when the optional `titles` map supplies
  one (the CLI has no title map and renders ids; the app op MAY pass titles it holds);
- the derived pin list (`pin_refs`) and note list (`note_refs`).

It REFERENCES conversations; it NEVER embeds transcript text, because the engine never
stores transcripts (`investigations.rs:9-10`) — there is nothing to embed, and the
export must not invent it. `export_markdown` is a PURE render (twinned in
`investigations.ts::exportMarkdown` byte-identically). The WRITE is separate and reuses
the `exportChat` precedent: `notes_subdir(id)` (the write-artifact allowlist — the ONLY
way a note reaches an investigation subfolder, re-validated at use) + `vault::write_artifact`
(sanitized, non-egress, walked/watched like any vault note). The `investigations` op's
`action:"export"` and the CLI `export` subcommand compose render + write and return
`{savedId, savedName}`.

## The non-Tauri crate story (why these build where the desktop crate can't)

`lighthouse-desktop` does not compile in the dev container (no webkit/gtk) — CLAUDE.md's
standing hazard. `lighthouse-cli` and `lighthouse-mcp` deliberately depend on
`lighthouse-core` ONLY (plus a small arg parser / JSON-RPC helper and `serde_json`),
with NO Tauri/webkit/gtk in their tree, so:

- they build on plain ubuntu and in the dev container (a shared-engine signature change
  now has TWO more in-container call sites that fail fast, instead of only surfacing in
  the desktop-release build);
- `cargo build --workspace` / `cargo test --workspace` (`native.yml:36/38`) pick them up
  automatically — adding them to `native/Cargo.toml` `members` is the whole CI wiring.

They are ENTRY PLUMBING, the same category as `lighthouse-server` and `lighthouse-desktop`:
Rust binaries that call the engine. Per `docs/ts-twin.md`, entry plumbing gets no
`src/server` twin — only shared engine BEHAVIOR does. So the binaries get a Rust-only
`ts-twin.md` row + a `PARITY:` note; only `fork`/`export_markdown` (shared store
behavior) mirror in `investigations.ts`.

## §5 — CI: a Rust-native headless smoke

The existing `release-smoke.yml` boot smoke proves the shipped binary answers one
grounded ask through its WEBVIEW (LIGHTHOUSE_SMOKE + `SMOKE_DRIVER_JS`). This change adds
the FIRST smoke that exercises the engine with NO webview: build `lighthouse` (release,
in the same 3-OS job — it is cheap next to the desktop binary), point it at the seeded
smoke fixture vault, run `lighthouse ask "<the fixture question>" --local --json`, and
assert the answer cites the fixture and quotes its content — exit code = verdict, the
boot-smoke contract. It slots beside the webview boot smoke as a parallel, transport-free
proof. (`native.yml` needs no edit: `--workspace` already builds and unit-tests the new
crates.)

## Rust/TS PARITY split

| Seam | Rust (ships) | TS twin |
|---|---|---|
| `ask::run_headless_ask` chokepoint (§1) | implemented in `ask.rs` | none — the two TS transports (`app/api/chat`) already wire the equivalent inline; the helper is Rust plumbing, `PARITY:` note |
| `lighthouse` CLI binary (§2) | implemented (`lighthouse-cli`) | none — Rust-only entry plumbing (`ts-twin.md` row) |
| `lighthouse-mcp` server (§3) | implemented (`lighthouse-mcp`) | none — Rust-only entry plumbing (`ts-twin.md` row) |
| `run_analytics_sql` MCP tool (§3) | `analytics::run_direct` | analytics is Rust-only anyway; MCP has no twin |
| `investigations::fork` (§4) | implemented | mirrored in `investigations.ts::fork` byte-compatibly |
| `investigations::export_markdown` (§4) | implemented (render literal) | mirrored in `investigations.ts::exportMarkdown` byte-identically |

## Failure & degradation

- **No provider configured / no key:** `ask` behaves exactly as an app ask with no
  provider — the local/extractive path answers (or `answer_pipeline` emits the
  "model unavailable —" note); the CLI's provenance shows `device`, and the exit code
  reflects whether an answer settled.
- **`--local` / local-only scope:** device, zero-network, `$0.00`; the audit record
  and provenance say so. Most-restrictive wins over `--local` vs a `local-only`
  investigation (both force device).
- **`fork` name collision / missing parent:** a human-readable `Err` (the `create`/
  `rename` error idiom), nothing persisted.
- **`export` of an unusable folder / unknown id:** `notes_subdir` returns a
  human-readable `Err` (its existing validate-at-use guard); nothing is written.
- **MCP unknown/oversized request:** a JSON-RPC error; a `run_analytics_sql` that is
  not a read-only SELECT is refused by `guard_sql` (the analytics guard is the
  boundary, not the MCP layer).
- **Cache replay through the helper:** `answer_cost` is None (0 new / `$0`), so the
  provenance and the cumulative audit total never double-count — the `chat_post`
  behavior, inherited for free.
