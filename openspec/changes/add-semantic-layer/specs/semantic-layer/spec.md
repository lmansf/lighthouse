# semantic-layer — delta

## ADDED Requirements

### Requirement: The semantic layer is a curated, versioned, local store managed like shaped views
The engine SHALL persist a semantic layer — canonical metrics, synonyms,
entities, and curated join hints — in a versioned local store
(`state_dir()/semantic.json`, envelope `{v:1, …}`) managed with the same rigor
as shaped views: serialized load-modify-save, bak-on-write when the file is
unreadable (unknown/missing version or corrupt JSON reads empty for the
session), stable engine-minted ids, and sanitized, case-insensitively unique
names. Definitions are device data and SHALL NOT be written to any source file
or sent anywhere by the store itself.

#### Scenario: A v1 store round-trips and an unreadable one is preserved
- **WHEN** the engine reads a `{v:1, …}` semantic store, and later reads a file whose version is unknown or whose JSON is corrupt
- **THEN** the v1 store loads its records, the unreadable file reads as empty for the session, and the next write renames it to a `semantic.json.bak-<epochms>` sibling before writing a fresh v1 envelope — no records are silently clobbered

#### Scenario: A metric name is sanitized and unique
- **WHEN** a metric is created with a name that collides case-insensitively with an existing metric, or that sanitizes to empty
- **THEN** the create is refused with a human-readable reason and nothing is persisted

### Requirement: A metric definition is a guarded, re-runnable SQL aggregation
A metric SHALL bind a name to an aggregation EXPRESSION over a named entity
(e.g. `revenue = SUM(amount) FILTER (WHERE status='paid')` over `sales`). The
expression SHALL be validated at save by synthesizing
`SELECT <expression> AS <name> FROM <entity>` and running the SAME read-only
`guard_sql` every executed query passes; a definition that is not a read-only
aggregation, does not parse, or references an unknown entity SHALL be refused.
The definition's source files/views SHALL be derived from the synthesized
statement so the metric carries its dependencies.

#### Scenario: A non-read-only or unparseable expression is refused
- **WHEN** a metric is saved whose expression does not parse, or which resolves to anything but a read-only SELECT over its entity
- **THEN** the save is refused at the guard with a human-readable reason, and no metric is persisted

#### Scenario: A valid definition passes the same guard as an executed query
- **WHEN** a metric `revenue = SUM(amount) FILTER (WHERE status='paid')` over the `sales` entity is saved
- **THEN** the synthesized `SELECT SUM(amount) FILTER (WHERE status='paid') AS revenue FROM sales` passes `guard_sql`, the metric is persisted, and its `reads` name the `sales` source

### Requirement: The semantic layer feeds NL→SQL so business terms compute consistently
Blessed definitions and synonyms SHALL be injected into the analytics prompt (a
deterministic context block assembled beside the table/view schema cards) on
BOTH the single-query and multi-step paths, so the model writes SQL using the
agreed definition of a term rather than re-guessing it. When the store holds no
definition eligible for the ask, the block SHALL be empty and every analytics
prompt string SHALL be byte-identical to the pre-semantic-layer prompt.

#### Scenario: A defined term rides into the prompt
- **WHEN** a `revenue` metric is defined and the analyst asks "revenue by region"
- **THEN** the analytics prompt carries the blessed `revenue` definition in its business-definitions block, and the generated SQL computes revenue with that definition rather than a re-guessed `SUM(amount)`

#### Scenario: An empty store changes no prompt
- **WHEN** an analytics ask runs against a vault with no semantic definitions
- **THEN** the business-definitions block is empty and the prompt is byte-identical to today's, so no existing behavior changes until a definition exists

### Requirement: A metric reference resolves deterministically to its definition
The engine SHALL resolve a metric name to its stored expression with NO model
call, so the resolution is a pure, testable function that the certifier, the
trust check, and the eval floor can share.

#### Scenario: Resolving a metric returns its stored expression
- **WHEN** `resolve_metric("revenue")` is called with a `revenue` metric in the store
- **THEN** it returns the stored expression `SUM(amount) FILTER (WHERE status='paid')` deterministically, consulting no model, and returns nothing for an unknown name

### Requirement: The semantic layer respects local-only marks and the shareable-subset gate
A definition whose transitive source files include an effectively-local-only
file SHALL itself be treated as local-only: excluded from a cloud ask's prompt
block AND from the answer-cache key material, exactly as an effectively
local-only view is. On a device ask, every definition is eligible.

#### Scenario: A local-only metric never rides a cloud prompt
- **WHEN** a metric is defined over a table marked "Private — this device only" and a cloud ask runs
- **THEN** that metric is absent from the cloud ask's business-definitions block and from its cache key, while a device ask still sees it

### Requirement: Synonyms, entities, and curated join hints are part of the model
The layer SHALL persist synonyms (a term mapped to a canonical column or metric),
entities (a name bound to a table, its key columns, and a description), and
curated join hints (how two entities relate), and SHALL render them into the
business-definitions block so the model can map a colloquial term or a
relationship to the curated meaning. Curated join hints SHALL render alongside
the engine's heuristic join hints and take precedence when they name the same
pair of tables.

#### Scenario: A synonym maps a colloquial term to a metric
- **WHEN** a synonym "GMV" → `revenue` is defined and the analyst asks about "GMV by month"
- **THEN** the business-definitions block carries the `GMV → revenue` mapping so the generated SQL computes the blessed `revenue` definition

#### Scenario: A curated join hint overrides the heuristic
- **WHEN** a curated join hint relates `orders.rep` to `reps.rep` and the heuristic join hints would pair the same tables differently
- **THEN** the curated hint is the one rendered into the prompt for that pair
