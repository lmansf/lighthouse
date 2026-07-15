# pdf-tables — delta

## MODIFIED Requirements

### Requirement: The reconstructed grid preserves a header when one is present
When a reconstructed grid's first row reads as column names (all non-empty, none numeric), the engine SHALL mark it as header-like so the markdown renders the first row as the table header. When the first row is data (e.g. all-numeric), the grid SHALL still render but is not asserted to have named columns. A header-like grid that is also confident enough to aggregate over — at least 2 columns and at least 3 data rows — SHALL additionally be eligible for registration as a SQL-queryable analytics table (see the new requirement below); a grid below that stricter bar remains readable in the markdown but is NOT registered.

#### Scenario: A headed revenue grid
- **WHEN** page 1's grid begins with a `Region | Q2 | Q3` row
- **THEN** the markdown uses that row as the header and the data rows follow

#### Scenario: A headerless numeric grid
- **WHEN** the first row is itself data (all numeric)
- **THEN** the grid still renders as markdown but is not treated as having named columns, and is not registered as a queryable table

#### Scenario: A confident headed grid is eligible to query
- **WHEN** a reconstructed grid is header-like with at least 2 columns and at least 3 data rows
- **THEN** it is both rendered as markdown AND eligible for registration as a queryable analytics table

#### Scenario: A thin headed grid stays readable only
- **WHEN** a reconstructed grid is header-like but has only 2 data rows
- **THEN** it still renders as markdown but is NOT registered as a queryable table

## ADDED Requirements

### Requirement: A confident PDF grid is queryable under the analytics trust invariant
When a PDF in analytics scope contains a reconstructed grid that is header-like with at least 2 columns and at least 3 data rows, the analytics engine SHALL register that grid as a typed Arrow table using the same header-sanitize and numeric-typing path a spreadsheet sheet uses, so the model can query it under the unchanged trust invariant: it reads only the schema, writes one read-only SQL SELECT, DataFusion executes the query, and the model narrates the engine-computed result with the SQL shown verbatim. The model SHALL NOT perform arithmetic itself; every number in the answer SHALL trace to DataFusion output over the registered cells.

#### Scenario: A PDF revenue grid answers an aggregate with an engine-computed number
- **WHEN** a PDF's page carries a header-like `region | q2 | q3` grid with three or more data rows, and the user asks for total Q3 revenue
- **THEN** the engine registers the grid as a table whose numeric columns type as Float64, DataFusion computes `SUM(q3)`, and the answer states that engine-computed total with the SQL shown verbatim

#### Scenario: A numeric column types as a number, not text
- **WHEN** a registered PDF grid has a column whose cells are all numeric
- **THEN** that column types as Float64 (nulls allowed) so aggregates are real arithmetic, identical to the spreadsheet typing path

#### Scenario: A PDF with several confident grids registers each independently
- **WHEN** one PDF carries more than one confident, queryable grid
- **THEN** each grid registers under its own distinct table name and can be queried on its own

### Requirement: PDF queryability rides a registration-only gate and does not touch tabular cataloging
The engine SHALL gate PDF table registration on a PDF-specific predicate that is independent of the `is_tabular` predicate. Enabling PDF queryability SHALL NOT route PDFs into tabular chunking, the column catalog, cross-file union grouping, or spreadsheet-oriented meta answers ("which spreadsheets do I have"). A PDF SHALL remain on prose chunking. The engine SHALL NOT introduce a new extraction cache version for this capability; registration re-parses the PDF at analytics time and the extraction/markdown path is unchanged.

#### Scenario: A queryable PDF is still not a spreadsheet
- **WHEN** a PDF has been registered as a queryable analytics table and the user asks "which spreadsheets do I have"
- **THEN** the PDF is not listed among spreadsheets, and it is not union-grouped with same-shaped CSV/XLSX tables

#### Scenario: Coverage disclosure stays spreadsheet-scoped
- **WHEN** the per-ask table cap drops some in-scope spreadsheets and a PDF is also in scope
- **THEN** the "Analyzed N of M in-scope tabular files" disclosure counts only spreadsheet (tabular) files in N and M, and the PDF neither inflates nor deflates that count

#### Scenario: No re-extraction is triggered
- **WHEN** this capability ships
- **THEN** the extraction cache version is unchanged and no previously-extracted PDF re-extracts to gain queryability

### Requirement: PDF registration is bounded and fails closed
Registering a PDF's grids SHALL be bounded and SHALL never stall an ask. A PDF larger than a byte budget SHALL register no table. The glyph pass SHALL run off the async runtime and be panic-guarded, and a PDF with no confident, queryable grid SHALL register nothing and consume no table slot. A grid too thin to type SHALL register nothing.

#### Scenario: An oversized PDF registers nothing
- **WHEN** a PDF exceeds the registration byte budget
- **THEN** no table is registered for it and the ask proceeds over the remaining files

#### Scenario: A prose PDF costs a bounded parse and no slot
- **WHEN** a PDF has no reconstructable grid
- **THEN** the bounded text-layer pass reconstructs nothing, no table is registered, and no table slot is consumed
