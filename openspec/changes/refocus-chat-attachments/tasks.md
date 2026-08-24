# Tasks — refocus: chat attachments only (0.15.0)

Gate: CLEARED — owner sign-off received 2026-08-23, all five decisions
on the recommended option (see proposal.md "Decisions").
Shipped 2026-08-24 as **0.15.0**.

## 1. Engine core (both engines, PARITY)
- [x] 1.1 `workspace.rs` ⇄ `workspace.ts`: blob store (sha256,
      write-once), per-conversation manifest, `att-` id minting, the
      10-attachment / 25 MB caps, mark-and-sweep for unreferenced blobs.
- [x] 1.2 Eager ingest on attach: extract ∥ profile ∥ catalog ∥ index,
      content-hash-keyed caches under `app_state_dir()/cache/`, readiness
      state per attachment, ask-awaits-only-what-it-needs.
- [x] 1.3 Re-root `config::state_dir()` at `app_state_dir()` (kills the
      vault_dir derivation — the audit's structural trap #1).
- [x] 1.4 `workspace::retrieve` + `doc_text`/`doc_chunks` via manifest, and
      the pipeline reads them through a `Corpus`. Collapsed to ONE arm in
      1.6: a conversation id, or an empty corpus.
- [x] 1.5 Answer cache re-key to sorted (attachment id, hash) pairs. The
      vault-era `cache_key` and three now-always-empty key components
      (preferred conversations, view registry, semantic registry) went with
      it; the byte layout is unchanged, so pre-deletion entries keep hitting.
- [x] 1.6 Deletions: briefings, boards, pins, investigations, vault_brief,
      insights, views, semantic, connectors (`sources/`), the vault core,
      and `watch.rs`. The RANKER survives as `retrieval.rs` ⇄ `retrieval.ts`;
      `meta.rs` was SPLIT rather than deleted (its corpus-meta answers,
      suggested asks, applicable recipes and capability map all still make
      sense over attachments).
- [x] 1.7 Reports re-home to `app_state_dir()/reports/`; export via save
      dialog.
- [x] 1.8 TS twin: `Corpus` over the retrieval/doc sites, `conversationId`
      through `app/api/{chat,upload}`, investigations deleted with the UI
      surface it fed.

## 2. Transports + shell
- [x] 2.1 Upload surfaces target the workspace (`routes.rs` multipart
      `conversationId`, `commands.rs` `x-conversation-id`, `tauriTransport.ts`,
      the Next.js `app/api/upload` twin), enforcing the engine's caps and
      starting ingestion at once. An upload naming no conversation is refused.
- [x] 2.2 Ask surfaces drop include/scope resolution; the vault-generation
      push retires with the watcher (`watch_generation` stays an inert 0 so an
      older client polling it gets a stable answer).
- [x] 2.3 iOS: the `Documents/Lighthouse Vault` bootstrap retires. The §41
      state-home migration is KEPT — it carries the signed-in profile and the
      sealed keys — but reads a fixed historical path rather than a live
      setting.

## 3. CLI / MCP
- [x] 3.1 `lighthouse ask "<q>" [files…]` (attachment semantics); `--vault`
      and `--include` retired, the 10-file cap refused at PARSE time.
- [x] 3.2 MCP: `ask_files(question, paths, local)`; `ask_vault` / `list_files`
      retire (an unknown tool is a protocol error, never a silent empty).

## 4. UI
- [x] 4.1 Explorer, quick-open, widget vault surfaces, vault onboarding, and
      the briefings/views/semantic/boards/investigations surfaces removed.
- [x] 4.2 ChatPanel attach flow: the engine's cap refusal shown verbatim,
      ingest-error rows, empty-conversation nudge.
- [x] 4.3 Reports home re-pointed at the conversation's attachments.

## 5. Version + docs
- [x] 5.1 Seven-stamp bump to 0.15.0; CLAUDE.md designation line.
- [x] 5.2 ARCHITECTURE.md, data-flows.md, CONVENTIONS.md, launch copy, README.
- [x] 5.3 Release notes (`docs/releases/0.15.0.md`): the app stops reading the
      vault folder; user files stay where they always were; old `.rag-vault`
      state left on disk untouched. Local-only marks are called out by name as
      a real reduction in per-file control.

## 6. Tests
- [x] 6.1 Workspace suites (both engines): id minting, caps at 10/11 and
      25 MB, manifest round-trip, blob dedupe across conversations, sweep,
      traversal-shaped conversation ids.
- [x] 6.2 Eager-ingest: attach-then-ask, ingest failure degrades honestly,
      re-attach hits every cache.
- [x] 6.3 Cache re-key: same files re-attached in a new conversation hit; any
      byte change misses; the key's byte layout pinned against raw material in
      both engines.
- [x] 6.4 Deletion tripwires. `test/desktopCrateResolves.test.mjs` grew from
      one check to four, each added after a REAL break and confirmed to fail
      on it: module resolution (qualified paths AND braced/un-braced import
      lists), ITEM resolution (`dep::module::item` against what that module
      exports), and a Rust-aware delimiter scanner (comments, escaped and
      raw/byte strings, char literals vs lifetimes; skipped spans keep their
      newlines, so it named the same line rustc did). Every one also runs
      over `lighthouse-server`, which compiles here — a scanner that
      mis-reads a lifetime fails THERE instead of going quietly green on the
      crate nobody could check. The perf gate's subject moved from a
      2,000-file walk to a full conversation.

## 7. Verify
- [x] 7.1 Full verification. Green in this container:
      `cargo test --workspace --exclude lighthouse-desktop` (29 binaries,
      0 failures, 0 warnings — core lib 341 after the ranker's 9 unit tests
      were restored to `retrieval.rs`); `node --test "test/**/*.test.mjs"`
      (668 pass / 0 fail); `tsc --noEmit` (no new errors against the
      baseline); `cargo check` over the five tauri-free crates;
      `analytics_eval` (SCORECARD 39/39, rate=1.000) and `chart_eval` (all
      checks) floors; the desktop-crate resolver tripwire (2/2). The seven
      version stamps were re-read and all say 0.15.0, including all SIX
      `lighthouse-*` crates in `native/Cargo.lock`.

      **The desktop crate was verified here too**, which this task assumed
      was impossible. `apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev`
      makes `cargo check --workspace --all-targets` cover
      `lighthouse-desktop`; it is clean but for one warning that predates
      this change (`UpdateInfo.kind`, unread since 0.14.19, present on
      main), and `cargo test -p lighthouse-desktop` passes. That capability
      immediately found FIVE real breaks in the wrapper — a file that did
      not parse, a call into a deleted shell fn, two arity mismatches, and
      the `conversationId` that `/api/open` and `/api/reveal` never sent —
      all shipped by earlier tasks under the belief that grep was the only
      available check. CLAUDE.md and docs/crate-split.md now carry the
      install recipe instead of the blind-spot warning.

      Two legs remain CI-only: `npm run lint` (neither `next` nor `eslint`
      is in the partial `node_modules` here) and the `release-smoke.yml`
      3-OS gate with its LIGHTHOUSE_SMOKE=1 boot, which needs a RELEASE
      build of the real binary on each OS. `desktop-release.yml` gates on
      both before it creates a draft.
