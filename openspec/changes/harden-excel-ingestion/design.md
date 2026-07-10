# Design — harden-excel-ingestion

## Context

Workbook ingestion happens twice in lighthouse-core: `extract.rs` flattens sheets to CSV-ish text for retrieval (through `cell_text`), and `analytics.rs::register_workbook` builds Arrow MemTables for SQL (through the same `cell_text`). calamine yields `Data::DateTime(ExcelDateTime)` whose Display prints the raw serial float. Header assumption is hardcoded: `rows.next()` = header.

## Goals / Non-Goals

**Goals:**
- Dates queryable with the existing `substr(date,1,7)` idiom the SQL few-shots teach.
- Title/blank rows above real headers never become column names.
- Zero new dependencies; pure helpers testable without xlsx fixtures.

**Non-Goals:**
- Typed Arrow Date columns (ISO Utf8 strings are the established idiom; DataFusion date functions on typed columns are a later change).
- Multi-row (merged) headers; per-sheet header overrides in the UI.
- 1904-date-system workbooks (rare; calamine normalizes serials to the 1900 system it reports).

## Decisions

1. **Convert serials in `cell_text`, not per-consumer.** One conversion point fixes retrieval text and analytics tables together. `excel_serial_to_iso(serial: f64) -> String`: epoch 1899-12-30 (absorbs Excel's phantom 1900-02-29 for all dates ≥ 1900-03-01, which is the realistic range), day fraction → seconds rounded to nearest; whole-day serials render date-only so GROUP BY month stays clean. Alternative considered: calamine's `as_datetime()` (needs the `dates` feature + chrono glue); manual math is 15 lines, dependency-free, and unit-testable to the second.
2. **Header detection is a pure scorer over stringified rows.** `detect_header_row(rows: &[Vec<String>]) -> usize` scans the first 8 rows; score = count of non-empty, distinct, non-numeric cells; require ≥2 scoring cells and strictly more than any earlier candidate row to move the header down (ties → earliest). Rows above the winner are dropped. Rationale: title rows have 1 non-empty cell; units rows are numeric-ish; real headers are wide, textual, distinct.
3. **Cache version 3 → 4 in both engines.** Extraction output changes for workbooks, and the cache is shared between engines, keyed by version — the established one-time re-extraction pattern (failures still never cached).

**Parity:** Rust-only behavior change. The TS twin extracts workbooks via SheetJS `sheet_to_csv`, which already emits formatted date text; analytics is Rust-only by design. TS gets the `CACHE_VERSION` bump plus a PARITY comment noting the divergence is deliberate.

## Risks / Trade-offs

- [Mis-detected header on exotic sheets] → scorer is conservative (needs ≥2 textual distinct cells AND a strict improvement); worst case equals today's behavior (row 0). Unit tests pin title-row, blank-row, and no-header shapes.
- [Serial edge cases pre-1900 / times only] → times-only serials (<1.0) render `1899-12-30 HH:MM:SS`; acceptable — they were unreadable serials before.
- [One-time re-extraction spike after update] → same pattern as v3 bump shipped in 0.6.5; warm pass amortizes it.
