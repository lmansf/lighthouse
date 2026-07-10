# Tasks — harden-excel-ingestion

## 1. Engine (lighthouse-core)

- [ ] 1.1 Add `excel_serial_to_iso(f64) -> String` in extract.rs (epoch 1899-12-30, day-fraction → rounded seconds, date-only when midnight) + unit tests (whole day, time fraction, second rounding)
- [ ] 1.2 Route `Data::DateTime` through it in `cell_text`; unit-test via existing docx/extract test module patterns
- [ ] 1.3 Add `detect_header_row(rows: &[Vec<String>]) -> usize` in analytics.rs (pure scorer per design) + unit tests (title row, blank rows, no-header fallback, tie → earliest)
- [ ] 1.4 Use it in `register_workbook`: stringify first 8 rows once, pick header, skip preceding rows
- [ ] 1.5 Bump `CACHE_VERSION` to 4 in extract.rs; update pinned assertion in tests/extract_test.rs

## 2. TS twin

- [ ] 2.1 Bump `CACHE_VERSION` to 4 in src/server/extract.ts with a PARITY comment (SheetJS already formats dates; analytics is Rust-only)

## 3. Verification

- [ ] 3.1 cargo test --workspace, node --test "test/**/*.test.mjs", tsc --noEmit, next lint — all green
