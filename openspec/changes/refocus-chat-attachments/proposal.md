# Refocus: chat attachments only — drop the persistent vault (0.15.0)

## Why

Owner directive (2026-08): scale the product back to the thing it should be
best in the world at — **analyzing a small group of files the user hands it,
right in the chat**. Upload one to ten files, ask, get grounded cited answers
and engine-verified analytics, instantly. Everything the persistent vault
brought with it — the walker and its caches, include flags, curation rules,
folder watching, the explorer tree, multi-source registries — is surface area
that dilutes that focus and taxes every ask with corpus-scale bookkeeping.

The dependency audit (2026-08-23) makes the cut tractable and names the two
structural traps:

1. **Attachments today ARE vault nodes.** Uploads land via `vault::add_file`
   under `VAULT_DIR`, and ids resolve only through `walk(&vault_dir())`
   (`vault.rs:2730` ⇄ `vault.ts:1958`). Attachments-only is not "vault minus
   the walker" — it needs its own content root and a resolver that never
   walks.
2. **`config::state_dir()` derives from `vault_dir()`** on every non-iOS
   platform. Dropping `VAULT_DIR` orphans every `.rag-vault` store unless the
   surviving stores are re-rooted at `app_state_dir()` first.

This is a rewrite-scale change: per the versioning policy the owner has
designated it the **0.15.0** overhaul (record the designation in CLAUDE.md's
versioning section when implementation starts).

## What Changes

- **The session workspace replaces the vault.** Each conversation owns a
  workspace: up to **10 attachments** (25 MB/file cap unchanged), stored
  content-addressed under `app_state_dir()/workspace/blobs/<sha256>` with a
  per-conversation manifest (`workspace/<conversation-id>.json`) mapping
  attachment id → `{name, hash, size, addedMs}`. Ids resolve through the
  manifest — a map lookup, no walker, no TTL caches, no watcher.
- **Attach is the moment of consent and the moment of work.** Attached =
  included (include flags, local-only marks, and curation rules retire; the
  cloud-egress decision is the existing per-ask provider choice + egress
  shield, unchanged). On attach the engine eagerly runs the whole ingestion
  pipeline in parallel — extract, table profile, column catalog, index
  chunks — keyed by content hash, so the FIRST ask starts with warm caches
  and re-attaching the same file anywhere (any conversation, any session) is
  instant.
- **The ask pipeline reads the workspace.** `retrieve` resolves candidates
  from the manifest; `attachment_file_ids` and `included_file_ids` collapse
  into one attachment set. Analytics/beam, charts, recipes, quotes, the
  numeric guard, provenance and freshness stamps are unchanged in behavior —
  they already operate on `(id, name, path)` triples.
- **The answer cache is re-keyed** from the global vault digest to the
  attachment set's `(id, contentHash)` pairs — the v1 "any vault change
  invalidates everything" tradeoff dies with the vault; identical files
  re-attached hit the cache.
- **Reports re-home.** `Lighthouse Reports/` (and `Lighthouse Results/`)
  move from in-vault artifact writes to `app_state_dir()/reports/`, listed by
  the existing Reports home; "export" writes to a user-chosen path via the
  save dialog.
- **CLI and MCP refit to the same model**: `lighthouse ask <files…> "q"`
  (attachment semantics, no `--vault`), MCP `ask_files` taking explicit
  paths. The headless contract becomes the product's contract.
- **Removed outright** (engine + UI): the vault walker/state/watcher
  (`vault.rs`/`vault.ts` shrink to the workspace + extraction plumbing,
  `watch.rs` deleted), explorer / quick-open / widget tree surfaces,
  curation rules, include flags, local-only marks, meta answers
  (`meta.rs` — "what's new in my vault" has no referent), `insights.rs` and
  `vault_brief.rs` (vault-wide scans), connectors/cloud sources (SharePoint
  mirror + OAuth registry), briefings, and the vault onboarding step.
- **Removed pending the sign-off forks below**: views, semantic layer,
  pins, boards, investigations (all premised on a durable corpus — see
  Open decisions).
- **Version**: seven-stamp bump to **0.15.0**; release notes state plainly
  that the app stops reading the vault folder and user files stay where they
  always were (the vault was the user's own folder; nothing is deleted or
  migrated).

## Non-goals

- No data migration or import of `.rag-vault` state into the workspace —
  0.15.0 stops READING the vault; it never deletes it. Old stores stay on
  disk untouched.
- No change to providers, local model, updater, settings, secrets, audit,
  egress shield, or the release pipeline (beyond the version bump).
- No raise of the 25 MB/file cap and no streaming-upload work — small groups
  of normal files, done exceptionally well.
- No new collaboration/sync features; the workspace is local state like
  everything else.
- Not a UI redesign: ChatPanel keeps its layout; surfaces that lose their
  subject are removed, not reimagined.

## Open decisions (owner sign-off before implementation)

1. **Views + semantic layer**: drop in 0.15.0 (recommended — both store
   durable vault-file ids; per-conversation "define a metric for THESE
   files" can return later scoped to attachments), or port to
   workspace-scoped definitions now (adds a rewrite inside the rewrite).
2. **Pins / boards / briefings / investigations**: drop in 0.15.0
   (recommended — every one is a promise that file ids outlive the
   conversation), or keep investigations as a thin conversation-organizer
   without recall/scopes.
3. **Reports**: keep re-homed in app state (recommended) or reduce to
   export-only.
4. **iOS**: stays in scope (recommended — attachments-only makes iOS
   simpler: the Files-app picker IS the attach flow; the §41 state-home
   migration and `Documents/Lighthouse Vault` bootstrap retire), or pause
   the target for one release.
5. **TS twin**: keep byte-parity for the surviving engine modules
   (recommended — the dev-container and web transport still depend on it;
   the cut shrinks the parity surface substantially), or freeze the twin.

## Capabilities

### New Capabilities
- `chat-attachments`: a per-conversation workspace of 1–10 files with
  eager content-hash-keyed ingestion, manifest-resolved retrieval, and
  attachment-scoped answer caching — the only corpus the app has.

### Removed Capabilities
- `vault` (walk/include/local-only/curation/watch), `explorer`,
  `meta-answers`, `insights`, `vault-brief`, `connectors`, `briefings`,
  and — per the open decisions — `shaped-views`, `semantic-layer`, `pins`,
  `boards`, `investigations`.

## Impact

- **Both engines (PARITY)**: `workspace.rs` ⇄ `workspace.ts` (new: blobs,
  manifest, resolver, eager ingest); `vault.rs`/`vault.ts` reduced;
  `synth.rs` ⇄ `synth.ts` candidate resolution + the branch helpers'
  `included_file_ids`/`attachment_file_ids` collapse; `answer_cache.rs` ⇄
  `answerCache.ts` re-key; `meta.rs`, `insights.rs`, `vault_brief.rs`,
  `watch.rs`, `sources/*` deleted; `config.rs` ⇄ `config.ts` re-root
  `state_dir()` at `app_state_dir()`.
- **Shell/transports**: `routes.rs`, `commands.rs`, `app/api/*` upload +
  ask surfaces take the 10-attachment cap; SSE/Tauri vault-generation push
  retires with the watcher.
- **UI**: explorer/quickopen/widget/onboarding-vault/briefings surfaces
  removed; ChatPanel's attach flow gains the cap + per-file ingest status;
  Reports home re-pointed.
- **CLI/MCP**: `lighthouse ask <files…>`, MCP `ask_files`; `--vault`,
  `ask_vault`, `list_files` retire.
- **Tests**: the twin parity suites shrink with the surface; workspace
  round-trip + eager-ingest + cache-re-key suites land with the code
  (mutation.yml gates changed modules); `settings_test.rs`'s no-`..`
  destructuring flags every removed settings field.
- **Docs**: ARCHITECTURE.md, data-flows.md, CONVENTIONS.md registry
  entries, CLAUDE.md versioning designation, launch copy.
