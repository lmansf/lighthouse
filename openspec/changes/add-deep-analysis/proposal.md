# add-deep-analysis

## Why

Beam can answer one question at a time — a single ask, a recipe, a multi-step
analytical loop — but it has no way to *investigate a whole dataset* and hand
back a **structured report**. Everything today streams one narrated chat answer
and discards its structure: the multi-step beam loop accumulates `StepRecord`s
and then throws them away after narrating (`synth.rs`), and pins/recipes ride a
single representative SQL in `AnalyticsMeta`. A user who wants "give me the
picture on this table" has to ask a dozen questions by hand and stitch the
answers together themselves.

Two capabilities close that, and they are the capstone of the H-series (after
A `add-beam-loop`, B `add-semantic-layer`, C `add-automation`,
D `add-quant-depth`):

- **"Investigate X" → a structured report (S8).** Point Beam at a table and it
  runs the **applicable deterministic recipes** over it — variance, cohort,
  data-quality, anomaly, top-movers, forecast, changepoint — and assembles their
  ENGINE-VERIFIED results into one titled document: a summary of what stands
  out, a section per analysis with its evidence table + the exact SQL, and a
  caveats block from the assumption ledger. The report is written into the vault
  as a note, like a briefing or an investigation export.
- **A capability map.** A surface that shows what the vault makes *investigable*
  — the analyzable tables and their typed columns, the recipes/metrics that
  apply, the suggested asks, and a one-click "Investigate {table}" for each — so
  the user can see what Beam can draw on before asking.

The design stays inside the discipline every prior phase held: **every number is
engine-computed SQL, never model-generated** (the report is a deterministic
assembly of `run_query` results — the model is not in the core loop at all);
computation is on-device and bounded; and the report is **computed on demand and
written in-vault** (the briefings / investigation-export precedent), so nothing
touches the cached-answer wire shape. The result is a **no-`CACHE_VERSION`-bump,
no-version-bump** phase.

## What Changes

- **A deterministic report model + assembler (do first).** A new
  `reports.rs`: `Report { title, generated_ms, summary, sections, caveats }` and
  `ReportSection { heading, question, result_markdown, sql }`. The assembler
  takes a set of ALREADY-EXECUTED sub-analyses (each a question + its verified
  `QueryResult`) and renders one markdown document reusing the
  `briefings::render_markdown` idiom (`# title`, then `## ` sections). The
  summary is TEMPLATED from the sub-analyses' key figures (the `insights`
  headline discipline — engine numbers, never model text); the caveats come from
  the assumption ledger. Pure and testable without a model or a store.
- **The `investigate` engine.** `investigate(table, included_ids, is_cloud) ->
  Report`: resolve the applicable recipes over the target table's typed columns
  (the `applicable_recipes` predicate), run each recipe's representative query
  through the SAME model-free `run_query` the recipe branch uses, and hand the
  verified results to the assembler. Bounded (a fixed recipe battery, one
  representative query each). Deterministic and model-free — the whole report is
  reproducible from the SQL. A bounded model-authored NARRATIVE intro is an
  opt-in enrichment, never the core and never a source of a number.
- **In-vault write.** The report is written through the `exportChat` / briefing
  precedent — `investigations::notes_subdir(id)` (or a `Lighthouse Reports`
  write-artifact allowlist entry) + `vault::write_artifact` — a non-egress,
  sanitized, never-overwrite in-vault note; the op returns `{savedId,
  savedName}`. "Investigate {table}" may also CREATE/attach an investigation so
  the report lands under a scoped line of inquiry.
- **The capability map.** A new `capability_map(included_ids, is_cloud) ->
  CapabilityMap` that AGGREGATES the existing posture-gated lists — catalog
  tables + typed columns (`catalog::columns_for`), `meta::applicable_recipes`,
  `meta::applicable_semantics`, `meta::suggested_asks` — and derives a
  `suggested_investigations` list (one "Investigate {table}" per analyzable
  Date/Numeric table). No new analysis; it composes what already exists.
- **Op surface + UI.** An `investigate` op and a `capabilityMap` op
  (`routes.rs` / `commands.rs` / `app/api/rag/route.ts`); a capability-map
  gallery surface (a `RecipesNav`-style panel) with an "Investigate" affordance
  that runs the op and opens the written report. PARITY: both are Rust-only
  (DataFusion + recipes) — the TS twin returns `{available:false}` / empty.

## Capabilities

### New Capabilities

- `deep-analysis`: the `investigate` engine + the deterministic report model,
  assembler, and renderer. Over a target table it runs the applicable recipes,
  assembles their engine-verified results into a titled structured report
  (summary + per-analysis sections with evidence + SQL + caveats), and writes it
  in-vault. Every number is engine-computed; the report is deterministic and
  reproducible from its SQL.
- `capability-map`: the `capability_map` aggregator + surface — the analyzable
  tables + typed columns, the applicable recipes/metrics, the suggested asks,
  and a one-click "Investigate {table}" per analyzable table, so the user sees
  what Beam can investigate.

## Non-goals

- **No model-planned free-text topic decomposition in v1.** "Investigate {table}"
  runs a FIXED, deterministic recipe battery — reproducible and CI-gated.
  Decomposing an arbitrary free-text topic ("investigate the returns spike") into
  model-planned sub-questions is a designed follow-on gated on the opt-in
  provider eval, NOT the v1 core (it would put a model in the number-producing
  path and blow the cost budget).
- **No model-generated numbers.** The report's sections ARE `run_query` results;
  its summary is templated from those results (the `insights` discipline). A
  model may add a prose intro (opt-in) but never a figure. The
  every-number-engine-computed invariant holds across the whole report.
- **No new cached-answer wire shape / no `CACHE_VERSION` bump.** The report is
  computed on demand and written in-vault (the briefings / investigation-export
  precedent); it never becomes a `CachedAnswer` and touches neither
  `AnalyticsMeta`/`ChunkMeta` nor the extract cache. `CACHE_VERSION` stays 12 and
  the answer-cache `ENVELOPE_V` stays 1.
- **No streaming synth branch.** `investigate` is a bounded async OP (like the
  briefings `run` and the `insights` scan), not a new chat-cue branch in
  `synth.rs` — it avoids the beam loop's discard-structure problem by running the
  recipes directly and collecting their verified results.
- **No version bump.** An H-suite phase; the five version stamps do not move.

## Impact

- **Engine (Rust, ships):**
  - NEW `native/crates/lighthouse-core/src/reports.rs` — `Report`/`ReportSection`
    + the assembler + `render_markdown` (the `briefings.rs:245` idiom) + the
    templated summary/caveats. `pub mod reports;` in `lib.rs`.
  - NEW `investigate(table, included_ids, is_cloud) -> Report` (in `reports.rs`
    or a thin `investigate` module) — resolves `recipes::BUILTINS` `.applicable`
    over the catalog columns, runs each representative query via
    `analytics::run_query`, assembles. Reuses `catalog::columns_for` +
    `analytics::register_tables` (the `insights::scan` pattern).
  - `capability_map(included_ids, is_cloud) -> CapabilityMap` — aggregates
    `columns_for` + `applicable_recipes` + `applicable_semantics` +
    `suggested_asks` + the derived `suggested_investigations`.
- **Op surface (for the app):** an `investigate` op (runs + writes the report,
  returns `{savedId, savedName}`) and a `capabilityMap` op (returns the
  aggregate) across `routes.rs`, `commands.rs`, `app/api/rag/route.ts`. A
  capability-map gallery + an "Investigate" affordance in the app.
- **TS twin (`src/server/`):** Rust-only (DataFusion + recipes, the analytics
  posture). `route.ts` returns `{available:false}` for `investigate` and an empty
  `capabilityMap` (the `applicableRecipes` precedent); a `docs/ts-twin.md` row
  records it. The report render + capability aggregate are Rust-only.
- **CI:** a model-free `deep-analysis` floor in `examples/analytics_eval.rs` —
  `investigate` over a fixture table yields a report whose sections are the
  applicable recipes' verified results and whose every figure appears in a
  `run_query` result (the every-number invariant), deterministic across two
  runs. `cargo build/test --workspace` picks up `reports.rs` + tests with no
  workflow edit.
- **Docs:** `docs/ts-twin.md` gains a Rust-only row for deep analysis + the
  capability map; `docs/data-flows.md` notes the report is on-device SQL written
  in-vault (no new egress — the recipe execution egresses only as any recipe
  narration would, and the deterministic core uses no model at all).
- **No `CACHE_VERSION` bump** (12 → 12) and **no version bump** (0.12.1).
