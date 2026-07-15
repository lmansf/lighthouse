# Local-only file marks: "Private — this device only"

## Why

Inclusion today is one axis: a file is *visible to the AI* or it isn't. But
"the AI" is two very different things — a model running **on this device** (the
bundled local model, or the extractive fallback) that reads files without a
byte leaving the machine, versus a **cloud vendor** that receives excerpts of
whatever is included. A user may happily let the on-device model read a
sensitive contract while never wanting a single line of it sent to a cloud
provider. There is no way to express that today; the only lever is to exclude
the file outright, which also blinds the private model.

Local-only marks add the missing second axis. A node can be marked **"Private —
this device only"**: it participates normally when the answer is produced on
device, and is **excluded from everything a cloud provider would receive** —
retrieval, attachments, Beam analytics registration, and catalog/metadata
answers (column names are content too). The distinction is enforced in the
**engine**, at the context-assembly choke points, so it holds regardless of UI;
and the answer says honestly when it left files out.

## What Changes

- **A second per-node flag** `localOnly` beside `included`, in `VaultState` in
  both engines, persisted in `state.json`. Migration-safe by the same
  serde-default tolerance that persists `included` (no schema version — see
  design). Explicit, **ancestor-wins**: marking a folder makes its whole subtree
  local-only.
- **Engine enforcement** keyed on whether the active provider is a cloud vendor.
  A single "shareable set" (the active included set minus effectively-local-only
  nodes, when a cloud provider is active) feeds retrieval, analytics table
  registration, the column catalog, doc-focus, cross-doc synthesis, table
  profiles, and meta/catalog answers. Attachments and named-file/doc-focus,
  which bypass the global include gate, are filtered at their own choke points.
  With the **local model or extractive fallback active, local-only is a no-op**
  — the files participate normally.
- **Honest exclusion note.** When a cloud answer drops files for being
  local-only, it appends a plain-language note ("N files skipped — marked
  private; switch to the private model to include them"), mirroring the existing
  named-but-excluded honesty note.
- **Explorer lock toggle**, visually distinct from the visibility eye, in rows
  and in selection/multiselect mode; and the first-run tour's explorer step
  gains a line about it.

## Capabilities

### New Capabilities
- `local-only-marks`: a per-node "this device only" flag that the engine
  enforces by excluding marked nodes from any context a cloud provider would
  receive, while leaving on-device answers unaffected.

## Impact

- **State + resolver (both engines):** `native/crates/lighthouse-core/src/vault.rs`
  (`VaultState` +`local_only` map, `is_effectively_local_only`, `set_local_only`,
  and the move/rename/remove subtree remaps) and its twin `src/server/vault.ts`.
- **Enforcement seam:** `active_included_file_ids()` gains a shareable-set
  sibling; the choke points in `synth.rs`/`synth.ts` (retrieval, attachments,
  analytics candidate gather, doc-focus, cross-doc), `analytics.rs`
  (`register_tables`), `catalog.rs` (`columns_for`), and `meta.rs`/`meta.ts`
  (`find_column`, `suggested_asks`, `list_files`) route through it. Provider
  cloud-ness is resolved where the provider already is — `chat_post`
  (`routes.rs`/`commands.rs`) and the pipeline `cfg`.
- **Op wiring:** a `localOnly` op beside `include` in `routes.rs`, `commands.rs`,
  `app/api/rag/route.ts`, the `sources` dispatchers, `RagService`
  (`src/contracts/*`), and a store action in `src/stores/useRagStore.ts`.
- **UI:** `src/features/explorer/FileExplorer.tsx` (lock toggle in rows +
  selection mode; inspector-adjacent) and the tour copy in
  `src/features/help/FirstRunTour.tsx`.
- **Tests:** cross-engine parity (identical candidate sets under a cloud
  provider) + an E2E asserting a marked file's content never reaches the
  outbound prompt.

## Non-goals

- **Not encryption or at-rest DLP.** Files already never leave the machine
  except to a provider the user chose; this governs *what a cloud model
  receives*, not how bytes are stored. A marked file is plaintext on disk as
  before.
- **Not a per-vendor allowlist.** The flag is binary — this-device-only vs
  shareable — keyed on whether *a* cloud provider is active, not on which one.
  Per-vendor policies are a managed-policy concern, not this change.
- **Does not hide files from the on-device model or extractive fallback.** Those
  are local by definition; a local-only file participates fully there. The mark
  only ever *subtracts* from the cloud path.
- **Not a replacement for inclusion.** The two axes are orthogonal: an excluded
  file is invisible to everything; a local-only-but-included file is visible to
  the private model only. Local-only has no effect on an already-excluded node.
- **No new network anything**, and **nothing retroactive** — the mark governs
  future context assembly, not data a provider already received.
