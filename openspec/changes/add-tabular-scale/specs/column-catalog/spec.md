# column-catalog — delta

## ADDED Requirements

### Requirement: Cheap cached column inventory
The engine SHALL provide, for any set of tabular vault files, each file's sanitized column names with rough kinds (numeric / date / text), reading only headers plus a bounded row sample, cached on disk keyed by the file's mtime+size.

#### Scenario: Cache hit after no change
- **WHEN** a file's columns were cataloged and the file has not changed
- **THEN** a later catalog call answers from cache without re-reading the file's data rows

#### Scenario: File edited
- **WHEN** a cataloged file's mtime or size changes
- **THEN** the next catalog call re-reads that file and refreshes its entry

### Requirement: Catalog failures never block answers
An unreadable or malformed file SHALL be omitted from the catalog result; catalog errors SHALL never abort an ask or a registration.

#### Scenario: One corrupt workbook among many
- **WHEN** one of five files fails to parse during cataloging
- **THEN** the other four are returned and downstream features proceed without the fifth
