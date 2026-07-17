# certified-answers — delta

## ADDED Requirements

### Requirement: An answer is certified only when its SQL verifiably used a blessed definition
An analytics answer SHALL carry a "certified" mark for a metric ONLY when its
executed SQL's projection contains an aggregation that is AST-equal to that
metric's blessed expression. Certification SHALL be determined by parsing the
executed SQL with the same parser the guard uses and comparing normalized ASTs —
so whitespace, casing, and alias differences are ignored but a genuinely
different aggregation is not certified. An ad-hoc query that merely resembles a
metric SHALL NOT be certified.

#### Scenario: The blessed definition certifies the answer
- **WHEN** an answer runs `SELECT region, SUM(amount) FILTER (WHERE status='paid') AS revenue FROM sales GROUP BY region` and a `revenue` metric holds that exact expression
- **THEN** the answer is certified for `revenue`, and the certified mark names that metric

#### Scenario: A near-miss ad-hoc query is not certified
- **WHEN** an answer runs `SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region` while the blessed `revenue` metric is `SUM(amount) FILTER (WHERE status='paid')`
- **THEN** the answer is NOT certified — the two aggregations are not AST-equal, so the mark is withheld rather than decorating a different number

### Requirement: The certified mark is engine-determined and model-free
The certified mark SHALL be computed by the engine from the executed SQL, never
authored or asserted by the model. Removing the model's narration SHALL NOT
change whether an answer is certified, and the model SHALL be unable to add a
"certified" mark by writing the word.

#### Scenario: Narration cannot change the verdict
- **WHEN** the same certified answer is produced once with model narration and once without
- **THEN** the certified mark is identical in both, because it is derived from the executed SQL and the store, not from any model text

### Requirement: The certified mark surfaces on the answer and persists through the cache
The certified mark SHALL ride the analytics answer's structured meta and an
engine-emitted footer line (never model text), and SHALL persist with the cached
answer so a replay of a certified answer stays certified without recomputation.

#### Scenario: A cached certified answer replays certified
- **WHEN** a certified answer is served from the answer cache on a re-ask
- **THEN** the replay still carries the same certified mark for the same metric, read from the stored analytics meta, with nothing recomputed

#### Scenario: The certified line is engine-emitted
- **WHEN** an answer is certified for `revenue`
- **THEN** an engine-emitted `*Certified:*` footer names `revenue` alongside the existing Query-used / Computed-from / Assumptions footers, and no part of it is model-generated
