# suggested-asks — delta

## ADDED Requirements

### Requirement: Suggestions derive from real included columns
The engine SHALL derive at most 4 suggested questions from the column catalog of the most recently modified included tabular files (numeric × categorical → totals; date + numeric → monthly trend), each phrased so the existing analytics path can answer it; with no included tabular files the result SHALL be empty.

#### Scenario: Fresh spreadsheet included
- **WHEN** a file with columns `date, region, amount` is included
- **THEN** suggestions include "Total amount by region" and "Monthly trend of amount" scoped to that file

#### Scenario: No tabular files
- **WHEN** only documents are included
- **THEN** the op returns no suggestions and the chat keeps its static empty-state hint

### Requirement: One-tap asks from the empty state
The chat empty state SHALL render available suggestions as chips; tapping one submits it through the normal ask path exactly as if typed.

#### Scenario: Tapping a suggestion
- **WHEN** the user taps "Total amount by region"
- **THEN** the question is asked normally and produces a cited, engine-computed answer
