# Design — answer cache

## The key

`sha256(normalized_question ∥ candidate_digest ∥ provider_id ∥ model_id ∥
sorted(attachment_ids))`, where:

- `normalized_question`: trim, lowercase, collapse internal whitespace, strip
  trailing `?!.` — deliberately conservative (no stemming/synonyms): the cache
  must never conflate questions that could answer differently.
- `candidate_digest`: over the provider-effective set the pipeline itself uses —
  `shareable_file_ids(is_cloud)` (vault.rs:1207), sorted, each paired with its
  index freshness key `mtimeMs:size` (index.rs `key_of`). This inherits every
  gate the answer respects: include flags, local-only marks under a cloud
  provider, and per-file freshness. There is no global index version to lean on
  (the watcher `GENERATION` resets per process), so the digest aggregates
  per-file keys directly.
- Provider AND model id: a different narrator is a different answer.
- Attachments: the per-question consent scope is part of what was asked.

**Tradeoff (pinned):** hashing the whole shareable set makes any vault change —
one new file, one flag flip — invalidate everything. Accepted for v1: the digest
is cheap (the walk is already cached), over-invalidation only costs a live run,
and no stale answer can survive a data change. Stated here so a v2 per-file
refinement has its baseline.

## Hit semantics

A stored entry holds the final answer verbatim: the full markdown text (whose
SQL fence, chart fence, and honesty footers ride inside), `references`,
`analytics` meta, the provenance `ChunkMeta`, and `created_ms`. Replay emits ONE
delta chunk (the text) + the final chunk with the stored references/meta and
`meta.cachedAt = created_ms`. The UI renders "From cache · same data as HH:MM ·
Re-run"; Re-run re-sends with `bypassCache: true`, which skips lookup, runs
live, and overwrites the entry. Anything doubtful — deserialization failure,
version mismatch, an entry recording an error — is a miss; the pipeline runs
live exactly as today.

## Store & the privacy gate

- **In-memory LRU always** (session scope), bounded (64 entries; eviction by
  recency). This is what makes re-asks instant with history off.
- **Disk** (`app_state_dir()/answer-cache.json`, compact JSON, same bounded
  shape, versioned envelope `{v:1, entries:[…]}`): written only when the
  triggering request carried `persistAllowed: true`. Chat-history opt-in is
  deliberately client-only (`useChatStore` + `localStorage`, per its module
  header), so the client computes `persistEnabled() && !chatHistoryLocked()`
  and sends it per ask — the engines never learn a global flag, only a
  per-request verdict, which also keeps the managed-policy lock effective.
- **Posture wins:** on a request with `persistAllowed: false`, the engine
  deletes `answer-cache.json` if present (mirrors history-off clearing stored
  conversations) and serves memory only. Disk is lazily loaded on the first
  allowed request of a session.
- Never the vault; never any network.

## Rust/TS parity

Mirrored capability (`answer_cache.rs` ⇄ `answerCache.ts`): normalization,
digest, LRU, persistence gate, and the pipeline short-circuit land in both,
with shared-fixture key tests. The TS twin's candidate set is its lexical
shareable set (its own `shareableFileIds`), and its "freshness key" is
mtime+size from stat — same shape, twin-local values (PARITY note; the twins
never share a cache file: the digest differs by design where capabilities
differ). `ChunkMeta.cachedAt` mirrors byte-parallel.

## Failure & degradation

- Cache failure of any kind → live run (the feature can only add speed, never
  break an answer — house rule).
- A cached Beam answer replays its chart/SQL/footers byte-verbatim, so honesty
  footers and the provenance stamp are exactly what the live run produced;
  `cachedAt` is additive.
- 6144 window: irrelevant on hits (no model call); the cache adds zero prompt
  content on misses.
- Concurrent asks: last-completed-wins on insert; entries are immutable once
  written.
