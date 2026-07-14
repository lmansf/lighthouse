# pdf-tables — delta

## ADDED Requirements

### Requirement: PDF tables survive extraction as tables
When a PDF page carries a confident tabular layout in its text layer, the engine SHALL reconstruct that grid from positioned glyphs and surface it as GitHub-flavored markdown appended to the extracted text, so the rows flow through the standard chunker, retrieval, and citations. Reconstruction is on device and deterministic; no page content SHALL leave the machine.

#### Scenario: A revenue table answers a question with its rows intact
- **WHEN** the vault contains `q3-board-deck.pdf` whose page 4 lays out a "Revenue by region" table (columns Region, Q2, Q3)
- **THEN** asking "what was SE's Q3 revenue?" retrieves `q3-board-deck.pdf` and the answer reflects the SE row's Q3 cell, not a neighbouring number

#### Scenario: Prose PDFs are unaffected
- **WHEN** a PDF has no tabular layout (paragraphs only)
- **THEN** no table is emitted and the extracted text is byte-identical to the linear text layer

### Requirement: Reconstruction is confidence-gated and fails closed
A region SHALL be emitted as a table only when it has at least 2 rows and 2 columns and its column gutters hold consistently across the rows. Ragged, single-column, or gutter-ambiguous regions SHALL NOT be emitted as tables; the linear text stands instead. The engine SHALL never emit a grid whose geometry it could not confidently determine.

#### Scenario: A borderless list is not forced into columns
- **WHEN** a page is a bulleted list with uneven indentation and no consistent gutters
- **THEN** no table is reconstructed and the content remains as linear text

#### Scenario: A ragged half-table is rejected
- **WHEN** a candidate region's rows disagree on where columns start
- **THEN** the region is discarded rather than emitted with mis-aligned cells

### Requirement: The reconstructed grid preserves a header when one is present
When a reconstructed grid's first row reads as column names (all non-empty, none numeric), the engine SHALL mark it as header-like so the markdown renders the first row as the table header. When the first row is data (e.g. all-numeric), the grid SHALL still render but is not asserted to have named columns. (The `header_like` signal is what a future queryable path — see below — would gate on before trusting a grid as a SQL schema.)

#### Scenario: A headed revenue grid
- **WHEN** page 1's grid begins with a `Region | Q2 | Q3` row
- **THEN** the markdown uses that row as the header and the data rows follow

#### Scenario: A headerless numeric grid
- **WHEN** the first row is itself data (all numeric)
- **THEN** the grid still renders as markdown but is not treated as having named columns

### Requirement: The table pass is bounded and cache-versioned
Table reconstruction SHALL be bounded by a per-document page budget so a huge PDF cannot stall the scan, and the extraction cache version SHALL bump so existing PDFs re-extract once and gain their tables without manual rescan.

#### Scenario: A 500-page PDF
- **WHEN** it enters the vault
- **THEN** only the page budget is scanned for tables, extraction completes, and other files keep extracting in parallel

#### Scenario: Previously-cached PDFs self-heal
- **WHEN** a PDF was extracted (linear text only) by an earlier version
- **THEN** the cache-version bump re-extracts it once and it gains any reconstructable tables with no user action
