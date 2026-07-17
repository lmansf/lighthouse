# add-recipes

## Why

The Beam engine can answer a shaped question, but the analyst still has to
know the question. The recurring analyses — "how did this move vs last
period", "break this down by cohort", "is this column clean", "is there an
anomaly", "what moved most" — are the same five shapes over and over, and
today each is a fresh act of SQL authorship (or a model round-trip that may
plan them differently every time). Recipes make those shapes first-class:
named, parameterized, DETERMINISTICALLY planned bundles of guarded SELECTs
that run identically on every provider — including the private model and the
extractive fallback — because no model is consulted to plan them.

And every Beam answer, recipe or not, should be honest about the choices the
engine made on the analyst's behalf: which column it read as the date, where
the period boundaries fell, how many rows it considered, what nulls the
aggregates skipped, which filters and group-bys applied. The **assumption
ledger** surfaces exactly that — engine-derived, never model text.

## What Changes

- **Recipes.** A recipe = {id, name, applicability predicate over the
  catalog, parameters (table/view, date column, metric, period, group), a
  bounded plan of N guarded SELECT templates, a narration prompt}. Planning
  is DETERMINISTIC — the templates expand from the resolved parameters with
  NO model call. Execution reuses the existing model-free executor
  (`run_direct`/`run_query` + the guard) once per template; the provenance
  footer lists every executed query (the multi-step footer already does
  this). Narration is skippable: on the extractive/no-model provider the
  answer is the result tables + footers + ledger, no prose. Five built-ins
  v1, each with golden fixtures: variance-vs-last-period, cohort breakdown,
  data-quality audit, anomaly scan (windowed z-score/IQR), top-movers. NO
  user-authored recipes v1 — the recipe format is the seam, not a v1 surface.
- **Assumption ledger on ALL Beam answers.** An "Assumptions" disclosure
  rendered from ENGINE-derived facts only — the date column used, the period
  boundaries, rows considered (caps stated honestly), null handling implied
  by the aggregates, filters applied, group-by columns, and any recipe
  parameters. Ad-hoc (non-recipe) answers derive their ledger by inspecting
  the executed SQL's parsed AST. The ledger rides in the answer text
  alongside the provenance stamp/footer (engine-emitted markdown folded into
  a native disclosure by the same client machinery that folds "Query used").
- **Surfaces.** A Library gallery of recipes, applicability-filtered
  ("runnable on sales_all"); one-tap recipe chips in the chat empty state
  when the tabular context matches a recipe's predicate; recipe results pin
  and board like any answer; evidence packs include the full plan.

## Capabilities

### New Capabilities

- `recipes`: deterministic, parameterized analysis bundles (the object,
  built-ins, applicability, model-free planning + execution, surfaces) AND
  the assumption ledger on every Beam answer (engine-derived disclosure).

## Non-goals

- **No user-authored recipes.** v1 ships five built-ins; the file format is
  the extension seam, not a creation UI.
- **No model in planning.** Recipes plan from parameters deterministically;
  the model only narrates (and narration is skippable). A recipe's numbers
  are never model-authored.
- **Ledger is engine-derived, never model text.** Every entry comes from the
  executed SQL's AST or the recipe's resolved parameters — the model cannot
  add, remove, or reword a ledger entry.
- **No structured/queryable ledger meta v1.** The ledger rides as
  engine-emitted markdown (the "Query used" footer precedent), folded to a
  disclosure client-side. A machine-queryable ledger field is a designed
  follow-on, not v1.
- **Recipes execute Rust-only.** Analytics/catalog are Rust-only (the twin
  never takes the analytics branch); the twin gets recipe visibility (the
  gallery/chips list) with `{available:false}` on execution — the
  suggestedAsks precedent.
- **No new scheduler.** Recipes run on demand from a chip/gallery like any
  ask.

## Impact

- Engine: NEW `native/crates/lighthouse-core/src/recipes.rs` (built-in
  descriptors, applicability predicates, deterministic planner). `synth.rs`
  gains a recipe branch BEFORE the `has_real_model` gate so recipes run on
  every provider incl. local + extractive, reusing the multi-step executor
  (`run_query` + `StepRecord` + the footer/freshness/final-chunk sequence).
  NEW ledger derivation extending the `views.rs` sqlparser walker (projection
  aggregates, group-by, WHERE filters) + `catalog.rs` column kinds; ledger
  emitted as markdown on every analytics answer (single-query and multi-step)
  and recipe answer. `meta.rs` gains `applicable_recipes` (the
  suggested_asks_resolved shape). Dispatch `op:"recipes"` /
  `op:"applicableRecipes"` + a recipe-run cue in the ask path.
- Contracts/UI: Recipe types + RagService methods (+ real/mock); NEW
  `src/features/recipes/RecipesNav.tsx` (Library gallery) + empty-state recipe
  chips in ChatPanel; the assumption-ledger disclosure via extending
  `remarkAnswerCard`/`isFooterish`; evidence-pack plan extension.
- `docs/data-flows.md` MUST NOT grow — recipes plan and execute model-free
  (no new egress); narration rides the already-configured provider like any
  ask.
