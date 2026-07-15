# Tasks — queryable PDF tables

## 1. Queryable gate (pdf_tables.rs)
- [x] 1.1 `MIN_QUERYABLE_DATA_ROWS = 3` constant with a rationale comment.
- [x] 1.2 `is_queryable_grid(&Table) -> bool`: `header_like` + ≥2 cols + ≥3 data
  rows. Pure over an already-reconstructed `Table`.
- [x] 1.3 `queryable_tables(buf) -> Vec<Table>`: `extract_tables` filtered by
  `is_queryable_grid`. Panic-guarded via `extract_tables`.
- [x] 1.4 Unit tests over synthetic grids: accept a confident grid; reject too
  few data rows, a headerless grid, a single column.

## 2. PDF registration (analytics.rs)
- [x] 2.1 `is_pdf(name)` predicate + PARITY (Rust-only) and blast-radius comment.
- [x] 2.2 `MAX_PDF_BYTES` byte budget.
- [x] 2.3 `register_grid(ctx, name, &Table)`: header sanitize + `table_from_matrix`
  typing + `MemTable` register, factored for unit testing.
- [x] 2.4 `register_pdf(ctx, base, abs)`: metadata size gate → `spawn_blocking`
  glyph pass → register each grid; multi-grid `{base}__{i}` naming.
- [x] 2.5 Singles-loop dispatch: route `is_pdf` files to `register_pdf`.
- [x] 2.6 `direct_tables` candidate filter widened to `is_tabular || is_pdf`.
- [x] 2.7 Tests: `register_grid` → `run_query` (engine `SUM`, `Float64` typing);
  degenerate grids register nothing; prose bytes yield no queryable table.

## 3. Candidate scan + coverage honesty (synth.rs)
- [x] 3.1 Analytics candidate collection widened to `is_tabular || is_pdf`.
- [x] 3.2 Coverage denominator pinned to `is_tabular`-only files so a PDF never
  distorts the "in-scope tabular files" disclosure.

## 4. Gates
- [x] 4.1 `cargo build -p lighthouse-core` clean.
- [x] 4.2 `cargo test -p lighthouse-core` green (new + existing).
- [x] 4.3 `extract_test.rs` `CACHE_VERSION` assertion stays `== 9`.
- [x] 4.4 `node scripts/openspec-validate.mjs add-queryable-pdf-tables` green.
- [ ] 4.5 Live end-to-end: a PDF with a confident grid answers a `SUM`/`GROUP BY`
  ask with an engine-verified number and the SQL shown verbatim.
