# chart-directive — delta

## ADDED Requirements

### Requirement: A chart card is injected only when a chartable analytics result is in context
When a Beam analytics answer's result table is in the narration context, is not
truncated, and its shape could chart, the engine SHALL inject a compact,
versioned chart card into the narration prompt: the available kinds and when
each fits, when none fits, the actual result columns by name, the directive
syntax, and few-shot examples. The card SHALL stay within its token budget and
SHALL NOT be injected on non-analytics answers, truncated results, or
unchartable shapes.

#### Scenario: Card rides a chartable result
- **WHEN** an analytics ask returns an untruncated result with a label column and numeric columns
- **THEN** the narration prompt contains the chart card naming those result columns

#### Scenario: No card where no chart is possible
- **WHEN** the answer is non-analytics, or the result is truncated or unchartable
- **THEN** no chart card is injected and no directive is honored

### Requirement: Every example the card teaches passes the engine's own validator
Each few-shot directive example in the chart card SHALL be accepted by the
engine's directive validator against its example table, enforced by a unit
test that fails naming any offending example.

#### Scenario: A card edit cannot teach rejected syntax
- **WHEN** a card example is edited such that the validator would reject it
- **THEN** the few-shot integrity test fails, naming that example

### Requirement: The model steers the chart through one plain-text directive; the engine owns the numbers
The engine SHALL honor at most one fenced `lighthouse-chart-request` block per
answer, with fields {kind | "none", label_column, series_columns (≤3), title?,
sort?}. It SHALL validate every named column against the actual result batches
(existence; numeric-ness for series) and, when valid, build the chart spec FROM
the batches with the directive's choices as parameters. No value appearing in
the directive SHALL be copied into the chart data; only a length-capped title
may pass through as display text. The fence SHALL be stripped from displayed
prose in every surface.

#### Scenario: A valid directive renders that chart
- **WHEN** the model emits a directive naming a real label column and real numeric series columns with kind "bar"
- **THEN** the rendered chart is a bar chart of exactly those columns, with every number identical to the result table

#### Scenario: Fabricated values are ignored
- **WHEN** a directive includes extra keys such as "x" or "values" carrying numbers
- **THEN** those keys are ignored entirely and the chart is built only from the batches

#### Scenario: The fence never shows
- **WHEN** an answer containing a directive fence streams to the main window or the widget
- **THEN** the displayed prose contains no `lighthouse-chart-request` fence

### Requirement: Invalid or absent directives fall back to the unchanged heuristic; "none" suppresses
On a malformed directive, an unknown column, more than 3 series, or no
directive at all, the engine SHALL emit exactly the chart today's deterministic
heuristic produces (byte-identical for existing fixtures). A directive with
kind "none" SHALL suppress the auto-chart even when the heuristic would draw
one.

#### Scenario: Unknown column falls back
- **WHEN** a directive names a column not present in the result batches
- **THEN** the answer carries the heuristic's chart choice, unchanged from today

#### Scenario: "none" suppresses
- **WHEN** the model emits kind "none" for a result the heuristic would chart
- **THEN** the answer renders no chart

### Requirement: Narration references a chart only when one was requested
The system prompt SHALL instruct the model to reference a chart in prose only
when it is emitting a chart request in the same answer, so "the chart below
shows…" is not written for chartless answers. The prompt lines SHALL remain
byte-identical across both engines.

#### Scenario: No phantom chart references
- **WHEN** the model requests no chart (or "none") for an answer
- **THEN** the taught behavior is prose that does not describe a chart

### Requirement: A chart quality floor is enforced alongside the analytics eval
Golden fixtures SHALL cover the known misfire classes (date-like labels,
top-N candidates, single-value results, identifier columns) asserting the
expected kind-or-none and columns; directive-validator tests SHALL cover
unknown columns, over-limit series, and fabricated-value stripping; a chart
scorecard SHALL run these as a CI-enforceable floor beside the 0.11.2
analytics eval, failing non-zero on any violation. Existing bar/line/area
fixtures SHALL remain unchanged.

#### Scenario: Identifier columns stop charting
- **WHEN** the golden fixture's result is `store_id, revenue` with 4-digit store IDs
- **THEN** the floor asserts the heuristic declines (no time-series, no meaningless bar-per-id) and a valid directive can still chart it deliberately as a bar

#### Scenario: Drift is a reviewed diff
- **WHEN** the chart card text or the heuristic changes behavior on a golden fixture
- **THEN** the scorecard or snapshot fails until the change is reviewed and the fixture updated
