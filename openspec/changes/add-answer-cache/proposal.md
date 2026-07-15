# Answer cache: re-asking an unchanged question is instant

## Why

Analysts re-ask. "Q3 revenue by region" gets asked before a meeting, again
during it, again after — and today every re-ask pays the full pipeline:
retrieval, registration, SQL, model narration, seconds of wall-clock and (on a
cloud provider) another excerpt send. Beam answers are deterministic SQL over
unchanged data — the second run computes byte-identical results. A cache keyed
on *everything that could change the answer* makes the repeat instant, and its
freshness stamp makes the shortcut honest: "From cache · same data as HH:MM ·
Re-run".

## What Changes

- **Key** (any component changing is a different key): the normalized question
  (case/whitespace/trailing-punctuation folded) + a digest of the
  provider-effective candidate set — the sorted (file id, `mtimeMs:size`) pairs
  of `shareable_file_ids(is_cloud)`, which already folds include flags,
  local-only marks, and per-file index freshness — + provider id + model id +
  the sorted attachment id set. **Global-digest tradeoff (v1, stated):** the
  digest spans the whole shareable set, so ANY vault change invalidates every
  entry — over-invalidation accepted; correctness beats hit rate.
- **Hit:** replay the stored answer verbatim — text (with its SQL/chart fences
  and honesty footers), references, analytics meta, provenance stamp — plus an
  engine-emitted `cachedAt` on the final chunk's meta; the UI renders "From
  cache · same data as HH:MM" with a **Re-run** affordance that re-asks with a
  `bypassCache` wire flag (bypasses lookup, refreshes the entry). Miss or any
  doubt (unparseable entry, digest mismatch, error'd answer): run live.
- **Store:** a bounded LRU. Always in-memory for the session. Disk persistence
  (compact JSON in the install-global app-state dir — NEVER the vault) only
  when the request says persistence is allowed: chat-history opt-in is
  client-only state (`localStorage`, by design — docs/ts-twin.md), so the
  client sends its `persistEnabled && !managed-locked` verdict per ask as
  `persistAllowed`. History OFF ⇒ in-memory only AND any existing disk cache
  file is deleted on the next ask (cached answers are chat content — the
  privacy posture wins over the optimization).
- Only successful, completed answers are cached. Beam answers are the anchor
  case; general RAG answers replay with identical stamp semantics.

## Capabilities

### New Capabilities
- `answer-cache`: verbatim, freshness-stamped replay of an unchanged question
  over unchanged data, invalidated by any change to the question, the
  provider-effective candidate set, the provider, or the attachments.

## Impact

- **Both engines (PARITY):** a new `answer_cache.rs` ⇄ `answerCache.ts`
  (normalize, key/digest, LRU, disk persistence + deletion); the short-circuit
  at the top of `answer_pipeline` (`synth.rs:448` ⇄ `synth.ts:291`) so all
  three transports are covered; wire fields `bypassCache`/`persistAllowed` in
  `routes.rs`/`commands.rs`/`app/api/chat/route.ts`; `ChunkMeta` gains
  `cachedAt` (`contracts.rs:124-130` ⇄ `types.ts`).
- **UI:** the cache line + Re-run affordance under answers (`ChatPanel.tsx`),
  sending `bypassCache`; the client's persistence verdict from
  `useChatStore.persistEnabled()` + `managedLocks`.
- **Tests:** key-composition units (provider / marks / attachments / per-file
  index key each change the key); history-off writes nothing and deletes the
  disk file; E2E: ask → re-ask hits with ZERO model calls (mocked provider
  counts) → touch a source file → re-ask runs live.

## Non-goals

- **No partial/semantic matching.** Exact-key replay only; a reworded question
  runs live. (Type-ahead handles "same question again" ergonomics.)
- **No per-file incremental invalidation in v1.** The global digest
  over-invalidates by design; finer-grained keys are a later refinement.
- **No cross-vault or cross-provider sharing** — the vault digest and provider
  id are in the key.
- **No caching of errored/incomplete answers,** and no replay of progress
  chunks — a hit is one text chunk + the final chunk.
- **No new egress and no vault writes** — the store lives in memory and (only
  when allowed) the app-state dir.
