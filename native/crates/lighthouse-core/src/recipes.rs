//! Deterministic analysis recipes (openspec: add-recipes §2).
//!
//! A recipe is a named, parameterized bundle of guarded SELECT templates whose
//! plan is a PURE FUNCTION of the resolved parameters — no model is consulted to
//! plan it, so the same catalog + params always expand to byte-identical SQL.
//! Execution reuses the model-free analytics executor (`analytics::run_query` +
//! the `guard_sql` single-SELECT gate), so every number a recipe reports is
//! computed by DataFusion over the vault's own bytes; the model only ever
//! narrates already-computed results (and narration is skippable — the
//! extractive fallback renders tables + footers with no prose).
//!
//! v1 shipped FIVE built-ins; add-quant-depth (§2/§3) adds two more — `forecast`
//! and `changepoint-scan` — for SEVEN, still with NO user-authored recipes: the
//! descriptor + planner below is the extension seam, not a creation surface.
//!
//! PARITY: Rust-only, like the rest of analytics (`analytics.rs`, `catalog.rs`).
//! The TS twin never takes the analytics branch, so it surfaces recipe
//! VISIBILITY (`applicableRecipes` → the file-derived subset or `[]`) but
//! answers `{available:false}` on execution — noted in `src/server/synth.ts`
//! and the route twin.

use crate::catalog::ColumnKind;

/// What the catalog must offer for a recipe to be applicable. Each `true` flag
/// demands at least one column of that kind in the target table/view; a recipe
/// with every flag `false` (the data-quality audit) runs on any table.
#[derive(Debug, Clone, Copy)]
pub struct Applicability {
    pub numeric: bool,
    pub date: bool,
    pub text: bool,
}

impl Applicability {
    /// Whether the typed column set satisfies this predicate — one column of
    /// each demanded kind. Kinds are the catalog's coarse `ColumnKind` (the same
    /// source `suggested_asks`/`applicable_recipes` evaluate against, so what a
    /// recipe is OFFERED on and what it RESOLVES on never disagree).
    pub fn satisfied_by(&self, cols: &[(String, ColumnKind)]) -> bool {
        let has = |k: ColumnKind| cols.iter().any(|(_, c)| *c == k);
        (!self.numeric || has(ColumnKind::Numeric))
            && (!self.date || has(ColumnKind::Date))
            && (!self.text || has(ColumnKind::Text))
    }

    /// Human phrase for the honest "this recipe needs …" degradation message
    /// (design.md "Failure & degradation"): named in a fixed order, "any table"
    /// when nothing is demanded.
    pub fn describe(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if self.date {
            parts.push("a date column");
        }
        if self.numeric {
            parts.push("a numeric column");
        }
        if self.text {
            parts.push("a text/group column");
        }
        match parts.len() {
            0 => "any table".to_string(),
            1 => parts[0].to_string(),
            _ => {
                let last = parts.pop().unwrap();
                format!("{} and {}", parts.join(", "), last)
            }
        }
    }
}

/// The period grain a recipe buckets a date column into. v1 uses month
/// exclusively (the `substr(col, 1, 7)` idiom the analytics few-shots use and
/// the ledger recognizes); the enum is the grain seam for later grains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Month,
}

/// One built-in recipe descriptor. Static and stable: `id` is the wire-stable
/// key the run cue (`run-recipe:{id} on {table}`) names. `plan` is a pure
/// function pointer — same `ResolvedParams` ⇒ same SQL every call.
#[derive(Debug, Clone, Copy)]
pub struct Recipe {
    pub id: &'static str,
    pub name: &'static str,
    pub summary: &'static str,
    pub needs: Applicability,
    /// Used ONLY when a model is present (narration is skippable): narrates over
    /// the already-computed step results, never over raw tables, and can supply
    /// no number.
    pub narration_prompt: &'static str,
    /// Deterministic planner: resolved params → a bounded list of single guarded
    /// SELECTs. No model, no clock, no catalog re-read — a pure function.
    pub plan: fn(&ResolvedParams) -> Vec<PlannedQuery>,
}

impl Recipe {
    /// Whether this recipe is applicable to a typed column set.
    pub fn applicable(&self, cols: &[(String, ColumnKind)]) -> bool {
        self.needs.satisfied_by(cols)
    }

    /// Resolve concrete parameters from the target table's typed columns,
    /// deterministically: the date/metric/group columns are the FIRST of each
    /// kind in catalog column order (a stable tie-break). Returns `None` when the
    /// applicability predicate isn't met (a stale invocation), so the executor
    /// degrades with an honest message instead of planning garbage.
    pub fn resolve(&self, table: &str, cols: &[(String, ColumnKind)]) -> Option<ResolvedParams> {
        if !self.applicable(cols) {
            return None;
        }
        let first = |k: ColumnKind| {
            cols.iter()
                .find(|(_, c)| *c == k)
                .map(|(n, _)| n.clone())
        };
        Some(ResolvedParams {
            table: table.to_string(),
            date_col: first(ColumnKind::Date),
            metric: first(ColumnKind::Numeric),
            group_col: first(ColumnKind::Text),
            period: Period::Month,
            columns: cols.to_vec(),
        })
    }

    /// The ENGINE-authored chart for this recipe's representative result (plan[0]),
    /// if any (add-quant-depth §2.3). Only `forecast` draws one — a `band` over its
    /// actual-then-projected series — built from the executed batches via the
    /// directive path, so the chart's numbers are the engine's, never the model's.
    /// Every other recipe returns `None` (they emit no chart). The band kind and
    /// the bound columns are validated inside `chart_spec_from_batches_directed`;
    /// an unexpected shape simply yields `None` (no chart, no error).
    pub fn chart(&self, res: &crate::analytics::QueryResult) -> Option<String> {
        match self.id {
            "forecast" => forecast_band_chart(res),
            _ => None,
        }
    }
}

/// Build the forecast's `band` chart from its representative result (the unified
/// `period, kind, value, lower, upper` series). The directive names the bound
/// columns; `chart_spec_from_batches_directed` reads every value from the batches.
fn forecast_band_chart(res: &crate::analytics::QueryResult) -> Option<String> {
    let directive = crate::analytics::ChartDirective {
        kind: crate::analytics::ChartDirectiveKind::Band,
        label_column: "period".to_string(),
        series_columns: vec!["value".to_string()],
        lower_column: Some("lower".to_string()),
        upper_column: Some("upper".to_string()),
        title: None,
        sort: None,
    };
    crate::analytics::chart_spec_from_batches_directed(&res.batches, &directive)
}

/// The concrete columns a recipe run resolved from the catalog. Carries the full
/// typed column set (`columns`) so a whole-table recipe (the data-quality audit)
/// can iterate every column, alongside the picked date/metric/group.
#[derive(Debug, Clone)]
pub struct ResolvedParams {
    pub table: String,
    pub date_col: Option<String>,
    pub metric: Option<String>,
    pub group_col: Option<String>,
    pub period: Period,
    pub columns: Vec<(String, ColumnKind)>,
}

/// One planned query: a human label for the provenance footer + a single
/// read-only SELECT that MUST pass `analytics::guard_sql` (a unit test asserts
/// this for every built-in against fixtures).
#[derive(Debug, Clone)]
pub struct PlannedQuery {
    pub label: String,
    pub sql: String,
}

/// The parsed recipe run cue: an EXPLICIT structured prefix a chip/gallery row
/// seeds the chat with. A plain natural-language question never carries it, so a
/// recipe never triggers by accident (design.md "How a recipe is invoked").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipeCue {
    pub id: String,
    pub table: String,
}

/// The stable run-cue prefix. The full seam is `run-recipe:{id} on {table}`;
/// `{table}` is the file display name or view name `applicable_recipes` returned.
pub const RECIPE_CUE_PREFIX: &str = "run-recipe:";

/// Detect the recipe run cue on a question. `Some` only for the exact
/// `run-recipe:{id} on {table}` shape naming a KNOWN built-in — everything else
/// (including a natural question that merely mentions "recipe") is `None`, so the
/// executor branch never fires on prose.
pub fn parse_recipe_cue(question: &str) -> Option<RecipeCue> {
    let rest = question.trim().strip_prefix(RECIPE_CUE_PREFIX)?;
    // Built-in ids are kebab-case (no spaces), so the FIRST " on " reliably
    // splits the id from a table name that may itself contain spaces.
    let (id, table) = rest.split_once(" on ")?;
    let id = id.trim();
    let table = table.trim();
    if id.is_empty() || table.is_empty() || lookup(id).is_none() {
        return None;
    }
    Some(RecipeCue {
        id: id.to_string(),
        table: table.to_string(),
    })
}

/// The built-in with this id, if any.
pub fn lookup(id: &str) -> Option<&'static Recipe> {
    BUILTINS.iter().find(|r| r.id == id)
}

/// The built-in recipes (design.md "The recipe object"): the original five plus
/// the two add-quant-depth quant recipes (`forecast`, `changepoint-scan`).
pub const BUILTINS: &[Recipe] = &[
    Recipe {
        id: "variance-vs-last-period",
        name: "Variance vs last period",
        summary: "How the latest month's total moved versus the prior month.",
        needs: Applicability { numeric: true, date: true, text: false },
        narration_prompt:
            "Summarize how the metric changed from the prior period to the latest period. \
             State the latest total, the prior total, the delta and the percent change, \
             using ONLY the numbers in the query results. Do not invent or recompute any figure.",
        plan: plan_variance,
    },
    Recipe {
        id: "cohort-breakdown",
        name: "Cohort breakdown",
        summary: "The metric split by group, ranked, with each group's share of the total.",
        needs: Applicability { numeric: true, date: false, text: true },
        narration_prompt:
            "Summarize how the metric breaks down across the groups: name the largest groups \
             and their share of the total, using ONLY the numbers in the query results. \
             Do not invent or recompute any figure.",
        plan: plan_cohort,
    },
    Recipe {
        id: "data-quality-audit",
        name: "Data-quality audit",
        summary: "Per-column null counts, distinct/duplicate counts, and numeric IQR outliers.",
        needs: Applicability { numeric: false, date: false, text: false },
        narration_prompt:
            "Summarize the data-quality findings: which columns have the most nulls or \
             duplicates, and any numeric outliers, using ONLY the numbers in the query \
             results. Do not invent or recompute any figure.",
        plan: plan_data_quality,
    },
    Recipe {
        id: "anomaly-scan",
        name: "Anomaly scan",
        summary: "Months whose total lands beyond a 2-sigma fence of the dated metric.",
        needs: Applicability { numeric: true, date: true, text: false },
        narration_prompt:
            "Summarize which periods are anomalous and by how much (their z-score), using \
             ONLY the numbers in the query results. If none are flagged, say the series looks \
             stable. Do not invent or recompute any figure.",
        plan: plan_anomaly,
    },
    Recipe {
        id: "top-movers",
        name: "Top movers",
        summary: "The groups that moved most versus the prior period (or by magnitude).",
        needs: Applicability { numeric: true, date: false, text: true },
        narration_prompt:
            "Summarize which groups moved the most and in which direction, using ONLY the \
             numbers in the query results. Do not invent or recompute any figure.",
        plan: plan_top_movers,
    },
    // add-quant-depth §2/§3: two deterministic quant recipes. Both need Date +
    // Numeric and both express their whole method (OLS fit / max-split scan) as
    // guarded SQL — no Rust-side math — so the model still only ever narrates.
    Recipe {
        id: "forecast",
        name: "Forecast",
        summary: "A least-squares trend projected three months ahead with a prediction band.",
        needs: Applicability { numeric: true, date: true, text: false },
        narration_prompt:
            "Summarize the trend and its projection: state the direction and rate of the \
             trend (rising or falling, and by roughly how much per month) and the projected \
             next value with its band, using ONLY the numbers in the query results. If the \
             history is too short to project (no forecast rows), say the series is too short \
             to forecast and describe just the history. Do not invent or recompute any figure.",
        plan: plan_forecast,
    },
    Recipe {
        id: "changepoint-scan",
        name: "Changepoint scan",
        summary: "The single most significant level shift in the dated metric's monthly series.",
        needs: Applicability { numeric: true, date: true, text: false },
        narration_prompt:
            "Summarize where and by how much the series shifted: name the changepoint period \
             and the mean before versus after it, using ONLY the numbers in the query results. \
             If no shift was located (no rows), say there is not enough history to locate a \
             shift; if the magnitude is near zero, say there is no material level shift. \
             Do not invent or recompute any figure.",
        plan: plan_changepoint,
    },
];

// --- Planners (pure; each PlannedQuery.sql is one guarded SELECT) -----------------
//
// Identifiers interpolate bare: catalog + registration sanitize every table and
// column name to `[a-z0-9_]` with a safe first char (analytics::sanitize_table_
// name / catalog::sanitize_column), so these read exactly like the analytics
// few-shots (`SUM(amount)`, `substr(order_date, 1, 7)`) with no quoting. A
// numeric-kind column registers as Float64/Int64 (CSV inference, parquet native,
// workbook typing), so bare `SUM(metric)` is well-typed; a catalog date column
// arrives as ISO text, so the `substr(col, 1, 7)` month bucket is the idiom (the
// same one the ledger recognizes to name the date column).

/// Most columns a data-quality completeness scan reports on (one UNION arm each).
const DQ_MAX_COLS: usize = 40;
/// Most numeric columns the IQR-outlier scan covers (one query each).
const DQ_IQR_MAX: usize = 4;
/// Rank/top-N cap for the movers recipe.
const MOVERS_TOP_N: usize = 20;

// --- add-quant-depth engine constants (the anomaly-fence discipline: fixed
// statistical magnitudes named in code, never model text) --------------------
/// Band z-multiplier for the forecast: the ~95% normal quantile.
const Z_FORECAST: f64 = 1.96;
/// How many periods past the history the forecast projects.
const FORECAST_HORIZON: i64 = 3;
/// Minimum series length for an OLS fit — a slope needs ≥ 2 points and the
/// residual σ needs `n − 2 ≥ 1` d.o.f., so ≥ 3. Below it the SQL emits zero
/// forecast rows (history only); the recipe degrades, never errors.
const FORECAST_MIN_POINTS: i64 = 3;
/// Minimum series length to locate a level shift — two points on each side of an
/// interior split. Below it the scan returns no rows (an honest "not enough
/// history", surfaced as the executor's "no rows").
const CHANGEPOINT_MIN_POINTS: i64 = 4;
/// Denominator floor keeping the changepoint score finite on a flat series
/// (`σ_pooled = 0` ⇒ a near-zero, honest magnitude, not a divide-by-zero).
const CHANGEPOINT_EPSILON: f64 = 1e-9;

/// The month bucket for an ISO date column — the analytics idiom, CAST-first so
/// it is robust to the column's registered type. `register_csv` infers an
/// ISO-date CSV column as `Date32` (only the workbook path arrives as Utf8
/// text), and `substr` requires a string — so bare `substr(date, 1, 7)` fails on
/// the common CSV case. `CAST(date AS VARCHAR)` renders both Date32 and Utf8 to
/// the same `YYYY-MM-DD` text, and the §1 ledger's month-bucket detector already
/// reads through the CAST to name the date column.
fn month_bucket(date_col: &str) -> String {
    format!("substr(CAST({date_col} AS VARCHAR), 1, 7)")
}

fn plan_variance(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let (Some(date), Some(metric)) = (p.date_col.as_deref(), p.metric.as_deref()) else {
        return Vec::new();
    };
    let t = &p.table;
    let m = month_bucket(date);
    vec![
        PlannedQuery {
            label: "Latest period vs prior period".to_string(),
            // One guarded SELECT: bucket to months, rank newest-first, then the
            // top two rows become current/prior totals with the delta + percent.
            sql: format!(
                "WITH periods AS (SELECT {m} AS period, SUM({metric}) AS total FROM {t} GROUP BY {m}), \
                 ranked AS (SELECT period, total, ROW_NUMBER() OVER (ORDER BY period DESC) AS rn FROM periods) \
                 SELECT MAX(CASE WHEN rn = 1 THEN period END) AS current_period, \
                 MAX(CASE WHEN rn = 1 THEN total END) AS current_total, \
                 MAX(CASE WHEN rn = 2 THEN period END) AS prior_period, \
                 MAX(CASE WHEN rn = 2 THEN total END) AS prior_total, \
                 MAX(CASE WHEN rn = 1 THEN total END) - MAX(CASE WHEN rn = 2 THEN total END) AS delta, \
                 ROUND(100.0 * (MAX(CASE WHEN rn = 1 THEN total END) - MAX(CASE WHEN rn = 2 THEN total END)) \
                 / NULLIF(MAX(CASE WHEN rn = 2 THEN total END), 0), 1) AS pct_change \
                 FROM ranked"
            ),
        },
        PlannedQuery {
            label: "Monthly totals".to_string(),
            sql: format!(
                "SELECT {m} AS period, SUM({metric}) AS total FROM {t} GROUP BY {m} ORDER BY period"
            ),
        },
    ]
}

fn plan_cohort(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let (Some(group), Some(metric)) = (p.group_col.as_deref(), p.metric.as_deref()) else {
        return Vec::new();
    };
    let t = &p.table;
    vec![
        PlannedQuery {
            label: "Metric by cohort with share of total".to_string(),
            // Share-of-total is the windowed-sum-over-grouped-sum idiom from the
            // analytics few-shots (SUM(SUM(x)) OVER ()).
            sql: format!(
                "SELECT {group} AS cohort, SUM({metric}) AS total, \
                 ROUND(100.0 * SUM({metric}) / NULLIF(SUM(SUM({metric})) OVER (), 0), 1) AS pct_of_total \
                 FROM {t} GROUP BY {group} ORDER BY total DESC"
            ),
        },
        PlannedQuery {
            label: "Cohort sizes".to_string(),
            sql: format!(
                "SELECT {group} AS cohort, COUNT(*) AS rows FROM {t} GROUP BY {group} ORDER BY rows DESC"
            ),
        },
    ]
}

fn plan_data_quality(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let t = &p.table;
    let mut out: Vec<PlannedQuery> = Vec::new();

    // Completeness + duplicates: one row per column (UNION ALL of whole-table
    // aggregates), so the output is a compact column × facts table. Duplicates =
    // non-null rows minus distinct non-null values; null% is engine-rounded.
    let arms: Vec<String> = p
        .columns
        .iter()
        .take(DQ_MAX_COLS)
        .map(|(name, _)| {
            format!(
                "SELECT '{name}' AS column_name, COUNT(*) AS rows, \
                 COUNT(*) - COUNT({name}) AS nulls, \
                 ROUND(100.0 * (COUNT(*) - COUNT({name})) / NULLIF(COUNT(*), 0), 1) AS null_pct, \
                 COUNT(DISTINCT {name}) AS distinct_vals, \
                 COUNT({name}) - COUNT(DISTINCT {name}) AS duplicate_vals \
                 FROM {t}"
            )
        })
        .collect();
    if !arms.is_empty() {
        // ORDER BY the output column so the UNION-ALL arms come back in a STABLE
        // order — a bare UNION ALL has no ordering guarantee, so DataFusion may
        // emit the per-column arms in any order across runs. That nondeterminism
        // is invisible to a keyed reader (the eval looks rows up by `column_name`)
        // but breaks any byte-stable render of the result (the deep-analysis
        // report requires a reproducible document). Sorting here makes the recipe
        // deterministic in its RESULT, not just its SQL.
        out.push(PlannedQuery {
            label: "Column completeness and duplicates".to_string(),
            sql: format!("{} ORDER BY column_name", arms.join(" UNION ALL ")),
        });
    }

    // Numeric IQR outliers: a self-contained WITH query per numeric column
    // (Tukey's 1.5·IQR fence), bounded so the footer stays legible. Each is one
    // guarded SELECT; a column with no spread simply reports zero outliers.
    for (name, _) in p
        .columns
        .iter()
        .filter(|(_, k)| *k == ColumnKind::Numeric)
        .take(DQ_IQR_MAX)
    {
        out.push(PlannedQuery {
            label: format!("IQR outliers in {name}"),
            sql: format!(
                "WITH bounds AS (SELECT approx_percentile_cont({name}, 0.25) AS q1, \
                 approx_percentile_cont({name}, 0.75) AS q3 FROM {t}) \
                 SELECT '{name}' AS column_name, ROUND(b.q1, 2) AS q1, ROUND(b.q3, 2) AS q3, \
                 ROUND(b.q3 - b.q1, 2) AS iqr, \
                 COUNT(*) FILTER (WHERE t.{name} < b.q1 - 1.5 * (b.q3 - b.q1) \
                 OR t.{name} > b.q3 + 1.5 * (b.q3 - b.q1)) AS outliers \
                 FROM {t} t CROSS JOIN bounds b GROUP BY b.q1, b.q3"
            ),
        });
    }
    out
}

fn plan_anomaly(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let (Some(date), Some(metric)) = (p.date_col.as_deref(), p.metric.as_deref()) else {
        return Vec::new();
    };
    let t = &p.table;
    let m = month_bucket(date);
    // Shared: the per-month series and its mean/stddev. STDDEV is the sample
    // standard deviation aggregate; the fence is a 2-sigma z-score.
    let series = format!(
        "series AS (SELECT {m} AS period, SUM({metric}) AS total FROM {t} GROUP BY {m}), \
         stats AS (SELECT AVG(total) AS mean, STDDEV(total) AS sd FROM series)"
    );
    vec![
        PlannedQuery {
            label: "Flagged periods (beyond 2 sigma)".to_string(),
            sql: format!(
                "WITH {series} \
                 SELECT s.period, s.total, \
                 ROUND((s.total - st.mean) / NULLIF(st.sd, 0), 2) AS z_score \
                 FROM series s CROSS JOIN stats st \
                 WHERE st.sd > 0 AND ABS(s.total - st.mean) > 2 * st.sd \
                 ORDER BY ABS(s.total - st.mean) DESC"
            ),
        },
        PlannedQuery {
            label: "Period series with z-scores".to_string(),
            sql: format!(
                "WITH {series} \
                 SELECT s.period, s.total, ROUND(st.mean, 2) AS mean, ROUND(st.sd, 2) AS stddev, \
                 ROUND((s.total - st.mean) / NULLIF(st.sd, 0), 2) AS z_score \
                 FROM series s CROSS JOIN stats st ORDER BY s.period"
            ),
        },
    ]
}

fn plan_top_movers(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let Some(group) = p.group_col.as_deref() else {
        return Vec::new();
    };
    let Some(metric) = p.metric.as_deref() else {
        return Vec::new();
    };
    let t = &p.table;
    match p.date_col.as_deref() {
        // With a date: per-group change of the latest month vs the prior month,
        // sorted by absolute move, top N.
        Some(date) => {
            let m = month_bucket(date);
            vec![PlannedQuery {
                label: "Biggest movers vs prior period".to_string(),
                sql: format!(
                    "WITH periods AS (SELECT {group} AS cohort, {m} AS period, SUM({metric}) AS total \
                     FROM {t} GROUP BY {group}, {m}), \
                     ranked AS (SELECT cohort, period, total, \
                     ROW_NUMBER() OVER (PARTITION BY cohort ORDER BY period DESC) AS rn FROM periods), \
                     pivot AS (SELECT cohort, MAX(CASE WHEN rn = 1 THEN total END) AS current_total, \
                     MAX(CASE WHEN rn = 2 THEN total END) AS prior_total FROM ranked WHERE rn <= 2 GROUP BY cohort) \
                     SELECT cohort, current_total, prior_total, \
                     current_total - prior_total AS change, \
                     ROUND(100.0 * (current_total - prior_total) / NULLIF(prior_total, 0), 1) AS pct_change \
                     FROM pivot ORDER BY ABS(current_total - prior_total) DESC LIMIT {MOVERS_TOP_N}"
                ),
            }]
        }
        // No date: rank groups by the magnitude of their total, top N.
        None => vec![PlannedQuery {
            label: "Largest groups by magnitude".to_string(),
            sql: format!(
                "SELECT {group} AS cohort, SUM({metric}) AS total FROM {t} \
                 GROUP BY {group} ORDER BY ABS(SUM({metric})) DESC LIMIT {MOVERS_TOP_N}"
            ),
        }],
    }
}

/// The shared statistical core for the forecast (add-quant-depth §2): the
/// period-indexed monthly series and the CLOSED-FORM OLS fit over it, entirely as
/// SUM/COUNT aggregates so no math happens Rust-side. `t = 1..n` via ROW_NUMBER;
/// `b`/`a` are the textbook OLS slope/intercept; `sigma` is the residual standard
/// deviation with `n − 2` d.o.f. Every denominator is `NULLIF`-guarded, so a
/// degenerate/flat series collapses to NULL rather than erroring (`σ = 0` on a
/// perfect line is a valid, finite output — the band just collapses to the line).
/// The two forecast steps both open with these CTEs.
fn forecast_core(table: &str, month: &str, metric: &str) -> String {
    format!(
        "series AS (SELECT {month} AS period, SUM({metric}) AS y FROM {table} GROUP BY {month}), \
         indexed AS (SELECT period, y, CAST(ROW_NUMBER() OVER (ORDER BY period) AS DOUBLE) AS t \
         FROM series), \
         agg AS (SELECT CAST(COUNT(*) AS DOUBLE) AS n, SUM(t) AS st, SUM(y) AS sy, \
         SUM(t * y) AS sty, SUM(t * t) AS stt FROM indexed), \
         coef1 AS (SELECT n, st, sy, (n * sty - st * sy) / NULLIF(n * stt - st * st, 0) AS b FROM agg), \
         coef AS (SELECT n, st, sy, b, (sy - b * st) / NULLIF(n, 0) AS a FROM coef1), \
         fit AS (SELECT MAX(c.n) AS n, MAX(c.a) AS a, MAX(c.b) AS b, \
         SQRT(SUM((i.y - (c.a + c.b * i.t)) * (i.y - (c.a + c.b * i.t))) / NULLIF(MAX(c.n) - 2, 0)) AS sigma \
         FROM indexed i CROSS JOIN coef c)"
    )
}

fn plan_forecast(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let (Some(date), Some(metric)) = (p.date_col.as_deref(), p.metric.as_deref()) else {
        return Vec::new();
    };
    let t = &p.table;
    let m = month_bucket(date);
    let core = forecast_core(t, &m, metric);
    // Horizon rows 1..=FORECAST_HORIZON as a UNION of literals, kept in lockstep
    // with the constant, cross-joined to the single-row `fit`. Future index for
    // step h is `n + h`; the future month LABEL is built by integer arithmetic on
    // the max 'YYYY-MM' (DataFusion has no `printf`, so the label is `concat` +
    // `lpad`), robust to any date-function support.
    let horizon = (1..=FORECAST_HORIZON)
        .map(|h| format!("SELECT {h} AS h"))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    vec![
        PlannedQuery {
            label: "Actual series with projected band".to_string(),
            // One guarded SELECT: the history (kind='actual', y, NULL band) unioned
            // with the projected horizon (kind='forecast', a+b·t, ±z·σ). The
            // forecast arm is gated on `n >= FORECAST_MIN_POINTS` IN SQL, so a short
            // series simply yields zero forecast rows (history only). All periods
            // are 'YYYY-MM' text, so ORDER BY period is chronological across both.
            sql: format!(
                "WITH {core}, \
                 maxp AS (SELECT MAX(period) AS mp FROM indexed), \
                 parts AS (SELECT CAST(substr(mp, 1, 4) AS INT) AS yr, \
                 CAST(substr(mp, 6, 2) AS INT) AS mo FROM maxp), \
                 horizon AS ({horizon}) \
                 SELECT period, kind, value, lower, upper FROM ( \
                 SELECT i.period AS period, 'actual' AS kind, ROUND(i.y, 2) AS value, \
                 CAST(NULL AS DOUBLE) AS lower, CAST(NULL AS DOUBLE) AS upper \
                 FROM indexed i \
                 UNION ALL \
                 SELECT concat(CAST((p.yr * 12 + (p.mo - 1) + hz.h) / 12 AS VARCHAR), '-', \
                 lpad(CAST(((p.yr * 12 + (p.mo - 1) + hz.h) % 12) + 1 AS VARCHAR), 2, '0')) AS period, \
                 'forecast' AS kind, \
                 ROUND(f.a + f.b * (f.n + hz.h), 2) AS value, \
                 ROUND(f.a + f.b * (f.n + hz.h) - {Z_FORECAST} * f.sigma, 2) AS lower, \
                 ROUND(f.a + f.b * (f.n + hz.h) + {Z_FORECAST} * f.sigma, 2) AS upper \
                 FROM horizon hz CROSS JOIN fit f CROSS JOIN parts p \
                 WHERE f.n >= {FORECAST_MIN_POINTS} \
                 ) ORDER BY period"
            ),
        },
        PlannedQuery {
            label: "Trend fit summary".to_string(),
            // The coefficients the narration cites for the trend rate: slope,
            // intercept, residual σ, and n. One row (NULL σ when n < 3, which the
            // narration reads as "too short to project").
            sql: format!(
                "WITH {core} SELECT ROUND(f.b, 4) AS slope, ROUND(f.a, 4) AS intercept, \
                 ROUND(f.sigma, 2) AS residual_sigma, CAST(f.n AS BIGINT) AS n FROM fit f"
            ),
        },
    ]
}

fn plan_changepoint(p: &ResolvedParams) -> Vec<PlannedQuery> {
    let (Some(date), Some(metric)) = (p.date_col.as_deref(), p.metric.as_deref()) else {
        return Vec::new();
    };
    let t = &p.table;
    let m = month_bucket(date);
    vec![PlannedQuery {
        label: "Most significant level shift".to_string(),
        // One guarded SELECT: score every interior split k (1 ≤ k ≤ n−1) by the
        // mean gap normalized by the pooled STDDEV, then argmax. The before/after
        // means come from a cumulative window prefix sum (mean_before =
        // prefix/k) and the complementary suffix (mean_after = (total−prefix)/(n−k));
        // `+ CHANGEPOINT_EPSILON` keeps a flat series finite. Gated on
        // `n >= CHANGEPOINT_MIN_POINTS` IN SQL — a short series returns no rows
        // (surfaced as the executor's honest "no rows"). ORDER BY period stands in
        // for ORDER BY t (period is monotonic with t) since a window can't order by
        // another window's alias in the same SELECT.
        sql: format!(
            "WITH series AS (SELECT {m} AS period, SUM({metric}) AS y FROM {t} GROUP BY {m}), \
             stats AS (SELECT STDDEV(y) AS sd, COUNT(*) AS n, SUM(y) AS total_sum FROM series), \
             indexed AS (SELECT period, y, CAST(ROW_NUMBER() OVER (ORDER BY period) AS BIGINT) AS t, \
             SUM(y) OVER (ORDER BY period ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prefix_sum \
             FROM series), \
             splits AS (SELECT i.period, i.t, \
             i.prefix_sum / CAST(i.t AS DOUBLE) AS mean_before, \
             (s.total_sum - i.prefix_sum) / NULLIF(CAST(s.n - i.t AS DOUBLE), 0) AS mean_after, \
             s.sd AS sd \
             FROM indexed i CROSS JOIN stats s \
             WHERE i.t < s.n AND s.n >= {CHANGEPOINT_MIN_POINTS}), \
             scored AS (SELECT period, mean_before, mean_after, \
             ABS(mean_after - mean_before) / (sd + {CHANGEPOINT_EPSILON}) AS score FROM splits) \
             SELECT period AS changepoint_period, ROUND(mean_before, 2) AS mean_before, \
             ROUND(mean_after, 2) AS mean_after, ROUND(mean_after - mean_before, 2) AS delta, \
             ROUND(score, 2) AS magnitude FROM scored ORDER BY score DESC LIMIT 1"
        ),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::guard_sql;

    /// A representative typed column set exercising every kind — the fixture the
    /// planners resolve against.
    fn typed() -> Vec<(String, ColumnKind)> {
        vec![
            ("order_date".to_string(), ColumnKind::Date),
            ("region".to_string(), ColumnKind::Text),
            ("amount".to_string(), ColumnKind::Numeric),
            ("units".to_string(), ColumnKind::Numeric),
        ]
    }

    #[test]
    fn every_planned_template_passes_the_guard() {
        // Task 2.1's required guard: for EACH built-in, resolve against the
        // fixture and assert every planned SQL is a single read-only SELECT.
        let cols = typed();
        for r in BUILTINS {
            let resolved = r
                .resolve("sales", &cols)
                .unwrap_or_else(|| panic!("{} should resolve against a full fixture", r.id));
            let plan = (r.plan)(&resolved);
            assert!(!plan.is_empty(), "{} planned no queries", r.id);
            for q in &plan {
                guard_sql(&q.sql).unwrap_or_else(|e| {
                    panic!("{} template {:?} failed the guard: {e}\nSQL: {}", r.id, q.label, q.sql)
                });
            }
        }
    }

    #[test]
    fn planning_is_deterministic() {
        let cols = typed();
        for r in BUILTINS {
            let a = (r.plan)(&r.resolve("sales", &cols).unwrap());
            let b = (r.plan)(&r.resolve("sales", &cols).unwrap());
            let sqls = |p: &[PlannedQuery]| p.iter().map(|q| q.sql.clone()).collect::<Vec<_>>();
            assert_eq!(sqls(&a), sqls(&b), "{} must plan identically every time", r.id);
        }
    }

    #[test]
    fn resolution_picks_first_of_each_kind_in_column_order() {
        // `units` is also numeric but `amount` comes first — the stable tie-break
        // is column order.
        let cols = typed();
        let r = lookup("variance-vs-last-period").unwrap();
        let p = r.resolve("sales", &cols).unwrap();
        assert_eq!(p.date_col.as_deref(), Some("order_date"));
        assert_eq!(p.metric.as_deref(), Some("amount"));
    }

    #[test]
    fn applicability_gates_on_needs() {
        let numeric_only = vec![("amount".to_string(), ColumnKind::Numeric)];
        // Needs a date → not applicable / does not resolve.
        assert!(!lookup("variance-vs-last-period").unwrap().applicable(&numeric_only));
        assert!(lookup("variance-vs-last-period").unwrap().resolve("t", &numeric_only).is_none());
        // The audit needs nothing → applicable to any non-empty table.
        assert!(lookup("data-quality-audit").unwrap().applicable(&numeric_only));
        // Cohort/top-movers need a group (text) column.
        assert!(!lookup("cohort-breakdown").unwrap().applicable(&numeric_only));
    }

    #[test]
    fn top_movers_drops_the_date_clause_without_a_date() {
        // Group + numeric but no date → the magnitude-ranking shape, still guarded.
        let cols = vec![
            ("region".to_string(), ColumnKind::Text),
            ("amount".to_string(), ColumnKind::Numeric),
        ];
        let r = lookup("top-movers").unwrap();
        let plan = (r.plan)(&r.resolve("sales", &cols).unwrap());
        assert_eq!(plan.len(), 1);
        assert!(plan[0].sql.contains("ABS(SUM(amount))"), "{}", plan[0].sql);
        guard_sql(&plan[0].sql).unwrap();
    }

    #[test]
    fn cue_parses_only_the_explicit_structured_prefix() {
        let cue = parse_recipe_cue("run-recipe:variance-vs-last-period on Q3 Sales.csv").unwrap();
        assert_eq!(cue.id, "variance-vs-last-period");
        assert_eq!(cue.table, "Q3 Sales.csv"); // table names may carry spaces
        // A plain question never triggers, nor does an unknown id.
        assert!(parse_recipe_cue("how did revenue change vs last period?").is_none());
        assert!(parse_recipe_cue("run-recipe:not-a-recipe on sales.csv").is_none());
        assert!(parse_recipe_cue("run-recipe:variance-vs-last-period").is_none());
    }

    // --- add-quant-depth §2/§3 -------------------------------------------------
    // (Guard-legality + determinism + executability of these two recipes' SQL are
    // ALSO covered generically by `every_planned_template_passes_the_guard` /
    // `planning_is_deterministic` above and by `recipes_test.rs`, which now iterate
    // over the two new built-ins too. These pin the plan SHAPE and the SQL
    // degradation gates.)

    #[test]
    fn forecast_plans_history_and_fit_summary() {
        let r = lookup("forecast").unwrap();
        let plan = (r.plan)(&r.resolve("sales", &typed()).unwrap());
        assert_eq!(plan.len(), 2, "series + fit summary");
        let series = &plan[0].sql;
        // A unified actual+forecast series carrying a band.
        assert!(series.contains("'actual'") && series.contains("'forecast'"), "{series}");
        assert!(series.contains("UNION ALL"), "{series}");
        assert!(series.contains("AS lower") && series.contains("AS upper"), "{series}");
        // The forecast rows are gated on the min-points constant IN SQL (the
        // n<3 degradation is data, not a Rust branch).
        assert!(series.contains(&format!(">= {FORECAST_MIN_POINTS}")), "{series}");
        // Exactly FORECAST_HORIZON horizon arms, tied to the constant.
        for h in 1..=FORECAST_HORIZON {
            assert!(series.contains(&format!("SELECT {h} AS h")), "missing horizon arm {h}: {series}");
        }
        assert!(!series.contains(&format!("SELECT {} AS h", FORECAST_HORIZON + 1)), "{series}");
        // The band uses the named z-constant, not a literal that could drift.
        assert!(series.contains(&Z_FORECAST.to_string()), "{series}");
        // The summary carries the coefficients the narration cites.
        assert!(
            plan[1].sql.contains("AS slope")
                && plan[1].sql.contains("AS intercept")
                && plan[1].sql.contains("AS residual_sigma"),
            "{}",
            plan[1].sql
        );
        guard_sql(series).unwrap();
        guard_sql(&plan[1].sql).unwrap();
    }

    #[test]
    fn changepoint_plans_a_single_guarded_scan() {
        let r = lookup("changepoint-scan").unwrap();
        let plan = (r.plan)(&r.resolve("sales", &typed()).unwrap());
        assert_eq!(plan.len(), 1);
        let sql = &plan[0].sql;
        assert!(sql.contains("AS changepoint_period"), "{sql}");
        assert!(sql.contains("AS mean_before") && sql.contains("AS mean_after"), "{sql}");
        assert!(sql.contains("AS magnitude"), "{sql}");
        assert!(sql.contains("STDDEV("), "{sql}");
        // Interior splits only, gated on the min-points constant.
        assert!(sql.contains("i.t < s.n") && sql.contains(&format!(">= {CHANGEPOINT_MIN_POINTS}")), "{sql}");
        assert!(sql.contains("ORDER BY score DESC LIMIT 1"), "{sql}");
        guard_sql(sql).unwrap();
    }

    #[test]
    fn quant_recipes_guard_on_missing_date_or_metric() {
        // The planner-level early-return (the `plan_anomaly` guard pattern): a
        // resolved-params bag missing the date or the metric plans nothing, so a
        // stale invocation degrades to an honest empty rather than bad SQL.
        let no_date = ResolvedParams {
            table: "t".to_string(),
            date_col: None,
            metric: Some("amount".to_string()),
            group_col: None,
            period: Period::Month,
            columns: vec![],
        };
        let no_metric = ResolvedParams {
            table: "t".to_string(),
            date_col: Some("d".to_string()),
            metric: None,
            group_col: None,
            period: Period::Month,
            columns: vec![],
        };
        assert!(plan_forecast(&no_date).is_empty());
        assert!(plan_forecast(&no_metric).is_empty());
        assert!(plan_changepoint(&no_date).is_empty());
        assert!(plan_changepoint(&no_metric).is_empty());
        // Both demand a date, so neither is applicable to a numeric-only catalog.
        let numeric_only = vec![("amount".to_string(), ColumnKind::Numeric)];
        assert!(!lookup("forecast").unwrap().applicable(&numeric_only));
        assert!(!lookup("changepoint-scan").unwrap().applicable(&numeric_only));
        assert!(lookup("forecast").unwrap().resolve("t", &numeric_only).is_none());
    }
}
