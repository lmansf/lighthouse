# proactive-insights — delta

## ADDED Requirements

### Requirement: The engine surfaces noteworthy findings without the user asking

The engine SHALL provide `insights::scan(tables)` that runs the cheap
deterministic detectors (the anomaly z-score, top-movers, and the changepoint
scan) over the cataloged Date + Numeric tables and returns a ranked list of
findings, each carrying the table, a kind, a headline templated from
engine-computed numbers, the finding's magnitude, and the SQL that produced it.
The findings SHALL be presentable in a proactive surface that shows what stands
out WITHOUT the user posing a question. Every number in a headline SHALL be
engine-computed; a headline SHALL NOT contain model-generated text.

#### Scenario: An anomaly in a cataloged table surfaces unprompted

- **WHEN** `insights::scan` runs over a vault whose cataloged table contains a monthly total beyond the anomaly fence
- **THEN** the returned list includes a finding naming that table and period with the engine-computed z-score in its headline, and the proactive surface can present it without the user having asked a question

#### Scenario: A quiet vault honestly reports nothing standing out

- **WHEN** `insights::scan` runs and no detector finds a material result
- **THEN** it returns an empty list, and the proactive surface honestly shows that nothing stands out rather than inventing a finding

### Requirement: The insights scan is bounded, on-device, and degrades per table

The scan SHALL be bounded — at most a fixed number of cataloged tables visited and
a fixed number of findings returned — and SHALL disclose when tables were left
unscanned rather than silently truncating. It SHALL be computed entirely on-device
(DataFusion SQL, no provider call, no model in the loop) so it egresses nothing. A
table that cannot be analyzed SHALL be skipped silently; one unanalyzable table
SHALL NOT fail the scan.

#### Scenario: A large vault caps the scan and discloses the cap

- **WHEN** `insights::scan` runs over more cataloged tables than the scan cap
- **THEN** it scans up to the cap in catalog order, returns up to the findings cap ranked by magnitude, and discloses that further tables were not scanned rather than presenting the capped set as exhaustive

#### Scenario: The scan performs no network egress

- **WHEN** `insights::scan` runs to produce the proactive surface
- **THEN** all computation is on-device SQL over the cataloged tables with no provider request and no model call, so the scan adds no egress path

#### Scenario: An unanalyzable table is skipped, not fatal

- **WHEN** one cataloged table has no Date/Numeric shape or errors during analysis
- **THEN** that table is skipped and the scan continues over the rest, returning the findings it could compute rather than failing wholesale

### Requirement: The proactive insights surface is Rust-only with an honest TS degradation

The insights scan SHALL be Rust-only (DataFusion), consistent with the analytics
branch's existing Rust-only posture. The TypeScript twin's `insights` op SHALL
return an empty list rather than a fabricated or partial result, carrying a
`PARITY:` note, and `docs/ts-twin.md` SHALL record insights among the Rust-only
analytics capabilities.

#### Scenario: The TS twin returns an empty insights list

- **WHEN** the `insights` op is invoked against the TypeScript engine
- **THEN** it returns an empty list (no analytics branch to run), honestly degrading rather than returning a fake finding, exactly as the analytics SQL op already degrades there
