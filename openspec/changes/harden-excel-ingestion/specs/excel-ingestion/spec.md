# excel-ingestion — delta

## ADDED Requirements

### Requirement: Excel datetime cells render as ISO 8601
The engine SHALL render workbook datetime cells as ISO 8601 text — `YYYY-MM-DD` for whole-day values, `YYYY-MM-DD HH:MM:SS` otherwise — in both extracted retrieval text and analytics table values.

#### Scenario: Date-only cell
- **WHEN** a cell holds the Excel serial for 2025-03-07 with no time fraction
- **THEN** its text is `2025-03-07` and `substr(col, 1, 7)` yields `2025-03`

#### Scenario: Date-time cell
- **WHEN** a cell holds a serial with a time fraction (e.g. 2025-03-07 14:30:00)
- **THEN** its text is `2025-03-07 14:30:00`

### Requirement: Header row is detected, not assumed
`register_workbook` SHALL choose the header row by scoring the first 8 rows (non-empty, distinct, non-numeric cells; minimum 2 scoring cells; strict improvement required to pass over an earlier row) and SHALL drop rows above the chosen header. When no row qualifies, the engine SHALL fall back to row 0 (current behavior).

#### Scenario: Title row above the header
- **WHEN** row 0 is a single-cell title ("Q3 Ticket Report") and row 2 holds `date, region, amount`
- **THEN** the table's columns are `date, region, amount` and data starts at row 3

#### Scenario: No plausible header
- **WHEN** every early row is numeric data with no textual header row
- **THEN** row 0 is used as the header exactly as before this change

### Requirement: Shared extraction cache invalidates once
Because extraction output changes for workbooks, `CACHE_VERSION` SHALL be bumped to 4 in BOTH engines so stale cached text re-extracts exactly once; extraction failures SHALL remain uncached.

#### Scenario: Previously cached workbook
- **WHEN** a workbook was extracted under cache version 3 and is read after the update
- **THEN** it re-extracts once with ISO dates and the result is cached under version 4
