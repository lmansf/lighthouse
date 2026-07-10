# analytics-refinement — delta

## ADDED Requirements

### Requirement: Refining follow-ups adapt the previous query
When the conversation's last analytics answer embedded a "Query used" fence, the SQL-writing prompt SHALL include that query (capped at 800 characters) with an instruction to adapt it for refining questions; absence of a prior fence SHALL leave the prompt unchanged.

#### Scenario: Narrowing a result
- **WHEN** the previous answer computed totals by region and the user asks "same thing but only 2025"
- **THEN** the SQL prompt contains the previous SELECT and the new query preserves its shape with an added filter

#### Scenario: Fresh question after an analytics answer
- **WHEN** the user asks an unrelated aggregate question
- **THEN** the prior query is present only as optional context and a fresh SELECT is written

### Requirement: Analytics answers carry structured metadata
The final chunk of an analytics answer SHALL include `analytics: { sql, fileIds }` — the exact executed SQL and the vault file ids it read; non-analytics answers SHALL omit the field entirely.

#### Scenario: Chips have what they need
- **WHEN** an analytics answer completes
- **THEN** the client receives the SQL and file ids without parsing markdown

### Requirement: Guarded direct re-execution op
`/api/rag` SHALL accept `op: "analyticsSql"` with `{ sql, fileIds }`, register exactly those files, enforce the existing single-SELECT guard, and return the result table, chart spec when chartable, and the standard provenance footer — with no model involvement and no persistence.

#### Scenario: User edits the WHERE clause
- **WHEN** the user edits the answer's SQL in the dialog and runs it
- **THEN** the result renders within the dialog with Query-used + Computed-from provenance

#### Scenario: Write statement rejected
- **WHEN** the edited SQL is `DROP TABLE sales`
- **THEN** the op returns the guard's error and nothing executes

### Requirement: Quick-action chips on analytics answers
The chat UI SHALL render refinement chips (Top 10 · Monthly · As % · Edit SQL) under answers that carry analytics metadata and nowhere else; the first three send fixed refinement follow-ups through the normal ask path.

#### Scenario: Non-analytics answer
- **WHEN** an answer has no analytics metadata
- **THEN** no chips render
