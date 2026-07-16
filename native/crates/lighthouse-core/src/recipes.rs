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
//! v1 ships FIVE built-ins and NO user-authored recipes: the descriptor +
//! planner below is the extension seam, not a creation surface.
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

/// The five v1 built-ins (design.md "The recipe object").
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

/// The month bucket for a (text ISO) date column — the analytics idiom.
fn month_bucket(date_col: &str) -> String {
    format!("substr({date_col}, 1, 7)")
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
        out.push(PlannedQuery {
            label: "Column completeness and duplicates".to_string(),
            sql: arms.join(" UNION ALL "),
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
}
