# quant-changepoint — delta

## ADDED Requirements

### Requirement: A changepoint recipe locates the most significant level shift

The engine SHALL provide a deterministic `changepoint-scan` recipe that, over a
Date + Numeric table's monthly series, finds the single split that maximizes the
before/after mean gap normalized by the pooled standard deviation, and reports the
changepoint period, the before-mean, the after-mean, their delta, and the
normalized magnitude. The scan SHALL be computed as guarded SQL (cumulative
window aggregates over the series plus a top-1 ordering); the model SHALL narrate
where and by how much the series shifted, in words, using the engine's means, and
SHALL NOT compute any number. It SHALL stamp only the existing `AnalyticsMeta
{sql, file_ids}`.

#### Scenario: A series that steps up is flagged at the step

- **WHEN** the `changepoint-scan` recipe runs on a series that holds a low level and then steps to a distinctly higher level partway through
- **THEN** the reported changepoint period is the step boundary, the before-mean and after-mean are the engine-computed averages of the two segments, and the narration states the shift using those figures

#### Scenario: The changepoint magnitude is engine-computed

- **WHEN** a changepoint answer is produced
- **THEN** the before/after means and the normalized magnitude come from the executed SQL (reproducible from `AnalyticsMeta.sql`), and the model's prose introduces no figure the engine did not compute

### Requirement: The changepoint scan degrades safely on short or flat series

The recipe SHALL require at least four periods (two points on each side of a
split). With fewer, it SHALL return a plain descriptive answer rather than an
error. On a flat series with no material shift, it SHALL report the top split with
a near-zero magnitude and narrate honestly that no material level shift was found,
using the engine's magnitude rather than a model judgment.

#### Scenario: Too little history returns a plain answer, not an error

- **WHEN** the `changepoint-scan` recipe runs on a table with fewer than four periods
- **THEN** the answer states there is not enough history to locate a shift, describes the available series, and fabricates no changepoint

#### Scenario: A flat series honestly reports no material shift

- **WHEN** the series has no material level change (near-constant values)
- **THEN** the answer reports the top candidate split with a near-zero engine-computed magnitude and states that no material shift was found, rather than overstating a trivial fluctuation
