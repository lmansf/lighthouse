# add-recipes — design

## The recipe object

```
Recipe {
  id: &'static str          // built-in, stable
  name: &'static str
  summary: &'static str     // one line for the gallery/chip
  // Applicability: what the catalog must offer for this recipe to run.
  needs: Applicability { numeric: bool, date: bool, text: bool }
  // Parameters resolved deterministically from the catalog + the ask:
  params: RecipeParams { table, date_col?, metric?, group_col?, period? }
  // Bounded plan: N SQL TEMPLATES expanded from resolved params. No model.
  plan: fn(&ResolvedParams) -> Vec<PlannedQuery>   // PlannedQuery { label, sql }
  narration_prompt: &'static str                    // used only when a model is present
}
```

Recipes are **built-in descriptors in `recipes.rs`** (no store — v1 has no
user-authored recipes). The five built-ins:

- **variance-vs-last-period**: needs date + numeric. Plan: current-period
  total, prior-period total, delta + %; boundaries from the metric's date
  column and the chosen period (month/quarter default inferred from the
  date grain).
- **cohort-breakdown**: needs a group/text column + numeric. Plan: metric by
  group, ordered; share-of-total.
- **data-quality-audit**: needs any table. Plan (per column): null count +
  %, distinct/duplicate count, type-anomaly count (values that don't parse
  as the inferred kind), outlier count (IQR fence) for numeric columns.
- **anomaly-scan**: needs date + numeric. Plan: windowed mean/stddev over the
  dated metric, points beyond a z-score/IQR fence flagged with their window.
- **top-movers**: needs a group column + numeric + (date for period-over-
  period, else rank by magnitude). Plan: per-group change vs prior period,
  sorted by absolute move, top N.

Every template is a single guarded SELECT. The planner is a pure function of
the resolved parameters — **the same catalog + params always produce the same
N queries**, so a recipe is deterministic and golden-testable.

## Execution — reuse the model-free executor, run on every provider

`synth.rs` gains a **recipe branch placed BEFORE the `has_real_model` gate**
(synth.rs:717), so it runs on cloud, local, AND extractive providers. It:

1. Resolves the recipe + parameters against the catalog (`columns_for` +
   view columns; Risk-4: NO dependence on narration output).
2. Expands the plan → `Vec<PlannedQuery>`.
3. Executes each template through the SAME model-free path a single query
   uses: `run_query`(guard + execute + cap + count) into `StepRecord`s. This
   is exactly the multi-step accumulator (synth.rs:812) minus the model
   planning — the reusable executor + `StepRecord` shape are lifted verbatim.
4. Emits the results + the provenance footer (`*Queries used (N):*` — the
   multi-step footer at synth.rs:892-912 already lists every executed query),
   one freshness stamp over the union (`expand_views_for_freshness` +
   `freshness_line`), row-cap footer, and the assumption ledger (below).
5. **Narration is skippable.** When a model is present, one
   `collect(stream_answer)` narrates over the step results (never raw tables)
   using `narration_prompt`. When the provider is extractive/no-model, the
   answer is tables + footers + ledger with NO prose — the branch's footer
   and final-chunk emission never depend on any narration output.

`AnalyticsMeta { sql, file_ids }` carries the recipe's REPRESENTATIVE query
(the primary result template) so pin/board/save/Edit-SQL keep working — the
same single-SQL limitation multi-step already has (synth.rs:950); a
structured-plan pin field is a deferred follow-on (RiskS-2). The evidence
pack renders the full N-query plan because it already renders the
`*Queries used (N):*` footer verbatim.

## Assumption ledger — engine-derived, on ALL Beam answers

The ledger is an `*Assumptions:*` label + bullet list emitted as **markdown
in the answer text**, right beside the "Query used"/"Computed from" footers,
and folded into a native `<details>` disclosure client-side by extending
`remarkAnswerCard`/`isFooterish` (the exact machinery that already folds the
SQL footer). It rides in the cached answer text for free (answer_cache stores
footers verbatim). This satisfies "rides the same answer meta as the
provenance stamp" — it travels with the answer alongside the stamp.

**Derivation is 100% engine-side, never model text:**

- **Recipe answers**: entries come from the resolved parameters directly
  (date column, period boundaries, metric, group, window size, fences).
- **Ad-hoc analytics answers** (single-query + multi-step): derive by parsing
  the executed SQL. `views.rs` already has a full sqlparser AST walker
  (`TableWalk`/`walk_query`/`collect_table_names`); the ledger extends it to
  also read, from the same `Select` node:
  - `s.projection` → aggregates (SUM/AVG/COUNT/MIN/MAX) ⇒ "null cells skipped
    by {agg}" honesty; the metric column(s).
  - `s.group_by` → the group-by columns ⇒ "grouped by {cols}".
  - `s.selection` (WHERE) → the filters applied ⇒ "filtered where {predicate}".
  - date column: the projection/group-by column whose catalog `ColumnKind`
    is `Date` (or a `substr(CAST(... ))` month-bucket, the analytics idiom).
  - rows considered: from `QueryResult` (the row count + whether truncated —
    "considered N rows" / "first N of M shown"). This is already computed.
  Same `DFParser` as `guard_sql`, so the ledger can never disagree with the
  guard about what the SQL says.

Every entry is a plain, deterministic sentence. The model contributes
NOTHING — a test asserts the ledger over a fixed SQL is byte-stable.

**Ledger is opt-in-free and universal**: every analytics answer gets one; a
non-analytics prose answer (no SQL) gets none (nothing to derive).

## Applicability — recipe predicates over the catalog

`meta.rs` gains `applicable_recipes(included, is_cloud) -> Vec<RecipeCard>`
mirroring `suggested_asks_resolved` exactly: evaluate each built-in's `needs`
predicate against `columns_for(files)` ∪ each view's `view_typed_columns`
(H3), returning the applicable recipes with the table/view they run on. Views
are tables too — a recipe "runnable on clean_sales" is offered when the view
resolves. Posture gating (local-only views excluded on cloud) comes free from
reusing `eligible_for_posture`/`register_views`.

## Surfaces

- **Library gallery**: NEW `RecipesNav.tsx`, a sidebar section (the
  `ViewsNav.tsx` template — `<nav aria-label>`, session store, rows), mounted
  in `app/page.tsx` beside ViewsNav/InvestigationsNav. Each row shows the
  recipe name + "runnable on {table}" (from `applicable_recipes`); clicking
  dispatches the ask that runs it (a `lighthouse:run-recipe` event or the
  existing `lighthouse:ask-question` seam with a recipe-cued question).
- **Empty-state chips**: the chat empty state already renders suggested-ask
  chips (ChatPanel.tsx ~:3603 via `ragService.suggestedAsks`); add applicable
  recipe chips alongside, from a new `applicableRecipes` op.
- **Pin/board/pack**: recipe results flow through `RefineChips` +
  `AnalyticsMeta` like any answer (representative query pinned).
- **Evidence pack**: the plan rides section (b) via the verbatim
  `*Queries used (N):*` footer; the ledger rides it too (folded flat there).

## How a recipe is invoked from an ask

A recipe chip/gallery row seeds the chat with a recipe-cued question. The
ask path detects the recipe cue (a stable prefix / structured hint on the
question, e.g. `run-recipe:{id} on {table}`) BEFORE the analytics branch and
routes to the recipe executor. A plain NL question never accidentally
triggers a recipe — the cue is explicit (chip/gallery-originated), not
guessed from prose (deterministic before model).

## Rust/TS parity

- `recipes.rs` is Rust-only (analytics). `meta::applicable_recipes` executes
  (registers tables to read view columns) — Rust-only; the twin's
  `applicableRecipes` returns the file-derived subset it can compute
  statically, or `[]` with a PARITY comment, and `op:"recipes"` execution is
  `{available:false}` on the twin (the suggestedAsks/shapeView precedent).
- The ledger derivation is Rust-only (it parses SQL via DFParser). The twin
  emits no ledger (it never runs analytics); PARITY comment.
- UI (RecipesNav, chips, the ledger disclosure) is client-shared.

## Failure & degradation

- A recipe whose applicability no longer holds (column removed) simply isn't
  offered; if invoked stale, it fails with an honest "this recipe needs a
  date and a numeric column" message — no partial garbage.
- A template that errors at execution drops that step and continues (the
  multi-step per-step tolerance); the footer lists only executed queries.
- Extractive provider: tables + footers + ledger, no narration (by design).
- 6144-token local window: recipe planning is model-free, so the local
  window is irrelevant to planning; narration (if the local model is present)
  sees step results only, exactly like multi-step's local posture.
- Ledger over un-parseable SQL: the ledger degrades to the entries it can
  derive (rows considered, caps) and omits what it can't — never fabricates.
