# Design — add-deep-analysis

## Context

The H-series built the parts a deep report needs but never assembled them: the
recipes (`recipes.rs`, add-quant-depth) each compute a titled analysis as guarded
SQL; `briefings.rs` renders a titled multi-section report to markdown and writes
it in-vault; `catalog.rs` + `meta.rs` expose the posture-gated "what applies"
lists; `investigations.rs` gives a scoped folder to write into. What is missing
is the composition — a **model-planned or deterministic set of sub-analyses,
assembled into one persisted, structured document.**

The recon surfaced the load-bearing constraint: the multi-step beam loop
NARRATES then DISCARDS its `StepRecord`s (`synth.rs`), and multi-analysis answers
have no place to ride in the single-representative-SQL `AnalyticsMeta`. So a
report cannot reuse the beam branch's output — it must run the sub-analyses
itself and keep their verified results. This design does exactly that, and keeps
the core **deterministic and model-free** so it is CI-gated and every number is
provably engine-computed.

## The report model + assembler (deterministic, model-free)

```rust
pub struct Report {
    pub title: String,
    pub generated_ms: i64,
    pub summary: Vec<String>,       // templated top findings, engine numbers only
    pub sections: Vec<ReportSection>,
    pub caveats: Vec<String>,       // assumption-ledger + data-quality notes
}
pub struct ReportSection {
    pub heading: String,            // the recipe name, e.g. "Anomaly scan"
    pub question: String,           // the recipe's human summary
    pub result_markdown: String,    // the VERIFIED run_query render
    pub sql: String,                // the exact query (provenance)
}
```

`assemble(title, sub_analyses, caveats) -> Report` is pure: it takes a `Vec` of
already-executed sub-analyses (heading + question + `QueryResult` + sql) and
builds the `Report`. The **summary is templated** from the sub-analyses' key
cells — the `insights::scan` discipline: e.g. from the anomaly section's top row
it emits "October is a +2.85σ anomaly"; from top-movers, "South moved +400%".
Every summary line carries an engine number pulled from a `QueryResult` cell,
never a model-authored figure.

`render_markdown(&Report) -> String` reuses the `briefings.rs:245` idiom exactly:
`# {title}`, a `## Summary` bullet list, a `## {section.heading}` block per
section (the question line, the result table, and a fenced `Query used` SQL
block), and a `## Caveats` block. Byte-stable given a fixed `generated_ms`
(passed in, not read from the clock, so the render is testable and deterministic).

## The `investigate` engine

`investigate(table, included_ids, is_cloud) -> Report`:

1. Build the catalog + register the tables (the `insights::scan` pattern:
   `catalog::columns_for` + `analytics::register_tables` over the included
   tabular files), and resolve the target `table`'s registered SQL name + typed
   columns.
2. For each builtin recipe whose `.applicable(cols)` holds over the target
   (`recipes::BUILTINS`, the `applicable_recipes` predicate), resolve its params
   and run its REPRESENTATIVE query (`plan[0]`) through `analytics::run_query` —
   the same model-free path the recipe branch and `insights::scan` use. A recipe
   that doesn't resolve or returns no rows is skipped (a table with no anomaly
   contributes no anomaly section — honest).
3. Collect each `(recipe.name, recipe.summary, QueryResult, sql)` as a
   sub-analysis, assemble the `Report`, and derive caveats from the last section's
   assumption ledger (`ledger::assumption_ledger_parts`) + any data-quality
   findings.

Bounded by construction: a FIXED battery (the ≤7 builtins), one representative
query each — at most ~7 guarded SELECTs per investigation. No model in the loop,
no planner recursion, so no cost blowup. The whole report is reproducible from
its SQL.

**Optional model narrative (opt-in, never the core).** When a real model is
configured AND the caller opts in, a single bounded `stream_answer` call may
prepend a prose intro over the ALREADY-ASSEMBLED sections (the recipe-narration
posture: it narrates the verified results, supplies no number). It never plans
sub-questions and never gates the report; the model-free report stands complete
without it. The CI floor runs the model-free path only.

## The capability map

`capability_map(included_ids, is_cloud) -> CapabilityMap` aggregates, with no new
analysis:

```rust
pub struct CapabilityMap {
    pub tables: Vec<TableCapability>,            // name + typed columns (catalog)
    pub recipes: Vec<RecipeCard>,                // meta::applicable_recipes
    pub metrics: Vec<MetricCard>,                // meta::applicable_semantics.metrics
    pub suggested_asks: Vec<SuggestedAsk>,       // meta::suggested_asks
    pub suggested_investigations: Vec<Suggestion>,// "Investigate {table}" per analyzable table
}
```

`suggested_investigations` is derived: one entry per catalog table with a
Date+Numeric shape (the `investigate`-eligible tables — the same predicate the
report uses to have anything to run). Everything else is a re-projection of
existing posture-gated lists, so the map inherits their cloud-posture gating for
free.

## Rust / TS parity

Deep analysis is DataFusion + recipe execution → **Rust-only**, exactly like the
analytics/recipes branch. The TS twin (`src/server/`) has no `analytics.ts` /
`recipes.ts` / `catalog.ts`; `route.ts` returns `{available:false}` for the
`investigate` op and an empty `capabilityMap` (the `applicableRecipes → []`
precedent), with a `docs/ts-twin.md` row. The report render and the aggregate are
Rust-only; there is no `reports.ts`. The `write_artifact` write is the shared
in-vault path (already Rust-side at the op layer, as with export/briefings).

## Failure & local-window degradation

- **No applicable recipes / empty table.** `investigate` over a table with no
  Date+Numeric shape (or no rows) returns a report with an empty `sections` list
  and an honest summary ("Nothing to analyze in {table} — no dated numeric
  series"). It degrades to a truthful short report, never an error.
- **A recipe errors / returns no rows.** That section is skipped; the rest of the
  battery still runs (the `insights::scan` per-detector skip). One bad analysis
  never fails the report.
- **Local 6144-token window.** The core is model-free — no prompt at all — so it
  cannot pressure the window. The OPT-IN narrative passes only the assembled
  section *summaries* (a handful of lines), not the raw tables, well within the
  window (the recipe-narration budget). Data never enters a prompt.
- **Analytics-off / no real model.** The deterministic report runs on any
  provider (it is model-free SQL); the capability map is pure aggregation. Both
  work with the extractive fallback and on the local model.

## No version / no CACHE_VERSION bump

- **`CACHE_VERSION` stays 12.** The report is computed on demand and written
  in-vault via `write_artifact` (the briefings / `export_markdown` precedent); it
  never becomes a `CachedAnswer` and touches neither `AnalyticsMeta`/`ChunkMeta`
  nor the extract cache. The answer-cache `ENVELOPE_V` stays 1. No new persisted
  or twinned store envelope (`reports.rs` holds no store — a report is a rendered
  artifact, not a saved record).
- **No version bump.** An H-suite phase; the five stamps stay put — the A/B/C/D
  precedent.
