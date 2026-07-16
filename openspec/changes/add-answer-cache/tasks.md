# Tasks — answer cache

## 1. Engine core (both engines, PARITY)
- [x] 1.1 `answer_cache.rs` ⇄ `answerCache.ts`: question normalizer, candidate digest over sorted (id, mtimeMs:size) pairs of the provider-effective shareable set, sha256 key, bounded in-memory LRU (64), versioned compact disk envelope in app_state_dir, delete-on-disallowed.
- [x] 1.2 Wire fields `bypassCache` + `persistAllowed` through routes.rs / commands.rs / app/api/chat/route.ts into the pipeline cfg.
- [x] 1.3 Short-circuit at the top of `answer_pipeline` ⇄ `answerPipeline`: hit → one text chunk + final chunk with stored refs/meta and `cachedAt`; miss/bypass → live, insert on successful completion only.
- [x] 1.4 `ChunkMeta.cachedAt` (contracts.rs ⇄ types.ts, serde camelCase).

## 2. UI
- [x] 2.1 Client persistence verdict (`persistEnabled() && !chatHistoryLocked()`) sent per ask; Re-run sends `bypassCache`.
- [x] 2.2 The cache line under answers: "From cache · same data as HH:MM · Re-run" from `meta.cachedAt`.

## 3. Tests
- [x] 3.1 Key composition (both suites, shared fixtures): provider, marks, attachments, per-file freshness key each change the key; normalization folds case/whitespace/trailing punctuation only.
- [x] 3.2 History-off: nothing written, existing disk file deleted; history-on: bounded LRU round-trips disk.
- [x] 3.3 E2E: ask → re-ask hits with zero model calls (mocked provider counts calls) → touch a source file → re-ask runs live. Corrupt-store self-heal.

## 4. Verify
- [x] 4.1 Full verification: cargo core+server, npm test, tsc, lint; eval + chart floors untouched and green.
