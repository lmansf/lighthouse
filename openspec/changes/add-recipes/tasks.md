# Tasks — recipes + assumption ledger

## 1. Assumption ledger (engine, all Beam answers) — do first
- [x] 1.1 Ledger derivation in analytics.rs (or a new ledger.rs): extend the sqlparser AST walk (views.rs TableWalk pattern) to read a Select's projection aggregates (null-handling honesty + metric), group_by (group columns), selection (WHERE filters); date column via catalog ColumnKind::Date / substr-month idiom; rows-considered + caps from QueryResult. `assumption_ledger(sql, regs, result) -> Option<String>` returning an `*Assumptions:*` label + bullet list (markdown), None when nothing derivable. Deterministic, engine-only, never model text.
- [x] 1.2 Emit the ledger on every analytics answer: single-query path (synth.rs ~:1050 footer region) and multi-step path (synth.rs ~:892-945), after the Query-used + freshness footers. Rides in answer text (cached free). Twin emits none (PARITY — no analytics branch).
- [x] 1.3 Client fold: extend remarkAnswerCard/isFooterish (ChatPanel.tsx:1178/1205) so the `*Assumptions:*` label + list becomes its own native <details> disclosure (the "Query used" fold precedent); quiet Beam styling both themes. Evidence pack renders it flat (rides section b).
- [x] 1.4 Tests: Rust ledger snapshot over fixed SQL (group-by, WHERE, SUM-null, date col, rows/caps) byte-stable; ledger None for non-SQL; a ledger entry per built-in param set. JS structural: the disclosure fold; no-SQL answer → no disclosure.

## 2. Recipe engine (recipes.rs + deterministic planner)
- [x] 2.1 recipes.rs: the 5 built-in descriptors (Recipe {id,name,summary,needs,params,plan fn,narration_prompt}); Applicability predicate type; ResolvedParams; PlannedQuery{label,sql}. Deterministic `plan(&resolved) -> Vec<PlannedQuery>` per built-in. Every template a single guarded SELECT (asserted by a guard_sql test over all planned templates against fixtures).
- [x] 2.2 Recipe executor in synth.rs: a branch BEFORE the has_real_model gate (:717) — detect the recipe cue on the question, resolve recipe+params against the catalog, expand plan, run each template via run_query into StepRecords (lift the multi-step accumulator minus model planning), emit results + `*Queries used (N):*` footer + one freshness stamp + row-cap + the §1 ledger. Narration skippable: model present → one collect(stream_answer) over step results with narration_prompt; extractive → no prose, footer/final-chunk never depend on narration. Representative query → AnalyticsMeta.sql for pin/board.
- [x] 2.3 meta.rs applicable_recipes(included, is_cloud) mirroring suggested_asks_resolved: evaluate each recipe's needs over columns_for ∪ view_typed_columns; posture gating via eligible_for_posture; returns RecipeCard{id,name,summary,table}. Dispatch op:"applicableRecipes" + the recipe-run cue across routes.rs/commands.rs/app/api/rag/route.ts; twin returns file-derived subset or [] (PARITY), recipe execution {available:false}.
- [x] 2.4 Contracts: Recipe/RecipeCard types + RagService.applicableRecipes (+ real/mock); the run-recipe seam (event or ask cue).

## 3. Surfaces (UI)
- [x] 3.1 RecipesNav.tsx Library gallery (ViewsNav template): applicable recipes listed with "runnable on {table}", row click seeds the recipe ask; mounted in app/page.tsx beside ViewsNav/InvestigationsNav; empty state; Beam tokens both themes. Empty-state recipe chips in ChatPanel beside suggested asks. Twin renders the visible subset honestly.
- [x] 3.2 Evidence-pack plan: verify the N-query plan + ledger already ride composeEvidencePack section (b) via the verbatim footer; add a dedicated "Plan" section only if the verbatim footer is insufficient (document the choice).

## 4. Eval floor
- [x] 4.1 Per-recipe goldens in examples/analytics_eval.rs Section 1 (model-free, CI-gated): a known-series fixture per recipe → deterministic plan → run_query per template → assert expected variance/cohort/dq-audit/anomaly/top-movers numbers. Ledger snapshot as a sibling check (byte-deterministic).

## 5. Verify
- [x] 5.1 E2E (recipes_test.rs / views_test.rs style): variance recipe via the LOCAL path (tables + assumptions, no narration) + a mocked-cloud path (narrated, stamp accurate) + pin the result to a board. Ledger snapshot tests. UI structural: gallery, chips, ledger disclosure.
- [x] 5.2 Full gates: cargo core+server, npm suite, tsc, lint, smoke, analytics + chart eval floors (recipe goldens green on the floor), `openspec validate --all`.
