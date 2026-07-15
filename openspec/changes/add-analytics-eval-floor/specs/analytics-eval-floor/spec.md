# analytics-eval-floor — delta

## ADDED Requirements

### Requirement: A capped result is stated honestly, never as complete

When a query's result exceeds the execution row cap, the engine SHALL compute
the query's true total row count once (via a `COUNT` over the same guarded
query) and surface it both in the model's narration context and in a
deterministic, engine-authored footer ("Showing the first N of TOTAL rows"). The
narration note SHALL be phrased neutrally so the same markdown reads correctly
when a model-free re-execution renders it verbatim to a human. When the count
cannot be computed the engine SHALL say the result is larger, never a fabricated
total, and never that the cap is the total.

#### Scenario: A 12,431-row result
- **WHEN** a query matches 12,431 rows and the engine caps the result at 200
- **THEN** the answer and a deterministic footer state "first 200 of 12,431 rows", the narration context carries the true total, and the result does not chart

#### Scenario: The count query fails
- **WHEN** the truncation `COUNT` errors or times out
- **THEN** the footer says the result is larger than the cap without inventing a number, and the answer still lands

#### Scenario: A result within the cap
- **WHEN** a query returns 100 rows (≤ the cap)
- **THEN** no truncation footer is emitted and the true total equals the shown count, byte-identical to before this change

### Requirement: Columns dropped by the width cap are disclosed

When a result carries more columns than the render cap, the engine SHALL note
how many of how many columns are shown, in neutral wording, parallel to the row
disclosure.

#### Scenario: A 30-column result
- **WHEN** a query returns 30 columns and the cap renders 24
- **THEN** the result notes "showing 24 of 30 columns"

### Requirement: The read-only guard rejects disguised writes

The SQL guard SHALL reject any statement that is not a purely read-only query,
inspecting the query body and every CTE recursively — including `SELECT … INTO`
(which the engine would otherwise execute as a table-creating DDL, dodging the
timeout and row cap) and any data-modifying set-expression (INSERT/UPDATE/…)
appearing as a body or CTE — while continuing to accept plain SELECT, WITH…
SELECT, set operations, VALUES, and read-only subqueries.

#### Scenario: SELECT … INTO
- **WHEN** the model emits `SELECT * INTO exfil FROM sales`
- **THEN** the guard rejects it before execution

#### Scenario: Data-modifying CTE
- **WHEN** the model emits `WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t`
- **THEN** the guard rejects it before execution

#### Scenario: An ordinary read
- **WHEN** the model emits `WITH m AS (SELECT month, SUM(amount) AS s FROM t GROUP BY month) SELECT * FROM m`
- **THEN** the guard accepts it

### Requirement: Verified statistics survive the wrong-but-plausible classes

The engine SHALL compute correct aggregates across the data shapes the audit
identified: a non-finite sentinel (NaN/inf) in a numeric column becomes NULL
(never a poisoned aggregate); an Excel date serial under a date-ish header is
read as a date, while a numeric measure in the same value range stays numeric; a
same-named column that differs in type, or a single-letter file stem, splits a
union family rather than merging incoherent data; a data row never displaces an
all-textual header; and a generated table name never overwrites a registered
one.

#### Scenario: NaN sentinel in a ratio column
- **WHEN** a numeric column contains a `NaN` cell
- **THEN** that cell is NULL and `SUM`/`AVG` skip it (the profile and the SQL path agree)

#### Scenario: Excel serial dates vs a measure in range
- **WHEN** an `order_date` column holds whole serials in the date range and an `amount` column holds numbers in the same range
- **THEN** `order_date` renders as ISO dates and `amount` stays numeric

#### Scenario: Unrelated same-shaped files
- **WHEN** `q1.csv` and `q2.csv` share a column signature but their stem collapses to a single letter, or a shared column differs in kind
- **THEN** they register as separate tables, not one unioned table

### Requirement: A partial analysis discloses its coverage

When the per-ask table caps leave in-scope tabular files unanalyzed, the engine
SHALL keep the newest files and disclose how many of how many were analyzed, so
an answer from a fraction of the vault's tables never reads as the whole.

#### Scenario: More tabular files than table slots
- **WHEN** 50 in-scope tabular files exceed the registration cap
- **THEN** the newest register and the answer discloses "Analyzed N of 50 in-scope tabular files"

### Requirement: A golden correctness floor guards every future change

The engine SHALL carry deterministic, model-free golden tests (fixture → exact
result) for the audited classes, runnable in CI, plus a provider-gated
natural-language scorecard (`examples/analytics_eval.rs`) that runs the full
NL→SQL→execute loop against a configured provider and, with no provider, prints
a note and exits 0 so it can never flake CI.

#### Scenario: A refactor changes a computed number
- **WHEN** a change alters a golden fixture's computed statistic or the truncation total
- **THEN** the model-free floor fails in CI

#### Scenario: No provider configured
- **WHEN** the scorecard runs without `LIGHTHOUSE_EVAL_PROVIDER`
- **THEN** it runs the model-free floor, prints that no provider is configured, and exits 0
