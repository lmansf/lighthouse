# deep-analysis — delta

## ADDED Requirements

### Requirement: Investigating a table assembles a structured, engine-verified report

The engine SHALL provide `investigate(table, included_ids, is_cloud)` that runs
every applicable deterministic recipe over the target table's typed columns
(`recipes::BUILTINS` `.applicable`), executes each recipe's representative query
through the model-free `analytics::run_query`, and assembles the verified results
into a titled `Report` — a summary of the top findings, one section per analysis
carrying its evidence table and the exact SQL, and a caveats block. The report
SHALL be deterministic and reproducible from its SQL; every number in it SHALL
come from a `run_query` result, never from a model.

#### Scenario: A dated numeric table yields a multi-section report

- **WHEN** `investigate` runs over a table with a date column and a numeric metric
- **THEN** the report contains a section for each applicable recipe that produced rows (e.g. variance, anomaly, top-movers, forecast, changepoint), each section carrying the recipe's engine-computed result table and the exact query that produced it, and the summary names the most notable findings using those engine figures

#### Scenario: Every figure in the report is engine-computed

- **WHEN** a report is assembled
- **THEN** every number appearing in the summary and the sections is present in one of the sections' `run_query` results (reproducible from the section's SQL), and no figure is introduced by any model narration

#### Scenario: The report is deterministic across runs

- **WHEN** `investigate` runs twice over the same unchanged table with a fixed generated timestamp
- **THEN** the rendered report is byte-identical both times (the core is model-free SQL assembled by a pure renderer)

### Requirement: The report degrades to a truthful short report, never an error

When the target table has no analyzable shape (no dated numeric series) or a
recipe returns no rows, `investigate` SHALL degrade: an unanalyzable table yields
a report with no sections and an honest summary, and a recipe that errors or
returns nothing is skipped while the rest of the battery still runs. It SHALL NOT
error and SHALL NOT fabricate a section.

#### Scenario: An unanalyzable table returns an honest empty report

- **WHEN** `investigate` runs over a table with no date-plus-numeric shape
- **THEN** the report renders with an empty sections list and a summary stating there is nothing to analyze, rather than erroring or inventing an analysis

#### Scenario: A recipe with no result is skipped, not fatal

- **WHEN** one applicable recipe returns no rows (e.g. no period breaches the anomaly fence) while others produce results
- **THEN** that recipe contributes no section, the remaining sections are assembled normally, and the report is produced

### Requirement: The report is written in-vault as a non-egress artifact

The report SHALL be rendered to markdown (reusing the briefing render idiom) and
written into the vault through the write-artifact allowlist (`notes_subdir` /
a reports subdir + `vault::write_artifact`) — a sanitized, traversal-safe,
never-overwrite in-vault write — and the op SHALL return the saved artifact's id
and name. The write SHALL NOT egress and SHALL NOT write outside the vault.

#### Scenario: Investigating writes a vault note and returns its id

- **WHEN** the `investigate` op completes for a table
- **THEN** the rendered report is written as a markdown note under the vault's write-artifact allowlist, no network egress occurs, and the op returns the saved id and name so the app can open it

### Requirement: Deep analysis is Rust-only with an honest TS degradation

The `investigate` engine SHALL be Rust-only (DataFusion + recipe execution),
consistent with the analytics branch. The TypeScript twin's `investigate` op
SHALL return `{available:false}` rather than a fabricated report, and
`docs/ts-twin.md` SHALL record deep analysis among the Rust-only capabilities.

#### Scenario: The TS twin reports deep analysis unavailable

- **WHEN** the `investigate` op is invoked against the TypeScript engine
- **THEN** it returns `{available:false}` (no analytics branch to run), honestly degrading rather than returning a fake report
