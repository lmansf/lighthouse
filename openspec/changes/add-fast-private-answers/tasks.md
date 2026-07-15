# Tasks — fast private answers

## 1. Wire field + setting (both engines; the compile tripwire lands here)
- [x] 1.1 `ChatChunk.draft: Option<bool>` (contracts.rs) + `draft?: boolean`
  (types.ts); add `draft: None` to the 3 synth.rs helper literals.
- [x] 1.2 `draftAnswers` on `DesktopSettings` (settings.rs) + writer param;
  `draftAnswers?: boolean` (settings.ts interface).
- [x] 1.3 `settings_test.rs`: extend the exhaustive round-trip (struct literal,
  no-`..` destructure, assert, wire-key list, positional writer call + read-back).

## 2. Draft helper + emission (both engines)
- [x] 2.1 `draft_answer`/`draftAnswer`, factored out of the keyless `extractive`
  renderer (byte-identical top-3-passage rendering, no head/footer).
- [x] 2.2 `draft_chunk` helper (synth.rs) + the gated emission at the choke point
  (local provider + `draftAnswers != false` + non-empty contexts), before the
  decide block; mirror in synth.ts with a PARITY comment for the offset.
- [x] 2.3 Unit tests: `llm.rs` `draft_answer` + `test/draftAnswer.test.mjs`.

## 3. Desktop shell (Rust, CI-verified) + server parity
- [x] 3.1 `GpuLaunchState` + `gpu_state` field on `Supervisor`; record on spawn.
- [x] 3.2 `gpu_status()` — read gpu_state, release it, then compute `running`
  live from the `llm` lock (lock-order-safe).
- [x] 3.3 `model_status(app)` merges `gpuOn`/`gpuLayers`/`gpuRunning`.
- [x] 3.4 `settings_get`/`settings_set` carry `draftAnswers` (both
  `write_desktop_settings` calls updated).
- [x] 3.5 Server `routes.rs`: `draftAnswers` round-trip + PARITY note that GPU
  fields are desktop-only on `model_get`.

## 4. UI
- [x] 4.1 `ChatPanel.tsx`: `draftActive`/`draftRef`, the streaming branch on
  `chunk.draft` (accumulate vs first-authoritative wipe), resets, the badge + style.
- [x] 4.2 `LicenseGate.tsx`: `draftAnswers` state/load/handler + the Switch.
- [x] 4.3 `LocalModelOption.tsx`: GPU fields on `ModelState` + the status line.
- [x] 4.4 `tauriTransport.ts`: `draftAnswers` in the `/api/settings` POST mapping.

## 5. Gates
- [x] 5.1 `cargo build`/`cargo test -p lighthouse-core` green (incl. the tripwire).
- [x] 5.2 `cargo build -p lighthouse-server` green (the writer call site).
- [x] 5.3 `tsc --noEmit` + `next lint` + `node --test test/*.test.mjs` green.
- [x] 5.4 No `CACHE_VERSION` change (extract.rs untouched).
- [x] 5.5 `node scripts/openspec-validate.mjs add-fast-private-answers` green.
- [ ] 5.6 CI-only: `desktop-release.yml` compiles the desktop call sites;
  `release-smoke.yml` boots and answers one zero-network ask through the draft
  → verified replace path.
