# Design — add-quant-depth

## Context

The recipes framework (`recipes.rs`) is the seam this change extends. A `Recipe`
is a pure planner — `plan: fn(&ResolvedParams) -> Vec<PlannedQuery>` — returning a
bundle of single guarded `SELECT`s that `analytics::run_query` executes; the model
receives the rendered result tables + a `narration_prompt` and describes them in
words, emitting no numbers. Recipes are triggered by an explicit structured cue
(`run-recipe:{id} on {table}`), not NL classification, and today stamp only
`AnalyticsMeta{sql, file_ids}` on the final chunk. The existing `anomaly-scan`
already proves the pattern for statistics-as-SQL: it computes a monthly series,
its mean and `STDDEV`, and flags points past a 2σ fence — all in DataFusion.

Forecast and changepoint are the same shape: deterministic statistics expressed
as guarded SQL over a Date + Numeric table, narrated but never computed by the
model. This keeps the whole change on the recipe rails — no new intent
classifier, no new result wire shape, no `CACHE_VERSION` move.

## The forecast recipe (`forecast`)

**Method (v1): ordinary least-squares linear trend + a residual-σ prediction
band.** Deterministic, closed-form, and fully SQL-expressible — no iterative
solver, no model math.

Let the historical series be the monthly totals `y_i` at integer period index
`t_i = 0,1,…,n-1` (the same monthly rollup `anomaly-scan` builds). The fit is:

```
b (slope)     = ( n·Σ(t·y) − Σt·Σy ) / ( n·Σ(t²) − (Σt)² )
a (intercept) = ( Σy − b·Σt ) / n
ŷ_i           = a + b·t_i
residual σ     = sqrt( Σ(y_i − ŷ_i)² / (n − 2) )         // n ≥ 3
```

Every term is a plain aggregate (`SUM`, `COUNT`) over the period-indexed series,
so the fit is ONE grouped SELECT feeding a projection SELECT. The projected point
for a future index `t_k` is `ŷ_k = a + b·t_k`; the band is `ŷ_k ± z·σ` with a
fixed `z` (design constant `Z_FORECAST = 1.96`, the ~95% normal quantile, named in
code with the same "engine constant, not model text" discipline as the anomaly
fence). Horizon `H` periods (design constant, small — `FORECAST_HORIZON = 3`).

The result table is one row per period with columns `period`, `kind`
(`actual`/`forecast`), `value` (actual `y_i` for history, `ŷ_k` for the horizon),
`lower`, `upper` (band bounds, NULL on historical rows). The recipe draws a **band
chart** off this table (see below). The narration prompt tells the model to state
the direction and rate of the trend and the projected next value in words, citing
the engine's figures — never inventing one.

**Guardrails / degradation:**
- **Too short to fit.** `n < 3` (need ≥ 3 points for a slope + a residual σ with
  `n−2` d.o.f.) → the recipe returns a plain "not enough history to forecast (need
  at least 3 periods)" answer with the series it does have. It degrades to a
  description, never errors — the recipes' "failures degrade" rule.
- **Flat/degenerate denominator.** If `n·Σ(t²) − (Σt)² = 0` (only possible when
  `n < 2`, already excluded) the fit is undefined; the `n ≥ 3` guard covers it.
- **Zero residual (perfect line).** `σ = 0` → the band collapses to the line
  (lower = upper = point); the band chart still renders, just with no shaded area.
  Honest: a perfectly linear history projects with no modeled spread.

## The changepoint recipe (`changepoint-scan`)

**Method (v1): the single most significant level shift, by normalized max-split.**
Over the monthly series `y_0..y_{n-1}`, for each interior split `k` (1 ≤ k ≤ n−1)
compute the mean before (`μ_L` over `0..k`) and after (`μ_R` over `k..n`), and
score the split by the mean gap normalized by the pooled standard deviation:

```
score(k) = |μ_R − μ_L| / ( σ_pooled + ε )
```

The reported changepoint is `argmax_k score(k)`. All of it is SQL: a windowed
prefix/suffix mean per candidate split (cumulative `SUM`/`COUNT` via `ROWS
BETWEEN UNBOUNDED PRECEDING`) and a final `ORDER BY score DESC LIMIT 1`. The
result names the changepoint period, `μ_L`, `μ_R`, the delta, and the normalized
magnitude. The narration prompt asks the model to state where and by how much the
series shifted, in words, using the engine's means.

**Guardrails / degradation:**
- `n < 4` (need ≥ 2 points on each side to have two means) → "not enough history
  to locate a shift" plain answer. Degrades, never errors.
- Flat series (`σ_pooled` ≈ 0 everywhere) → the `+ ε` keeps the score finite; the
  top split is reported with a near-zero magnitude and the narration honestly says
  "no material level shift" (the engine's magnitude, not a model judgment call).

## The `band` chart kind

Charts ride inline as a ```` ```lighthouse-chart ```` fence carrying a spec JSON;
they are NOT a cached-answer field, so a new kind does not touch `CACHE_VERSION`.
The current spec is `{kind, x[], series:[{name, values[]}], stacked?, subtitle?}`
with `kind ∈ bar|line|area|scatter`, and a directive grammar
`ChartDirectiveKind ∈ Bar|Line|Area|None`.

**Change (additive):**
- `ChartDirectiveKind::Band` (Rust) / `"band"` (`ChartDirectiveKind` +
  `ChartKind` in `chartSpec.ts`).
- A band **series** gains two OPTIONAL bound arrays: `lower?: number[]`,
  `upper?: number[]` (Rust `#[serde(skip_serializing_if = "Option::is_none")]`,
  TS `?`). An ordinary line/bar/area series serializes byte-identically to today
  (the fields are absent), so no existing chart or fixture changes. A `band` spec
  has one primary series with `values` (the line) plus `lower`/`upper` (the shaded
  interval). `validate_directive`/`validateDirective` require `lower`/`upper` to
  match `values` in length for a `band` and reject a `band` that lacks them
  (degrade: an invalid directive falls through to the heuristic, which never emits
  `band`, so a malformed band chart simply becomes a plain line — never a broken
  render).
- `AnalyticsChart.tsx` renders `band` as a line with a filled area between
  `lower` and `upper` (theme-aware, low-opacity fill), reusing the existing
  axis/legend machinery.
- `chart_card` (the prompt block that teaches the model the kinds) gains one line
  for `band`, but since the forecast recipe emits the band **directive itself**
  (engine-authored, not model-chosen), the model never has to pick `band`.

**Recipe-branch chart wiring.** The recipe branch (`synth.rs` ~877–1153) draws no
chart today. This change adds: after a recipe's queries run, if the recipe
declares a chart (a new optional `chart: Option<fn(&[QueryResult]) ->
Option<String>>` on `Recipe`, `None` for the existing five), build the directed
spec and emit the same ```` ```lighthouse-chart ```` fence the analytics branch
emits at `synth.rs:1978`. Only `forecast` sets it in v1. The existing recipes are
unchanged (their `chart` is `None`).

## Proactive insights (`insights::scan`) — S5

A new pure module `insights.rs`: `scan(tables: &[TableRef]) -> Vec<Insight>`.

- For each cataloged table (from `catalog`), if it has a Date + Numeric shape,
  run the CHEAP deterministic detectors already in `recipes.rs` — `anomaly-scan`
  and `top-movers`, plus the new `changepoint-scan` — via `run_query`, and turn a
  material finding into an `Insight { table, kind, headline, magnitude, sql }`.
  Everything is engine-computed SQL; the `headline` is a template filled with
  engine numbers (e.g. `"{table}: {period} is a {z}σ anomaly"`), NOT model text.
- **Ranked + bounded.** Findings sort by `magnitude` desc; the scan is capped at
  `INSIGHTS_MAX_TABLES` cataloged tables and `INSIGHTS_MAX` returned findings
  (design constants) so a large vault never turns the panel into an unbounded
  compute. Tables are visited in catalog order; the cap is disclosed (a
  `"…and N more tables not scanned"` note), never a silent truncation — the
  "no silent caps" discipline.
- **Zero-network, on-device.** All SQL over DataFusion; no provider call, no model
  in the loop (headlines are templates). `insights::scan` egresses nothing.
- **Degrades per table.** A table that fails to analyze (no Date/Numeric column,
  an extraction gap, a SQL error) is SKIPPED silently — one bad table never fails
  the scan or the panel. An empty result is a valid, honest "nothing stands out."

The `insights` op returns the ranked list; the app renders a proactive panel that
presents it **without the user asking a question** — that is the whole point of
S5. v1 computes on show (and may reuse the existing debounced vault-change signal
the recheck scheduler already emits), not via a new always-on loop.

## Rust / TS parity decisions

- **Forecast, changepoint, insights are Rust-only** (PARITY-diverged). They are
  DataFusion work, and the TS twin already degrades the entire analytics branch to
  an error/empty (`docs/ts-twin.md`: `analyticsSql` returns an error; chat never
  takes the analytics branch). So: a `PARITY:` note in `src/server/synth.ts` beside
  the existing recipe/analytics notes, and the TS `insights` op returns `[]`
  (honest empty, never a fake finding). `docs/ts-twin.md`'s analytics row is
  extended to name them. No `src/server` implementation.
- **The band chart IS twinned** (mirrored). Chart spec parsing/validation is a real
  twin (`analytics.rs` ⇄ `src/lib/chartSpec.ts`, with existing `PARITY:` cross-
  references). The new `band` kind + the optional `lower`/`upper` bound land in
  BOTH, byte-compatibly, and `AnalyticsChart.tsx` renders it. The chart-spec
  fixtures pinned in both suites gain a `band` case on both sides.
- **No new persisted/twinned store.** Insights are computed on demand, not stored;
  no `{v:N}` envelope, no new settings field (`settings.rs`/`settings_test.rs`
  untouched).

## Failure & local-window degradation

- **Local model 6144-token window.** Computation is model-free SQL; the model only
  narrates. The forecast/changepoint result tables are tiny (history length +
  ≤ 3 horizon rows; one changepoint row), well under the window — the narration
  prompt passes a handful of rows, not raw data. Insights headlines are templated
  (no model call at all for the panel). So none of this pressures the 6144-token
  budget; the existing recipe narration already lives comfortably there.
- **Analytics-off / no real model.** The recipe cue path runs on any provider
  (it's model-free compute + optional narration), exactly as the existing
  recipes; with the extractive fallback the result tables still render and the
  "narration" is the deterministic summary. Insights never needs a model.
- **Every failure degrades, never breaks.** Short series → a plain descriptive
  answer; an unanalyzable table → skipped from the scan; an invalid band directive
  → falls through to a plain line. No path turns a missing forecast into a broken
  answer — the analytics-degrades-to-retrieval rule, applied to quant depth.

## No version / no CACHE_VERSION bump

- **`CACHE_VERSION` stays 12.** Forecast and changepoint are recipes that stamp
  only the existing `AnalyticsMeta{sql, file_ids}` — no new field on
  `AnalyticsMeta`/`ChunkMeta`/`CachedAnswer`. The band chart rides inline in the
  answer markdown (not a cached field). Insights are computed on demand and not
  cached. Nothing touches the shared extract/answer cache wire shape, so the three
  lockstep sites (`extract.rs`, `src/server/extract.ts`, `extract_test.rs`) do not
  move — unlike the beam-loop cost-meter (v9→10) and semantic certified/trust
  (v11→12) changes, which DID add cached-answer fields.
- **No version bump.** An H-suite phase; the five version stamps stay put, per the
  A/B/C precedent.
