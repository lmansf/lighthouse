# Harden Excel ingestion: real headers, real dates

## Why

Real-world workbooks have title/blank rows above the header and store dates as Excel serial numbers. Today `register_workbook` (native/crates/lighthouse-core/src/analytics.rs) assumes row 0 is the header, and `cell_text` (extract.rs) renders `Data::DateTime` via its Display impl — a raw serial like `45123.5`. Every "monthly trend" ask relies on `substr(date, 1, 7)` over ISO strings, so dated workbooks silently produce wrong-but-plausible answers — the worst failure class for an analyst.

## What Changes

- `cell_text` renders Excel datetime cells as ISO 8601 (`YYYY-MM-DD`, or `YYYY-MM-DD HH:MM:SS` when a time-of-day is present) — fixing both extracted retrieval text and analytics tables in one place.
- `register_workbook` detects the true header row within the first 8 rows (title/blank rows above are skipped) via a pure, unit-tested scorer; no plausible header ⇒ row 0 exactly as today.
- Shared extraction cache version bumps (3 → 4) in BOTH engines so previously-extracted workbooks re-extract once with ISO dates.

## Capabilities

### New Capabilities
- `excel-ingestion`: how workbook cells, headers, and dates become analytics tables and retrieval text.

### Modified Capabilities
<!-- none — no existing specs in openspec/specs/ yet -->

## Impact

- `native/crates/lighthouse-core/src/extract.rs` (`cell_text`, `CACHE_VERSION`), `analytics.rs` (`register_workbook` + new `detect_header_row`), `tests/extract_test.rs` pinned cache version.
- `src/server/extract.ts` (`CACHE_VERSION` only — see design for the PARITY call).
- No API, UI, or dependency changes. One-time re-extraction cost for workbook files after update (established, self-healing pattern).
