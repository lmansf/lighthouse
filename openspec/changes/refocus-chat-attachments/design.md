# Design — refocus: chat attachments only

## The workspace

One content-addressed blob store, many tiny manifests:

```
app_state_dir()/
  workspace/
    blobs/<sha256-hex>            # the bytes, written once, never renamed
    <conversation-id>.json        # {v:1, files:[{id,name,hash,size,addedMs}]}
  cache/
    extract/<hash>.*              # extraction cache, re-keyed content-hash
    columns/<hash>.json           # per-file column catalog
    profile/<hash>.json           # table profile
    index/<hash>.json             # chunk index
  reports/                        # re-homed Lighthouse Reports/Results
```

- **Attachment id** = `att-<first 12 hex of sha256(hash + name)>` — stable
  for the same bytes-under-the-same-name, engine-minted (the pins/
  investigation-id precedent), never a filesystem path. The resolver is
  `manifest.files.find(id)` → blob path. Nothing walks.
- **Blobs are shared across conversations** (content addressing), manifests
  are per-conversation; deleting a conversation deletes its manifest, and a
  mark-and-sweep on startup drops unreferenced blobs older than 30 days.
- **The cap is a workspace invariant**: attach #11 is refused with a clear
  message (drop one first). Per-file 25 MB cap unchanged. Both enforced in
  every transport (route, Tauri command, CLI) AND in the engine's
  `workspace::attach` — the transports narrow, the engine decides.

## Eager ingestion (the performance thesis)

`workspace::attach(bytes, name)` returns after the blob write + manifest
update (fast), then fires the ingest pipeline for the hash: extract →
{table profile ∥ column catalog ∥ chunk index} in parallel, all cached
under the hash. The chat shows a per-attachment readiness tick; an ask that
arrives mid-ingest awaits only the pieces it needs (analytics awaits the
catalog, RAG awaits the index — the existing degrade-don't-break rule).
Re-attaching known bytes is a manifest write: every cache hits.

Cold numbers to beat (audit, 2026-08): first ask over a fresh 5-file set
today pays walk + extract + profile + catalog inside the ask. Target:
attach-to-ready under 2 s for 10 typical files (CSV/XLSX/PDF ≤ 25 MB),
first token of the first ask gated only by the model call.

## The ask pipeline

- `included_file_ids` / `attachment_file_ids` collapse into the manifest's
  attachment set: every branch helper (the §45 decomposition —
  `meta_branch` retires, the rest keep their shapes) receives the same
  resolved `Vec<Candidate>`; `shareable_subset` reduces to the set itself
  (no include flags, no local-only marks — attach is consent; the per-ask
  provider choice + egress shield remain the cloud gate).
- `vault::retrieve` becomes `workspace::retrieve`: same chunk scoring over
  the per-hash index files, minus the walk. `doc_text`/`doc_path` resolve
  via manifest.
- Freshness stamps ("Computed from N files · HH:MM") switch their key from
  `mtimeMs:size` to the content hash — attachment bytes are immutable, so
  "same data" claims become exact instead of heuristic.
- Answer cache key: normalized question + provider/model + sorted
  `(attachment id, hash)` pairs. The view/semantic registry components stay
  only if fork 1 keeps those features.

## Parity

- `workspace.rs` ⇄ `workspace.ts` mirrored byte-compatibly (KEEP IN SYNC),
  including id minting, manifest layout, and cache keys — the twins share
  fixtures like the answer-cache suites do today.
- Deleted modules delete in BOTH engines; analytics stays PARITY-diverged
  (Rust-only) exactly as documented.
- The 6144-token local window is untouched: candidate sets get smaller
  (≤10 files), so prompt budgeting only relaxes.

## Degradation

- Ingest failure on attach → the attachment stays listed with its error
  ("couldn't read this PDF"), name-findable, excluded from analytics; the
  ask degrades to the readable subset (existing rule, now surfaced at
  attach time instead of ask time).
- Manifest/blob corruption → the attachment re-uploads on next use; asks
  over missing blobs answer honestly about the gap (the pins "missing
  source" precedent).
- A conversation with zero attachments → the model-free "attach files to
  begin" nudge; no silent empty-corpus retrieval.

## Testing story (quality-audit §07 rec 7, decided here)

- The engine cut lands with its own suites (workspace round-trip, id/cap
  boundaries, eager-ingest readiness, cache re-key) in both engines;
  mutation.yml gates every changed module per PR.
- **Executed UI component tests start AFTER this cut, not before** — the
  audit found 165 UI components over the CRAP bar, but a large share sit in
  surfaces this change deletes (explorer, views/semantic/boards nav,
  widget). Writing executed tests for them now would be testing the
  demolition site. The source-pin suite remains the UI guard through the
  cut; the first executed component targets afterward are the surviving
  CCN>30 components — ChatPanel internals first (attach flow, readiness
  ticks, the cap refusal), then SettingsPanel.
- The release gate is unchanged: release-smoke.yml's 3-OS boot must pass
  with a zero-network attached-file ask before 0.15.0 tags.
