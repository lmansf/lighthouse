# file-inspector — delta

## ADDED Requirements

### Requirement: A read-only inspector reports what the engine holds for a file
The engine SHALL provide a read-only `inspect(fileId)` operation returning the
file's extracted-text preview, chunk count and chunking mode, detected columns
and kinds (for tabular files), index freshness, and effective inclusion +
local-only state. The operation SHALL perform no mutation of vault state.

#### Scenario: Inspecting a spreadsheet
- **WHEN** the user opens the inspector for a tabular file
- **THEN** it shows the detected columns with their kinds, the chunk count and mode, an extract preview, index freshness, and the file's inclusion + local-only state — and nothing about the file changes

#### Scenario: Inspecting is side-effect free
- **WHEN** the inspector op runs for any file
- **THEN** no inclusion, local-only, index, or extraction state is modified as a result

### Requirement: OCR-derived text is flagged as such
When a file's extracted text was produced by OCR (an image format, or a scanned
PDF taking the OCR fallback), the inspector SHALL flag the preview as
OCR-derived so the user knows it may be imperfect.

#### Scenario: A scanned document is marked
- **WHEN** the inspector shows the preview for a scanned/image file whose text came from OCR
- **THEN** the preview is labeled as OCR-derived

### Requirement: A file-scoped test-search shows what would be retrieved
The inspector SHALL provide a bounded test-search over **only the inspected
file**, returning the top matching chunks with their retrieval scores, using the
existing retrieval scorer.

#### Scenario: Watching retrieval for one file
- **WHEN** the user types a query into the inspector's test-search
- **THEN** it lists that file's top chunks for the query with their scores, and searches no other file

### Requirement: The twin renders the same panel minus fields it cannot compute
The TS twin SHALL render the same inspector panel but SHALL omit the fields that
are Rust-engine-only — the OCR-source flag, a persisted chunk count, the column
catalog, and a persisted last-indexed time — presenting them as unavailable
("desktop only") rather than fabricating a value.

#### Scenario: Honest omission on the web twin
- **WHEN** the inspector renders under the TS twin for a file
- **THEN** the Rust-only fields are shown as unavailable, not as fake values, while the shared fields (name, inclusion, local-only, extract preview, chunk mode, test-search) render normally

### Requirement: The explorer opens the inspector from a file's row
The file explorer SHALL offer a "What the AI sees" entry in a file row's context
menu that opens the inspector panel for that file.

#### Scenario: Opening from the explorer
- **WHEN** the user picks "What the AI sees" on a file row
- **THEN** the inspector panel opens for that file
