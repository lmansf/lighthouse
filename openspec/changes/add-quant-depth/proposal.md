# add-quant-depth

## Why

Beam can already turn an aggregate question into one guarded SQL SELECT, and its
deterministic **recipes** (`recipes.rs`) compute variance-vs-last-period, cohort
breakdowns, a data-quality audit, an **anomaly scan** (monthly z-score, the
`z=+2.85` fence), and top-movers — each a bundle of engine-executed SELECTs the
model only narrates. But every one of those looks *backward* at what the data
already says, and every one waits for the user to ask. Two capabilities are
missing:

- **Quant depth (S4).** There is no **forecast** (project a series forward with a
  confidence band), no **changepoint** detection (find where a series shifted
  level), and no **band chart** to draw a projection's interval. The chart
  grammar is a fixed `bar | line | area | none` (plus a `scatter` heuristic) with
  no concept of a lower/upper bound, and the recipe branch draws no chart at all.
- **Proactive insights (S5).** Nothing surfaces a noteworthy finding *without the
  user asking*. The only background mechanism is the pinned-question recheck
  scheduler, which re-runs asks the user already created — it never *discovers* a
  trend, anomaly, or mover on its own.

This change (Phase D of the H-series, after A `add-beam-loop`, B
`add-semantic-layer`, C `add-automation`) adds forward-looking quant depth and an
unprompted insights surface, staying inside the posture the recipes already
established: **every number is engine-computed SQL, never model-generated;**
computation is deterministic and zero-network; the model only narrates; and a
failure degrades to the existing behavior rather than breaking an answer.

The design keeps forecast and changepoint **recipe-shaped** — deterministic
planners returning guarded SELECTs, stamping only the existing `AnalyticsMeta
{sql, file_ids}` — so nothing touches the shared `CachedAnswer` wire shape. The
band chart rides inline in the answer markdown (a ```` ```lighthouse-chart ````
fence), exactly as today's charts do, so it too is off the cached-answer shape.
The result is a **no-`CACHE_VERSION`-bump, no-version-bump** phase.

## What Changes

- **A `forecast` recipe (S4).** A new deterministic builtin that fits a
  **least-squares linear trend** over a series' periods and projects the next N
  periods, with a **prediction band** of ± z·(residual standard deviation) — all
  as guarded SQL (window aggregates over the period index; no model math). It
  applies to a Date + Numeric table (the anomaly-scan applicability). Its result
  table carries, per period, the actual (historical) or the projected point plus
  the band's lower/upper, and it draws a **band chart**. The model narrates the
  slope and the projection in words; every number is the engine's.
- **A `changepoint-scan` recipe (S4).** A new deterministic builtin that finds
  the single most significant **level shift** in a monthly series: over each
  candidate split it computes the before/after means and flags the split that
  maximizes the mean gap normalized by the pooled standard deviation (a
  CUSUM-style max-t split), as guarded SQL. Its result names the changepoint
  period, the before/after means, and the normalized magnitude.
- **A `band` chart kind (S4).** A new `ChartDirectiveKind::Band` (line + a shaded
  interval) added to the chart grammar and — because charts are a **real twin** —
  byte-mirrored in `src/lib/chartSpec.ts` and rendered in `AnalyticsChart.tsx`.
  The chart spec's series shape gains an OPTIONAL lower/upper bound (additive,
  `skip_serializing_if`), so an ordinary line series is unchanged and only a band
  series carries the interval. The recipe branch — which draws no chart today —
  gains the wiring to emit a band chart for the forecast recipe.
- **A proactive insights surface (S5).** A new `lighthouse-core` module
  `insights` exposes `scan(tables) -> Vec<Insight>`: it runs the CHEAP,
  deterministic detectors (the anomaly z-score and top-movers, plus the new
  changepoint) over the cataloged tables, ranks the findings by magnitude, and
  returns a bounded, zero-network list ("October revenue is a +2.85σ anomaly",
  "South is up +400% vs last month"). An `insights` op surfaces them in a
  proactive panel that presents what stands out *without a question*. The scan is
  bounded (cataloged tables only, cheap detectors only, a hard cap on tables
  scanned) and degrades silently per table — an unanalyzable table is skipped,
  never fatal.
- **Twin discipline.** Forecast, changepoint, and insights are DataFusion work,
  so they are **Rust-only** (the `analyticsSql`/analytics branch is already
  Rust-only in the TS twin) — a `docs/ts-twin.md` row and a `PARITY:` note in
  `src/server/synth.ts`; the TS `insights` op returns `[]`. The **band chart**,
  by contrast, is shared chart-grammar behavior and IS twinned byte-for-byte in
  `chartSpec.ts`.

## Capabilities

### New Capabilities

- `quant-forecast`: the `forecast` recipe — a deterministic least-squares linear
  trend projected N periods forward with a ± z·residual-σ prediction band, as
  guarded SQL, drawing a band chart. Model narrates; every number is engine-
  computed. Degrades to a plain answer when the series is too short to fit.
- `quant-changepoint`: the `changepoint-scan` recipe — a deterministic
  normalized-max-split level-shift detector over a monthly series, as guarded
  SQL, naming the changepoint period + before/after means + magnitude.
- `band-chart`: a new `band` chart kind (line + shaded interval) with an additive
  optional lower/upper bound on the chart-spec series shape, twinned byte-for-byte
  in `chartSpec.ts` and rendered in `AnalyticsChart.tsx`; plus the recipe-branch
  chart wiring the forecast recipe needs.
- `proactive-insights`: `insights::scan` + an `insights` op + a proactive panel —
  the cheap deterministic detectors run unprompted over the cataloged tables,
  ranked and bounded and zero-network, surfacing what stands out without the user
  asking. Rust-only (PARITY: the TS op returns `[]`).

## Non-goals

- **No model-authored numbers.** Forecast points, band bounds, changepoint means,
  and insight magnitudes are ALL engine-computed SQL. The model narrates the shape
  in words and never emits a figure — the invariant every recipe already honors.
- **No new statistical wire shape / no `CACHE_VERSION` bump.** Forecast and
  changepoint are recipes that stamp only the existing `AnalyticsMeta{sql,
  file_ids}`; the band chart rides inline in the answer markdown. Nothing changes
  the shared `CachedAnswer`/extract-cache shape, so `CACHE_VERSION` stays at 12
  and the three lockstep sites are untouched.
- **No always-on background insights daemon in v1.** `insights::scan` is computed
  when the proactive surface is shown (and may reuse the existing debounced
  vault-change signal), not by a new always-on CPU loop. Auto-refresh cadence and
  push notifications are a designed follow-on, not v1.
- **No non-linear / seasonal forecasting in v1.** The forecast is a single
  least-squares linear trend with a residual-σ band — deterministic and SQL-
  expressible. Holt-Winters, ARIMA, and seasonal decomposition are out; the recipe
  is the seam to add grains/methods later (like `Period::Month` is today).
- **No multi-changepoint segmentation in v1.** `changepoint-scan` reports the
  single most significant split, not a full segmentation (PELT/binary-seg). One
  split is the honest, cheap v1; multiple is a follow-on.
- **No version bump.** An H-suite phase; it does not move the five version stamps.

## Impact

- **Engine (Rust, ships):**
  - `native/crates/lighthouse-core/src/recipes.rs` — two new builtins in
    `BUILTINS`: `forecast` (`plan_forecast`) and `changepoint-scan`
    (`plan_changepoint`), each a `fn(&ResolvedParams) -> Vec<PlannedQuery>` over
    the existing `Applicability`/`ResolvedParams`/`Period` machinery; new
    `narration_prompt`s. No change to the recipe trigger (`run-recipe:{id} on
    {table}` cue) or the `Recipe` struct.
  - `native/crates/lighthouse-core/src/analytics.rs` — `ChartDirectiveKind::Band`
    + an additive optional bound on the chart-spec series (`chart_spec_from_
    batches*`, `parse_chart_directive`, `validate_directive`, `chart_card`);
    `decide_chart` learns the band kind. PARITY notes updated to name the new kind.
  - `native/crates/lighthouse-core/src/synth.rs` — the recipe branch (`synth.rs`
    ~877–1153) gains band-chart wiring so `forecast` draws its interval; still
    stamps only `AnalyticsMeta{sql, file_ids}`.
  - NEW `native/crates/lighthouse-core/src/insights.rs` — `scan(tables) ->
    Vec<Insight>` running the cheap detectors over the catalog, ranked + bounded +
    zero-network; `pub mod insights;` in `lib.rs`. Reuses the existing recipe
    planners/`run_query`, adds no new SQL primitive.
- **Op surface (for the app):** a new `insights` op (`routes.rs`, `commands.rs`,
  `app/api/rag/route.ts`) returning the ranked findings; a proactive insights
  panel/card in the app (desktop + web dev flow) that presents them unprompted.
  Engine-before-UI: the op lands after `insights::scan`.
- **TS twin (`src/server/`):** the `band` chart kind is twinned byte-for-byte in
  `src/lib/chartSpec.ts` and rendered in `AnalyticsChart.tsx`. Forecast,
  changepoint, and insights are DataFusion work → Rust-only: a PARITY note in
  `src/server/synth.ts` (the analytics branch is already an error/empty there) and
  the TS `insights` op returns `[]`.
- **CI:** new model-free floors ride the already-gated evals — a forecast + a
  changepoint golden in `examples/analytics_eval.rs` (hand-computed fixtures,
  asserting engine numbers), a `band` kind golden in `examples/chart_eval.rs`
  (`native.yml` already runs both `--locked`); `cargo test/build --workspace`
  picks up the new tests and the `insights` module with no workflow edit.
- **Docs:** `docs/ts-twin.md` — extend the analytics Rust-only row to name the
  forecast/changepoint recipes + `insights`, and confirm the band chart is a real
  `chartSpec.ts` twin. `docs/data-flows.md` — note that `insights::scan` is
  on-device SQL over already-cataloged tables (zero network, no new egress path);
  forecast/changepoint egress exactly as any recipe narration does under the
  configured provider.
- **No `CACHE_VERSION` bump** (12 → 12; recipe-shaped, band inline) and **no
  version bump** (stays on the current line; the five stamps do not move).
