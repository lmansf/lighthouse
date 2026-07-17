//! Proactive insights (openspec: add-quant-depth §5) — the "here's what stands
//! out" surface. Unlike every other analytics path, NOTHING here is triggered by
//! a question: `scan` runs the CHEAP, deterministic detectors already in
//! `recipes.rs` (the anomaly z-score, top-movers, and the changepoint scan) over
//! the cataloged Date+Numeric tables and returns a ranked list of findings, each
//! with a headline TEMPLATED from engine-computed numbers — never model text.
//!
//! It is bounded (at most `INSIGHTS_MAX_TABLES` tables scanned, `INSIGHTS_MAX`
//! findings returned) and DISCLOSES when tables were left unscanned, never a
//! silent truncation. It is entirely on-device — DataFusion SQL over the same
//! `run_query` the recipes use, no provider call and no model in the loop — so a
//! scan egresses NOTHING. It degrades per table: a table that can't be analyzed
//! (no Date/Numeric shape, an extraction gap, a SQL error) is skipped silently;
//! one bad table never fails the scan. An empty result is a valid, honest
//! "nothing stands out."
//!
//! PARITY: Rust-only (DataFusion), like the whole analytics branch. The TS twin's
//! `insights` op returns `[]` (docs/ts-twin.md).

use std::path::PathBuf;

use datafusion::arrow::util::display::array_value_to_string;
use datafusion::prelude::SessionContext;
use serde::Serialize;

use crate::analytics::{register_tables, run_query, QueryResult};
use crate::catalog::{columns_for, ColumnKind};
use crate::recipes::lookup;

/// Most cataloged tables a single scan visits (in catalog order). A large vault
/// stays bounded; the overflow is DISCLOSED, never silently dropped.
const INSIGHTS_MAX_TABLES: usize = 12;
/// Most findings a scan returns, ranked by normalized magnitude (descending).
const INSIGHTS_MAX: usize = 8;
/// A mover must move at least this percent to count as noteworthy.
const INSIGHT_MOVER_MIN_PCT: f64 = 25.0;
/// A changepoint must score at least this (normalized max-split magnitude) to
/// count as a material level shift.
const INSIGHT_CHANGEPOINT_MIN_MAG: f64 = 1.0;

/// One proactive finding. `magnitude` is a NORMALIZED, cross-detector-comparable
/// score used only for ranking (a z-score, a percent/100, a changepoint
/// magnitude — all on a roughly 0–5 scale); the `headline` carries the finding's
/// NATIVE figure. `sql` is the query that produced it (provenance).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub table: String,
    pub kind: &'static str,
    pub headline: String,
    pub magnitude: f64,
    pub sql: String,
}

/// The result of a scan: the ranked findings plus how many Date+Numeric tables
/// were available versus actually scanned, so the surface can disclose a cap
/// ("scanned N of M") rather than present a capped set as exhaustive.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    pub findings: Vec<Insight>,
    pub tables_scanned: usize,
    pub tables_available: usize,
}

/// Run the cheap detectors over `files` (already filtered to tabular candidates
/// by the caller) and return the ranked, bounded findings. `files` are
/// `(file_id, display_name, path)` triples — the same shape the recipe branch
/// registers. On-device only; nothing here calls a provider or a model.
pub async fn scan(files: &[(String, String, PathBuf)], is_cloud: bool) -> Insights {
    // The typed catalog (a CSV date reads as Date, etc.) — the same source the
    // recipe applicability check reads, so a scan never runs a detector on a
    // table the recipe wouldn't accept.
    let catalog = {
        let files = files.to_vec();
        tokio::task::spawn_blocking(move || columns_for(&files))
            .await
            .unwrap_or_default()
    };
    // Only Date+Numeric tables can carry a temporal detector; count them for the
    // disclosure, then scan up to the cap in catalog order.
    let analyzable: Vec<_> = catalog
        .iter()
        .filter(|fc| has_date_and_numeric(&fc.columns))
        .collect();
    let tables_available = analyzable.len();
    let tables_scanned = tables_available.min(INSIGHTS_MAX_TABLES);

    let ctx = SessionContext::new();
    let regs = register_tables(&ctx, files, is_cloud).await;

    let mut findings: Vec<Insight> = Vec::new();
    for fc in analyzable.into_iter().take(INSIGHTS_MAX_TABLES) {
        // Map the cataloged file to its registered SQL table (a union-family
        // member maps to the family's table), exactly as the recipe branch does.
        let Some(sql_table) = regs
            .iter()
            .find(|r| {
                r.file_id == fc.id
                    || r.group.as_ref().is_some_and(|g| g.file_ids.contains(&fc.id))
            })
            .map(|r| r.table.clone())
        else {
            continue; // registration gap — skip this table, never fail the scan
        };
        let cols: Vec<(String, ColumnKind)> =
            fc.columns.iter().map(|c| (c.name.clone(), c.kind)).collect();
        for (id, extract) in DETECTORS {
            // A detector that doesn't resolve/plan/run over this table is skipped;
            // one bad table or detector never aborts the sweep.
            let Some(recipe) = lookup(id) else { continue };
            let Some(params) = recipe.resolve(&sql_table, &cols) else { continue };
            let plan = (recipe.plan)(&params);
            let Some(q) = plan.into_iter().next() else { continue };
            if let Ok(res) = run_query(&ctx, &q.sql).await {
                if let Some(ins) = extract(&fc.name, &res, &q.sql) {
                    findings.push(ins);
                }
            }
        }
    }

    // Rank by the normalized magnitude (descending) and cap. Stable sort keeps a
    // deterministic order among equal-magnitude findings.
    findings.sort_by(|a, b| {
        b.magnitude
            .partial_cmp(&a.magnitude)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    findings.truncate(INSIGHTS_MAX);
    Insights { findings, tables_scanned, tables_available }
}

/// The cheap detectors a scan runs, each with the recipe id and the extractor
/// that turns its representative result into a finding (or `None` when the
/// result is immaterial). Order is stable for deterministic ties.
type Extractor = fn(&str, &QueryResult, &str) -> Option<Insight>;
const DETECTORS: &[(&str, Extractor)] = &[
    ("anomaly-scan", extract_anomaly),
    ("top-movers", extract_mover),
    ("changepoint-scan", extract_changepoint),
];

fn has_date_and_numeric(cols: &[crate::catalog::Column]) -> bool {
    cols.iter().any(|c| c.kind == ColumnKind::Date)
        && cols.iter().any(|c| c.kind == ColumnKind::Numeric)
}

/// Row-0 cell under `col` as a rendered string (DataFusion's own formatting), or
/// `None` when the result is empty or the column is absent.
fn cell(res: &QueryResult, col: &str) -> Option<String> {
    let b = res.batches.iter().find(|b| b.num_rows() > 0)?;
    let idx = b.schema().index_of(col).ok()?;
    if b.column(idx).is_null(0) {
        return None;
    }
    array_value_to_string(b.column(idx), 0).ok()
}

fn parse_cell(res: &QueryResult, col: &str) -> Option<f64> {
    cell(res, col)?.trim().parse::<f64>().ok()
}

/// anomaly-scan plan[0] = "Flagged periods (beyond 2 sigma)": ANY row is an
/// anomaly. The top row (most extreme, the query orders by |deviation| desc)
/// names the period + its z-score.
fn extract_anomaly(table: &str, res: &QueryResult, sql: &str) -> Option<Insight> {
    let period = cell(res, "period")?;
    let z = parse_cell(res, "z_score")?;
    Some(Insight {
        table: table.to_string(),
        kind: "anomaly",
        headline: format!("{table}: {period} is a {z:+}σ anomaly"),
        magnitude: z.abs(),
        sql: sql.to_string(),
    })
}

/// top-movers plan[0] = "Biggest movers vs prior period": the top row is the
/// biggest absolute mover. Material only when it moved at least the threshold.
fn extract_mover(table: &str, res: &QueryResult, sql: &str) -> Option<Insight> {
    let cohort = cell(res, "cohort")?;
    let pct = parse_cell(res, "pct_change")?;
    if pct.abs() < INSIGHT_MOVER_MIN_PCT {
        return None;
    }
    Some(Insight {
        table: table.to_string(),
        kind: "mover",
        headline: format!("{table}: {cohort} moved {pct:+}% vs the prior period"),
        // Normalize a percent onto the ~z-score scale so a 400% mover (4.0) ranks
        // beside a 4σ anomaly rather than swamping it.
        magnitude: pct.abs() / 100.0,
        sql: sql.to_string(),
    })
}

/// changepoint-scan = the single top split. Material only when the normalized
/// magnitude clears the floor (a flat series scores ~0 and is not a finding).
fn extract_changepoint(table: &str, res: &QueryResult, sql: &str) -> Option<Insight> {
    let period = cell(res, "changepoint_period")?;
    let before = parse_cell(res, "mean_before")?;
    let after = parse_cell(res, "mean_after")?;
    let mag = parse_cell(res, "magnitude")?;
    if mag < INSIGHT_CHANGEPOINT_MIN_MAG {
        return None;
    }
    Some(Insight {
        table: table.to_string(),
        kind: "changepoint",
        headline: format!("{table}: level shift at {period} ({before} → {after})"),
        magnitude: mag,
        sql: sql.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use datafusion::arrow::array::StringArray;
    use datafusion::arrow::datatypes::{DataType, Field, Schema};
    use datafusion::arrow::record_batch::RecordBatch;
    use std::sync::Arc;

    // Build a one-row QueryResult with the given (col, value) cells — string
    // columns render as themselves, so the extractors' cell parsing is exercised.
    fn result(cols: &[(&str, &str)]) -> QueryResult {
        let fields: Vec<Field> = cols
            .iter()
            .map(|(n, _)| Field::new(*n, DataType::Utf8, true))
            .collect();
        let arrays: Vec<Arc<dyn datafusion::arrow::array::Array>> = cols
            .iter()
            .map(|(_, v)| Arc::new(StringArray::from(vec![*v])) as _)
            .collect();
        let batch = RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).unwrap();
        QueryResult {
            markdown: String::new(),
            shown: 1,
            truncated: false,
            total: Some(1),
            chart: None,
            digest: String::new(),
            batches: vec![batch],
        }
    }

    #[test]
    fn anomaly_extractor_reads_the_engine_z_score() {
        let ins = extract_anomaly(
            "sales.csv",
            &result(&[("period", "2024-10"), ("total", "400"), ("z_score", "2.85")]),
            "SELECT …",
        )
        .unwrap();
        assert_eq!(ins.kind, "anomaly");
        assert!(ins.headline.contains("2024-10") && ins.headline.contains("2.85"));
        assert!((ins.magnitude - 2.85).abs() < 1e-9);
    }

    #[test]
    fn mover_extractor_gates_on_the_threshold_and_normalizes() {
        // A 400% mover is material; its ranking magnitude normalizes to 4.0.
        let big = extract_mover(
            "sales.csv",
            &result(&[("cohort", "South"), ("pct_change", "400.0")]),
            "SELECT …",
        )
        .unwrap();
        assert_eq!(big.kind, "mover");
        assert!((big.magnitude - 4.0).abs() < 1e-9);
        // A 5% wobble is below the floor — not a finding.
        assert!(extract_mover(
            "sales.csv",
            &result(&[("cohort", "North"), ("pct_change", "5.0")]),
            "SELECT …",
        )
        .is_none());
    }

    #[test]
    fn changepoint_extractor_gates_on_material_magnitude() {
        let shift = extract_changepoint(
            "sales.csv",
            &result(&[
                ("changepoint_period", "2024-04"),
                ("mean_before", "100"),
                ("mean_after", "500"),
                ("magnitude", "1.87"),
            ]),
            "SELECT …",
        )
        .unwrap();
        assert_eq!(shift.kind, "changepoint");
        assert!(shift.headline.contains("2024-04"));
        // A flat series scores ~0 → below the floor → no finding.
        assert!(extract_changepoint(
            "sales.csv",
            &result(&[
                ("changepoint_period", "2024-02"),
                ("mean_before", "300"),
                ("mean_after", "300"),
                ("magnitude", "0.0"),
            ]),
            "SELECT …",
        )
        .is_none());
    }
}
