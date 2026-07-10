# Tasks — add-tabular-scale

## 1. Column catalog (engine)

- [x] 1.1 New `native/crates/lighthouse-core/src/catalog.rs`: `FileColumns`/`Column{name,kind}` types, CSV/TSV header+sample reader, workbook reader via `detect_header_row`/`cell_text`, kind vote (numeric/date/text), `columns_for(files)`
- [x] 1.2 Disk cache `cache/columns.json` keyed mtime:size (corrupt cache ⇒ recompute; unreadable file ⇒ omit) + module unit tests over temp files
- [x] 1.3 Wire module in lib.rs

## 2. Union groups (analytics)

- [x] 2.1 Pure `union_stem(name) -> String` (digit-run collapse) + `union_groups(candidates, catalog)` with signature check, 48-member cap; unit tests (monthlies group, different stems split, schema drift splits)
- [x] 2.2 Group registration: CSV/TSV/Parquet via multi-path `read_*` + `register_table(view)`; workbooks via combined string matrix + single type inference
- [x] 2.3 `TableReg.group: Option<GroupMeta>`; group card ("N files unioned …"); groups consume one slot in `register_tables`; failure falls back to per-file registration
- [x] 2.4 Freshness line renders group form ("N files, newest saved X ago"); references cite first ≤3 member files; unit tests for both
- [x] 2.5 Join hints: shared non-generic columns across registered tables → bounded deterministic context block appended to SQL prompt contexts; unit test
- [x] 2.6 synth.rs candidate collection: gather up to 64 tabular candidates (pre-grouping) so families are visible, then let grouping+slots bound registration

## 3. Verification

- [x] 3.1 End-to-end test: temp dir with 12 same-shaped CSVs + a lookup CSV — union table answers a cross-family SUM and a JOIN using the hint; cargo + node tests, tsc, lint all green
