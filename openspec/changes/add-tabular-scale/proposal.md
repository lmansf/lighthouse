# Tabular scale: column catalog, unioned file families, join hints

## Why

Analysts keep periodic exports — `sales-2025-01.csv` … `sales-2025-12.csv` — but analytics registers at most 4 files / 6 tables per ask, so "sum across all the 2025 monthlies" is impossible today. And although multi-table JOINs already work in one SessionContext, the SQL model is never told which columns line up, so cross-file questions usually fail.

## What Changes

- A **column catalog**: per included tabular file, its sanitized header columns (with rough kinds: numeric / date / text) read cheaply and cached by mtime+size in the state dir. Shared infrastructure — also consumed by `add-vault-meta-answers` (suggested asks, column questions).
- **Union groups**: candidate files with the same extension, identical column signature, and a shared name stem (differing only by digit/date tokens) register as ONE table (`<stem>_all`), bypassing the per-file cap; CSV/TSV/Parquet union natively via DataFusion multi-path reads, workbooks by concatenating row batches. A group counts as one table slot.
- **Join hints**: after registration, shared column names across distinct tables produce one deterministic "Join hints" context block for the SQL prompt (e.g. `tickets.region = regions.region`).
- Freshness stamp and references understand groups ("12 files, newest saved 2 h ago"; references list the first members).

## Capabilities

### New Capabilities
- `column-catalog`: cheap, cached, per-file column inventory for tabular files.
- `union-tables`: registering a family of same-shaped files as one queryable table, with group-aware provenance.

### Modified Capabilities
<!-- none — excel-ingestion delta in the sibling change is additive -->

## Impact

- New `native/crates/lighthouse-core/src/catalog.rs`; `analytics.rs` (grouping, registration, cards, join hints, freshness), `synth.rs` (candidate collection feeds groups), `lib.rs` module wiring.
- No TS-twin engine change (analytics is Rust-only); no UI change; no new dependencies (DataFusion + calamine already present).
