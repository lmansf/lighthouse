# Tasks — local-only marks

## 1. Engine state + resolver (both engines)
- [x] 1.1 Add `local_only` map to `VaultState` (`vault.rs`) with `#[serde(default)]`; mirror `localOnly` in `vault.ts`.
- [x] 1.2 Add `is_effectively_local_only(id)` (ancestor-wins) beside `is_effectively_included`, both engines.
- [x] 1.3 Add `set_local_only(id, value)` (writes the target's flag only — no descendant cascade), both engines.
- [x] 1.4 Remap/capture/restore `local_only` keys in move/rename/remove alongside `included`, both engines.
- [x] 1.5 Unit-test the resolver (ancestor-wins) + migration (old state loads as unmarked) in both suites.

## 2. Enforcement seam (both engines, Rust-only where analytics/catalog live)
- [x] 2.1 Add a shareable-set form of `active_included_file_ids(is_cloud)` that subtracts effectively-local-only ids when cloud; leave the local/extractive path unchanged. Mirror in `vault.ts`. (Implemented as `shareable_file_ids(is_cloud)` + `shareable_subset` + `local_only_subset` siblings.)
- [x] 2.2 Resolve provider cloud-ness (`provider_id != "local"`) at `chat_post` and thread it onto the pipeline `cfg`, both engines. (Derived in-pipeline via `is_cloud_provider(&cfg)` from the already-threaded `cfg`; also used by the `suggestedAsks` op.)
- [x] 2.3 Route retrieval, analytics candidate gather, doc-focus, cross-doc, and meta/catalog answers through the shareable set.
- [x] 2.4 Filter attachments and named-file/doc-focus ids at their own choke points (they bypass the gate). (Plus external/SharePoint mirror items in `retrieve`.)
- [x] 2.5 Filter `analytics::register_tables` (Rust) before building schema cards; add a `PARITY:` note on the TS `analyticsSql`/`findColumn` no-op side.
- [x] 2.6 Emit the honest skip note (byte-identical template both engines) when a cloud answer drops files solely for being local-only.

## 3. Op + service + store wiring
- [x] 3.1 Add a `localOnly` op beside `include` in `routes.rs`, `commands.rs`, `app/api/rag/route.ts`, and the `sources` dispatchers.
- [x] 3.2 Add the `RagService` method (`src/contracts/*` types + real + mock) and a store action in `useRagStore.ts`.

## 4. Explorer UI + tour
- [x] 4.1 Add a lock toggle distinct from the eye, in rows and selection mode, reflecting effective local-only state (`FileExplorer.tsx`).
- [x] 4.2 Add a line about the lock to the first-run tour's explorer step (`FirstRunTour.tsx`).

## 5. Cross-engine tests
- [x] 5.1 Parity test: same fixture vault + local-only marks + cloud provider → identical retrieval candidate ids in both engines.
- [x] 5.2 E2E: mark a file, ask via a mocked cloud endpoint; assert its content never appears in the outbound prompt and the skip note renders.

## 6. Verify
- [x] 6.1 Run full verification: `cd native && cargo test -p lighthouse-core -p lighthouse-server` (the `lighthouse-desktop` crate needs webkit/gtk and can't build in the dev container — call sites grep-audited instead), `npm run test` (node --test + tsc), `next lint`. All green.
