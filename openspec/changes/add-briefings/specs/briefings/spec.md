# briefings — delta

## ADDED Requirements

### Requirement: A briefing groups pinned questions into one report
A briefing SHALL be a titled, ordered selection of existing pins, persisted engine-side (cap 20). Running a briefing SHALL re-execute each referenced pin's stored SQL through the same guarded, model-free path pin rechecks use and compose the results into one report — one section per question, each carrying the current result. Every figure in a briefing SHALL originate from a verified query result, never model text.

#### Scenario: Monday briefing
- **WHEN** the analyst has pinned "revenue by region" and "open tickets by team", groups both into a briefing titled "Monday", and runs it
- **THEN** one report is produced with both questions and their current computed results, in the order chosen

#### Scenario: A removed pin doesn't sink the report
- **WHEN** a briefing references a pin that was since removed (or whose query now fails)
- **THEN** that section shows an error and the remaining sections still render their results

### Requirement: Briefings can come due on a cadence
A briefing SHALL carry a cadence of `manual`, `daily`, or `weekly`. The engine SHALL expose a pure decision — given the current time — of which briefings are due to regenerate: a scheduled briefing never run, or one whose cadence interval has elapsed since its last run. A `manual` briefing SHALL never be reported as due on its own.

#### Scenario: A daily briefing comes due
- **WHEN** a daily briefing has not run in over a day
- **THEN** it is reported as due; after it runs, it is not due again until another day elapses

#### Scenario: Manual briefings stay manual
- **WHEN** a briefing's cadence is `manual`
- **THEN** it is never reported as due; it regenerates only when the analyst runs it

### Requirement: Saving is stable and bounded
Saving a briefing under a title that already exists (case-insensitively) SHALL replace it, preserving its creation time, so editing membership or cadence does not duplicate it. A briefing SHALL require a title and at least one pin; past the cap the save SHALL fail with a human-readable reason. A missing or corrupt store SHALL read as empty rather than blocking startup.

#### Scenario: Editing a briefing
- **WHEN** the analyst re-saves the "Monday" briefing with a different set of pins
- **THEN** the single "Monday" briefing is updated in place, not duplicated

#### Scenario: Empty or over-cap saves are refused
- **WHEN** a save has no title, no pins, or would exceed the cap
- **THEN** it fails with a message explaining why, and the existing briefings are untouched

### Requirement: Parity across the two engines
The Rust engine and TS dev twin SHALL share the briefing shapes (camelCase on the wire), the store idiom, the cap, the title-stable id, and the `due` math byte-for-byte. Composition diverges by declared PARITY: the Rust engine re-runs each pin's SQL for a live report, while the twin — which has no query engine — composes from each pin's last known summary.

#### Scenario: The wire shape matches
- **WHEN** either engine serializes a briefing or a report
- **THEN** the JSON is interchangeable, so the same UI reads both
