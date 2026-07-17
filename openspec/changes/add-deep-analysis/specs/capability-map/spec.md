# capability-map — delta

## ADDED Requirements

### Requirement: The capability map shows what the vault makes investigable

The engine SHALL provide `capability_map(included_ids, is_cloud)` that aggregates
the analyzable tables and their typed columns (`catalog::columns_for`), the
applicable recipes (`meta::applicable_recipes`), the applicable metrics
(`meta::applicable_semantics`), the suggested asks (`meta::suggested_asks`), and a
derived `suggested_investigations` list — one "Investigate {table}" entry per
analyzable Date+Numeric table. It SHALL introduce no new analysis; it composes
the existing posture-gated lists, inheriting their cloud-posture gating.

#### Scenario: The map aggregates the applicable surfaces for the included set

- **WHEN** `capability_map` runs over the included files
- **THEN** it returns the analyzable tables with their typed columns, the recipes and metrics that apply to them, the suggested asks, and one "Investigate {table}" suggestion per Date+Numeric table — a single view of what Beam can investigate

#### Scenario: A vault with no analyzable tables offers no investigations

- **WHEN** `capability_map` runs over a vault whose included files have no Date+Numeric table
- **THEN** the `suggested_investigations` list is empty (nothing is investigable), rather than offering an investigation that would produce an empty report

### Requirement: The capability map honors the provider posture

The aggregated lists SHALL carry the SAME posture gating their sources apply — a
cloud provider drops the effectively-local-only recipes/metrics exactly as
`applicable_recipes`/`applicable_semantics` already do — so the map never offers a
capability the current posture would refuse.

#### Scenario: Cloud posture hides local-only capabilities in the map

- **WHEN** `capability_map` runs under a cloud provider
- **THEN** the recipes and metrics it lists are exactly the posture-eligible subset (local-only-marked ones dropped), matching what the underlying `applicable_*` lists return for the same posture

### Requirement: The capability map is Rust-only with an honest TS degradation

The aggregate SHALL be Rust-only (it composes DataFusion-catalog + recipe
applicability). The TypeScript twin's `capabilityMap` op SHALL return an empty
map rather than a partial or fabricated one, carrying a `PARITY:` note, and
`docs/ts-twin.md` SHALL record it.

#### Scenario: The TS twin returns an empty capability map

- **WHEN** the `capabilityMap` op is invoked against the TypeScript engine
- **THEN** it returns an empty map (no analytics catalog to aggregate), honestly degrading rather than returning a partial one
