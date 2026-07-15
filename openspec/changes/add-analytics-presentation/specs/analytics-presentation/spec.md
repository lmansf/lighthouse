# analytics-presentation — delta

## ADDED Requirements

### Requirement: Scatter is emitted only for a continuous, non-temporal x
When a verified result has exactly two columns and its first column is CONTINUOUS (a floating-point column) and does NOT read as a temporal label, the engine SHALL emit a scatter chart carrying a numeric x position per point aligned to the y values. An INTEGER-keyed first column (star ratings, status codes, enum ids) SHALL stay a bar, because small integer keys are usually categorical and read wrong as a continuous scatter. A first column whose labels read as time (bare years, `YYYY-MM`, `YYYY-MM-DD`, `Qn YYYY`) SHALL continue to chart as line or area exactly as before. A scatter SHALL be emitted only when at least two points carry both a finite x and a finite y; otherwise the result degrades to the table.

#### Scenario: A continuous relationship charts as scatter
- **WHEN** a two-column result has a floating-point, non-temporal first column (e.g. weight) and a numeric second column (e.g. price)
- **THEN** the engine emits a scatter chart with per-point numeric x positions, and the renderer draws unconnected points on a numeric x-axis

#### Scenario: An integer key stays a bar
- **WHEN** the first column is an integer key (e.g. star-rating 1–5) with a numeric measure
- **THEN** the chart is a bar (categorical), not a scatter

#### Scenario: Bare years stay a time-series
- **WHEN** the first column is numeric but every label is a bare year
- **THEN** the chart is area/line (a time-series), not a scatter

### Requirement: Stacked bar is emitted only when the parts prove a constant whole
The engine SHALL emit a stacked bar ONLY when there are at least two series, every value is present and non-negative, and for every category the cross-series values sum to the same constant whole within epsilon (approximately 100 or approximately 1.0). Otherwise it SHALL emit a grouped bar. The renderer SHALL draw stacked segments but SHALL NOT display any stack total, so no number is stated that the query did not produce.

#### Scenario: Shares that sum to 100 stack
- **WHEN** each category's series values sum to the same whole (≈100 or ≈1.0)
- **THEN** the engine marks the bar stacked and the renderer draws accumulated segments with no total label

#### Scenario: Independent metrics stay grouped
- **WHEN** a multi-series categorical result's values do not sum to a shared constant whole
- **THEN** the bar is grouped (not stacked) and no stack total is implied

#### Scenario: A null part disqualifies stacking
- **WHEN** any category is missing a series value
- **THEN** the bar is grouped, because a hole cannot honestly stack

### Requirement: Existing bar/line/area chart output is byte-identical
Adding scatter and stacked SHALL NOT change the emitted JSON for any default bar, line, or area chart. The new keys (scatter kind, `xValues`, `stacked`) SHALL appear ONLY on the new chart paths. Axis formatting SHALL therefore be derived by the renderer from the labels and values already on the wire, not added to the wire schema.

#### Scenario: A categorical bar's bytes are unchanged
- **WHEN** a categorical group-by result is charted
- **THEN** the serialized chart spec is byte-for-byte what it was before this change

### Requirement: The renderer formats axes without changing the wire
The renderer SHALL present large magnitudes with grouped/compact tick labels, format temporal x-ticks by their detected granularity (e.g. abbreviate a month label), give scatter a numeric x-axis, and choose the Y domain by chart kind — a stacked bar's domain topped by the maximum per-category stack sum, and line/scatter fitted to the data rather than forced to a zero baseline. None of this SHALL require a change to the emitted spec.

#### Scenario: Monthly labels abbreviate
- **WHEN** the x labels are `YYYY-MM` months
- **THEN** the x-axis ticks render as month abbreviations, derived from the labels on the wire

#### Scenario: A scatter axis fits its data
- **WHEN** a scatter's y values cluster far from zero
- **THEN** the Y domain fits the data instead of wasting the axis on an unused zero baseline

### Requirement: A truncated result's disclosure survives and sorting stays honest
When a result was truncated, the deterministic "first N of M rows" disclosure SHALL always remain visible in the answer body — it SHALL NOT be removed on the assumption a table will re-show it, because a truncated answer may narrate in prose with no result table. Additionally, when a result table IS rendered and the user sorts it, the table SHALL indicate that the sort covers only the shown rows, not all matched rows.

#### Scenario: The disclosure survives a prose answer
- **WHEN** a truncated result is answered in prose with no reproduced result table
- **THEN** the "first N of M rows" disclosure still appears in the answer

#### Scenario: Sorting a truncated table flags the subset
- **WHEN** a truncated result's table is sorted by a column
- **THEN** the table shows that this is a sorted view of the shown rows only, in addition to the disclosure in the body

#### Scenario: A non-truncated table sorts without the caveat
- **WHEN** a complete (non-truncated) result's table is sorted
- **THEN** no truncation caption is shown, because the sort covers all rows
