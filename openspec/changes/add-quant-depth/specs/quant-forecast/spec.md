# quant-forecast — delta

## ADDED Requirements

### Requirement: A forecast recipe projects a series forward with an engine-computed trend and band

The engine SHALL provide a deterministic `forecast` recipe that, over a Date +
Numeric table, fits an ordinary least-squares linear trend to the periodic series
and projects a fixed horizon of future periods, each with a point estimate and a
prediction band (± z·residual standard deviation). The fit, the projected points,
and the band bounds SHALL all be computed as guarded SQL (aggregate/window
queries executed by `analytics::run_query`); the model SHALL narrate the trend in
words and SHALL NOT compute or emit any number. The recipe SHALL stamp only the
existing `AnalyticsMeta{sql, file_ids}` — it adds no new answer wire field.

#### Scenario: A rising series projects a rising forecast with a band

- **WHEN** the `forecast` recipe runs on a table whose monthly totals trend upward over at least three periods
- **THEN** the engine computes the least-squares slope and intercept in SQL, the projected next periods lie on the fitted upward line, each projected period carries a lower and upper band bound around the point, and the narration describes the upward trend using the engine's figures

#### Scenario: Every forecast number is engine-computed, never model-authored

- **WHEN** a forecast answer is produced
- **THEN** the projected values and band bounds in the answer come from the executed SQL result (the `AnalyticsMeta.sql` reproduces them), and the model's prose cites those figures without introducing any number the engine did not compute

### Requirement: The forecast degrades safely when the series cannot be fit

The recipe SHALL require at least three periods (a slope plus a residual standard
deviation with n−2 degrees of freedom). With fewer, it SHALL return a plain
descriptive answer over the available series rather than an error or a fabricated
projection. A perfectly linear history (zero residual) SHALL collapse the band to
the fitted line rather than fail.

#### Scenario: Too little history returns a plain answer, not an error

- **WHEN** the `forecast` recipe runs on a table with fewer than three periods
- **THEN** the answer states that there is not enough history to forecast (naming the minimum), describes the series that exists, and no projection or band is fabricated

#### Scenario: A perfectly linear history forecasts with a collapsed band

- **WHEN** the historical series lies exactly on a straight line (zero residual)
- **THEN** the projected points continue that line, the band's lower and upper bounds equal the point (no shaded spread), and the answer renders without error

### Requirement: The forecast draws a band chart

The forecast recipe SHALL emit an inline chart directive of the new `band` kind
(the fitted/projected line plus the shaded prediction interval) via the recipe
branch's chart wiring, rendered from the engine's result table. The chart SHALL be
engine-authored (the recipe supplies the directive), not chosen by the model.

#### Scenario: A forecast answer includes a band chart of the projection

- **WHEN** a `forecast` answer with a valid multi-period projection is produced
- **THEN** the answer carries an inline `lighthouse-chart` fence of kind `band` whose primary series is the actual-then-projected line and whose lower/upper arrays are the band bounds, and the values in the chart are the same engine-computed figures as the result table
