# union-tables — delta

## ADDED Requirements

### Requirement: Same-shaped file families register as one table
Candidate files with the same extension, identical sanitized column signature, and a shared digit-stripped name stem SHALL register as a single unioned table named `<stem>_all`; a group SHALL consume one table slot regardless of member count (cap 48 members, newest kept).

#### Scenario: Twelve monthlies union
- **WHEN** `sales-2025-01.csv` … `sales-2025-12.csv` share identical headers and are candidates
- **THEN** one table `sales_all` containing all rows registers, and "total 2025 sales" computes across all twelve files

#### Scenario: Same shape, different stem
- **WHEN** `vendors.csv` and `customers.csv` coincidentally share headers
- **THEN** they register as two separate tables (name stem differs)

#### Scenario: Schema drift inside a family
- **WHEN** three of the monthlies renamed a column
- **THEN** the family splits by signature into separate registrations and no rows are silently dropped or misaligned

### Requirement: Group-aware provenance
For a unioned table, the freshness footer SHALL state the member count and the newest member's save age, and the answer's references SHALL cite real member files (first members when the group is large).

#### Scenario: Freshness of a group
- **WHEN** an answer computes from a 12-file group whose newest member saved 2 hours ago
- **THEN** the footer reads like `"sales-2025-*.csv" (12 files, newest saved 2 hours ago)`

### Requirement: Deterministic join hints
When distinct registered tables share non-generic column names, the engine SHALL append one deterministic "Join hints" context block (bounded, score 0) to the SQL-writing prompt; hints SHALL never force a join.

#### Scenario: Shared key across two files
- **WHEN** `tickets` and `regions` both expose a `region` column
- **THEN** the SQL prompt contains `tickets.region = regions.region` as a hint

### Requirement: Union failures degrade to per-file registration
Any failure while grouping or unioning SHALL fall back to registering that family's files individually under the existing per-file cap; the ask SHALL still answer.

#### Scenario: Multi-path read fails
- **WHEN** DataFusion rejects the unioned read for a family
- **THEN** the newest members register individually and the ask proceeds
