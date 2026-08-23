# Tasks — refocus: chat attachments only (0.15.0)

Gate: CLEARED — owner sign-off received 2026-08-23, all five decisions
on the recommended option (see proposal.md "Decisions").
First act of implementation: record the 0.15.0 owner designation in
CLAUDE.md's versioning section (the §31/0.14.0 precedent).

## 1. Engine core (both engines, PARITY)
- [x] 1.1 `workspace.rs` ⇄ `workspace.ts`: blob store (sha256,
      write-once), per-conversation manifest, `att-` id minting, the
      10-attachment / 25 MB caps, mark-and-sweep for unreferenced blobs.
- [x] 1.2 Eager ingest on attach: extract ∥ profile ∥ catalog ∥ index,
      content-hash-keyed caches under `app_state_dir()/cache/`, readiness
      state per attachment, ask-awaits-only-what-it-needs.
- [x] 1.3 Re-root `config::state_dir()` at `app_state_dir()` (kills the
      vault_dir derivation — the audit's structural trap #1).
- [ ] 1.4 `workspace::retrieve` + `doc_text`/`doc_path` via manifest;
      collapse `included_file_ids`/`attachment_file_ids` across the synth
      branch helpers; freshness stamps switch to content hashes.
- [ ] 1.5 Answer cache re-key to sorted (attachment id, hash) pairs.
- [ ] 1.6 Deletions: walker/state/include/local-only/curation in
      `vault.rs`/`vault.ts`, `watch.rs`, `meta.rs`, `insights.rs`,
      `vault_brief.rs`, `sources/*`, views, semantic, pins, boards,
      briefings, investigations — with their tests.
- [ ] 1.7 Reports re-home to `app_state_dir()/reports/`; export via save
      dialog.

## 2. Transports + shell
- [ ] 2.1 Upload surfaces (`routes.rs`, `commands.rs`, `app/api/upload`,
      `tauriTransport.ts`) target the workspace, enforce the caps, return
      readiness.
- [ ] 2.2 Ask surfaces drop include/scope resolution; vault-generation
      SSE/Tauri push retires with the watcher.
- [ ] 2.3 iOS: retire the `Documents/Lighthouse Vault` bootstrap + §41
      migration path; Files-app picker attaches directly.

## 3. CLI / MCP
- [ ] 3.1 `lighthouse ask <files…> "q"` (attachment semantics); `--vault`,
      fork/export refit or retire per proposal.
- [ ] 3.2 MCP: `ask_files(paths, question)`; `ask_vault`/`list_files`
      retire.

## 4. UI
- [ ] 4.1 Remove explorer, quick-open, widget, vault onboarding, and the
      briefings/views/semantic/boards/investigations surfaces.
- [ ] 4.2 ChatPanel attach flow: cap refusal message, per-file readiness
      ticks, ingest-error rows; empty-conversation nudge.
- [ ] 4.3 Reports home re-pointed at the new store.

## 5. Version + docs
- [ ] 5.1 Seven-stamp bump to 0.15.0; CLAUDE.md designation line.
- [ ] 5.2 ARCHITECTURE.md, data-flows.md, CONVENTIONS.md registries,
      launch copy, README.
- [ ] 5.3 Release notes: the app stops reading the vault folder; user
      files stay where they always were; old `.rag-vault` state left on
      disk untouched.

## 6. Tests
- [ ] 6.1 Workspace suites (both engines, shared fixtures): id minting,
      caps at 10/11 and 25 MB, manifest round-trip, blob dedupe across
      conversations, sweep.
- [ ] 6.2 Eager-ingest: attach-then-ask races (ask mid-ingest awaits;
      ingest failure degrades honestly), re-attach hits every cache.
- [ ] 6.3 Cache re-key: same files re-attached in a new conversation hit;
      any byte change misses.
- [ ] 6.4 Deletion tripwires: removed settings fields flagged by
      settings_test.rs's no-`..` destructuring; removed wire fields off
      the contracts.

## 7. Verify
- [ ] 7.1 Full verification: cargo workspace tests, node tests, tsc,
      lint, eval + chart floors, release-smoke 3-OS gate, LIGHTHOUSE_SMOKE
      boot answering one zero-network attached-file ask.
