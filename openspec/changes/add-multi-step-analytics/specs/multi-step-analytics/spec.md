# multi-step-analytics — delta

## ADDED Requirements

### Requirement: Comparison questions may run up to three verified queries
When a question carries both the analytics cue and a comparison/explanation cue AND a keyed remote provider is selected, the engine SHALL let the model request up to 3 sequential SELECTs, each validated by the existing guard and executed by the engine, feeding each verified result into the next step's context; the final narration SHALL see every step's result and no raw table data.

#### Scenario: Quarter-over-quarter drivers
- **WHEN** the user asks "compare Q3 vs Q4 revenue and explain the drivers"
- **THEN** the engine executes up to three guarded queries (e.g. quarterly totals, per-region deltas) and the narration cites the computed results of each

#### Scenario: Local model selected
- **WHEN** the same question is asked on the local model
- **THEN** the single-query path runs exactly as today

#### Scenario: Simple aggregate on a remote model
- **WHEN** the user asks "total sales by region" (no comparison cue)
- **THEN** the single-query path runs — multi-step never engages

### Requirement: Every failure lands gracefully
A step whose SQL fails SHALL get one corrective retry; a second failure ends the loop. Zero successful steps SHALL fall through to the existing single-query path; one or more successes SHALL narrate from the collected results.

#### Scenario: Second step keeps failing
- **WHEN** step 2's SQL fails twice
- **THEN** the answer narrates from step 1's verified result and the footer shows the one executed query

### Requirement: Provenance covers all steps
The deterministic footer SHALL list every executed query in order ("Queries used (N)") with the standard freshness stamp over the union of files read; the answer's analytics metadata SHALL carry the last query for refinement chips.

#### Scenario: Two-step answer footer
- **WHEN** two queries executed
- **THEN** the footer shows both SQL fences numbered, one freshness line, and chips act on the second query
