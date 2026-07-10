# answer-artifacts — delta

## ADDED Requirements

### Requirement: Analytics results save into the vault as CSV
Given an analytics answer's SQL and file ids, the engine SHALL re-execute the guarded query with a 100,000-row save cap and write an RFC-4180 CSV under `Lighthouse Results/` in the vault, sanitizing the name and suffixing on collision, never overwriting; the saved file SHALL enter the vault like any user-added file (watched, inclusion-ruled, queryable).

#### Scenario: Save then query the result
- **WHEN** the user saves "totals by region" as CSV and later asks a question over it
- **THEN** the file exists under Lighthouse Results/, appears in the explorer, and answers like any included tabular file

#### Scenario: Name collision
- **WHEN** a result is saved twice with the same name
- **THEN** the second write lands as "<name> (2).csv" and the first file is untouched

### Requirement: Charts export as theme-correct PNG
Rendered charts SHALL export client-side to a PNG that paints the current theme's background (no transparent-on-dark) at 2× resolution.

#### Scenario: Dark-mode export
- **WHEN** the user exports a chart while in dark mode
- **THEN** the PNG shows the chart on the dark background exactly as rendered

### Requirement: Conversations export as vault notes
The chat SHALL export its transcript (questions, answers, references, analytics footers) as markdown; the engine SHALL write it under `Lighthouse Notes/` with the same sanitization/collision rules and the UI SHALL offer to reveal it.

#### Scenario: Saving an investigation
- **WHEN** the user picks "Export chat to vault"
- **THEN** a markdown note with the full visible transcript lands in Lighthouse Notes/ and can be revealed

### Requirement: Artifact failures never damage the answer
Any save/export failure SHALL return a user-readable error surfaced as a toast; the chat content SHALL remain untouched and nothing partial SHALL be left behind under a final name.

#### Scenario: Read-only vault
- **WHEN** the vault directory is not writable
- **THEN** the user sees a clear error toast and no file appears
