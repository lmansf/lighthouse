# band-chart — delta

## ADDED Requirements

### Requirement: A band chart kind renders a line with a shaded interval

The chart grammar SHALL gain a `band` kind: a primary line series plus an
OPTIONAL lower-bound and upper-bound array that render as a shaded interval around
the line. The bound arrays SHALL be additive and optional on the chart-spec series
shape, so an ordinary bar/line/area/scatter series serializes byte-identically to
today (the bound fields absent) and no existing chart or pinned chart fixture
changes. This kind SHALL be twinned byte-for-byte across the Rust chart module and
`src/lib/chartSpec.ts`, and rendered in `AnalyticsChart.tsx`.

#### Scenario: A band spec renders a line and its interval

- **WHEN** an answer carries a `lighthouse-chart` fence of kind `band` with a primary series and matching-length lower/upper arrays
- **THEN** the renderer draws the primary line and a shaded region between the lower and upper bounds, reusing the existing axis and legend machinery, in both light and dark themes

#### Scenario: An ordinary chart is unchanged by the new bound fields

- **WHEN** a bar, line, area, or scatter chart spec (with no band) is produced
- **THEN** its serialized spec is byte-identical to what the pre-change engine produced (the optional lower/upper fields are absent), and its render is unchanged

### Requirement: The band kind is twinned and validated identically in both engines

The `band` kind and the optional bounds SHALL parse and validate identically in
the Rust chart module and in `src/lib/chartSpec.ts`. Validation SHALL require a
`band` spec's lower and upper arrays to be present and equal in length to the
primary series values; a `band` directive that fails validation SHALL fall through
to the heuristic chart path (which never emits `band`), degrading to a plain line
rather than a broken render.

#### Scenario: The twin suites both pin a band fixture

- **WHEN** the chart-spec parity fixtures run in the Rust suite and the node suite
- **THEN** both include a `band` case that parses and validates identically, so a divergence in the band grammar fails one suite against the other

#### Scenario: An invalid band directive degrades to a line

- **WHEN** a chart directive requests `band` but omits the bounds or gives mismatched-length bounds
- **THEN** validation rejects the directive, the pipeline falls through to the heuristic chart (a plain line), and the answer renders a valid chart rather than failing
