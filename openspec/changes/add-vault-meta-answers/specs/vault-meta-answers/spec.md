# vault-meta-answers — delta

## ADDED Requirements

### Requirement: Recency questions answer instantly from metadata
Questions matching the anchored "what's new / what changed [since …]" cues SHALL answer deterministically with the most recently modified included files (≤15) and their saved-age labels, with references to those files, without any model call.

#### Scenario: What's new this week
- **WHEN** the user asks "what's new this week?"
- **THEN** the answer lists included files modified in the last 7 days, newest first, each with an age label, and cites them

#### Scenario: Document-scoped question stays on the full pipeline
- **WHEN** the user asks "what's new in the Q3 report?"
- **THEN** the meta stage does not fire and retrieval answers from the document

### Requirement: Inventory questions answer from the walk
Questions matching the anchored "what/which files|spreadsheets|documents do I have / list my …" cues SHALL answer with counts by kind and notable file names from walk metadata, with references.

#### Scenario: Spreadsheet inventory
- **WHEN** the user asks "what spreadsheets do I have?"
- **THEN** the answer states the spreadsheet count and names up to 10, cited

### Requirement: Column questions answer from the catalog (desktop)
On the desktop engine, questions matching the "which files have a column …" cue SHALL answer from the column catalog, naming each file that has the column and the column's kind; the TS twin SHALL fall through to the normal pipeline (PARITY).

#### Scenario: Locating a join key
- **WHEN** the user asks "which files have an employee id column?"
- **THEN** the answer lists the matching files with the column's kind, cited

### Requirement: Meta stage is conservative and safe
The meta stage SHALL run before the analytics branch, fire only on anchored cues, and on ANY rendering error fall through to the normal pipeline without emitting partial output.

#### Scenario: Renderer failure
- **WHEN** the walk fails mid-render
- **THEN** the user gets a normal pipeline answer, not an error or half an answer
