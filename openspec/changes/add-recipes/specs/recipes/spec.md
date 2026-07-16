# recipes — delta

## ADDED Requirements

### Requirement: Recipes plan deterministically and run on every provider
A recipe SHALL be a named, parameterized bundle of guarded SELECT templates
whose plan is a pure function of the resolved parameters — NO model is
consulted to plan it. Executing a recipe SHALL run each template through the
same guarded, model-free path a single query uses, listing every executed
query in the provenance footer. A recipe SHALL produce results on cloud,
local, and extractive providers alike; narration SHALL be skippable, so the
extractive provider renders result tables + footers with no prose.

#### Scenario: A recipe runs model-free on the extractive path
- **WHEN** a recipe is invoked while no model is configured (the extractive fallback)
- **THEN** its templates execute, the answer shows the result tables with the provenance footer listing every query, and no model was called to plan or narrate

#### Scenario: The same catalog yields the same plan
- **WHEN** a recipe is planned twice against an unchanged catalog and parameters
- **THEN** it expands to the identical set of SQL templates both times

### Requirement: Recipe numbers are engine-computed, never model-authored
Every value in a recipe result SHALL come from executing a guarded SELECT
against the vault's own bytes. The model SHALL contribute only optional
narration over already-computed results, never a number.

#### Scenario: Narration never supplies a figure
- **WHEN** a recipe runs on a cloud provider and the model narrates the result
- **THEN** every figure in the answer traces to a query result, and removing the narration changes no number

### Requirement: The five built-in recipes exist with golden fixtures
The engine SHALL ship variance-vs-last-period, cohort breakdown,
data-quality audit, anomaly scan, and top-movers as built-ins, each with a
golden fixture in the model-free eval floor proving its expected output.

#### Scenario: A built-in's golden holds
- **WHEN** the data-quality audit runs against a fixture with a known null count and a duplicate
- **THEN** its result reports that exact null count and flags the duplicate, matching the golden

### Requirement: Recipes are applicability-filtered against the catalog
A recipe SHALL be offered only when the catalog (included tabular files and
saved views) satisfies its applicability predicate. Saved views count as
tables; a view that is effectively local-only SHALL NOT surface a recipe on
a cloud ask.

#### Scenario: A recipe is offered only where it can run
- **WHEN** the included set has a numeric column but no date column
- **THEN** variance-vs-last-period (which needs a date) is not offered, while a recipe needing only a numeric column is

### Requirement: Every Beam answer carries an engine-derived assumption ledger
Every analytics answer SHALL include an "Assumptions" disclosure built
ENTIRELY from engine-derived facts — the date column used, period
boundaries, rows considered (caps stated honestly), null handling implied by
the aggregates, filters applied, group-by columns, and any recipe
parameters — derived by inspecting the executed SQL (or the recipe's
resolved parameters). The model SHALL NOT add, remove, or reword any ledger
entry.

#### Scenario: The ledger reads the executed SQL
- **WHEN** an answer runs `SELECT region, SUM(amount) FROM sales WHERE region <> 'n/a' GROUP BY region`
- **THEN** its ledger states the group-by column (region), the filter applied (region <> 'n/a'), and that the SUM skips null cells — all without any model text

#### Scenario: The ledger is deterministic
- **WHEN** the same SQL is answered twice
- **THEN** the ledger entries are byte-identical both times

#### Scenario: A non-analytics answer has no ledger
- **WHEN** a prose answer runs with no SQL executed
- **THEN** no assumptions disclosure is emitted

### Requirement: Recipes surface in the Library, chips, pins, and packs
Applicable recipes SHALL appear in a Library gallery and as one-tap chips in
the chat empty state when the tabular context matches; a recipe result SHALL
pin and board like any answer; and an evidence pack of a recipe answer SHALL
include the full plan (every executed query).

#### Scenario: A recipe result exports its whole plan
- **WHEN** the user exports an evidence pack of a recipe answer that ran four queries
- **THEN** the pack lists all four queries and the result, and renders offline
