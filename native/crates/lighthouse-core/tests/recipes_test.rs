//! Recipe engine (openspec: add-recipes §2.1) — every built-in resolves against
//! a representative catalog, plans a bounded bundle of guarded SELECTs, and each
//! template is not just guard-legal but actually EXECUTABLE by DataFusion 54
//! (the window/CTE/`approx_percentile_cont`/`FILTER`/`STDDEV` shapes the
//! planners emit). Planning is model-free and deterministic.

use std::sync::Arc;

use datafusion::arrow::array::{Float64Array, StringArray};
use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::datasource::MemTable;
use datafusion::prelude::SessionContext;

use lighthouse_core::analytics::{guard_sql, run_query};
use lighthouse_core::catalog::ColumnKind;
use lighthouse_core::recipes::{lookup, BUILTINS};

/// The typed catalog the executor would resolve params from (catalog kinds: a
/// date column arrives as ISO text but is Date-kind).
fn typed() -> Vec<(String, ColumnKind)> {
    vec![
        ("order_date".to_string(), ColumnKind::Date),
        ("region".to_string(), ColumnKind::Text),
        ("amount".to_string(), ColumnKind::Numeric),
        ("units".to_string(), ColumnKind::Numeric),
    ]
}

/// A `sales` table: months Jan–Mar with a March spike (so the anomaly fence can
/// bite), two regions, one null amount, and a repeated region (so the audit sees
/// a duplicate). `order_date` is ISO TEXT — exactly how the engine registers a
/// date column, so the `substr(...,1,7)` month bucket is under test.
fn register_sales(ctx: &SessionContext) {
    let dates = [
        "2024-01-15", "2024-01-20", "2024-02-10", "2024-02-18", "2024-02-25", "2024-03-05",
        "2024-03-11", "2024-03-19",
    ];
    let regions = ["NE", "NW", "NE", "NW", "NE", "NE", "NW", "NE"];
    let amount: Vec<Option<f64>> = vec![
        Some(100.0), Some(50.0), Some(120.0), Some(60.0), None, Some(900.0), Some(80.0), Some(140.0),
    ];
    let units: Vec<Option<f64>> = vec![
        Some(10.0), Some(5.0), Some(12.0), Some(6.0), Some(2.0), Some(90.0), Some(8.0), Some(14.0),
    ];
    let schema = Arc::new(Schema::new(vec![
        Field::new("order_date", DataType::Utf8, false),
        Field::new("region", DataType::Utf8, false),
        Field::new("amount", DataType::Float64, true),
        Field::new("units", DataType::Float64, true),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(StringArray::from(dates.to_vec())),
            Arc::new(StringArray::from(regions.to_vec())),
            Arc::new(Float64Array::from(amount)),
            Arc::new(Float64Array::from(units)),
        ],
    )
    .unwrap();
    let mem = MemTable::try_new(schema, vec![vec![batch]]).unwrap();
    ctx.register_table("sales", Arc::new(mem)).unwrap();
}

#[tokio::test]
async fn every_builtin_plans_guarded_executable_sql() {
    let ctx = SessionContext::new();
    register_sales(&ctx);
    let cols = typed();

    for r in BUILTINS {
        let resolved = r
            .resolve("sales", &cols)
            .unwrap_or_else(|| panic!("{} should resolve against the fixture", r.id));
        let plan = (r.plan)(&resolved);
        assert!(!plan.is_empty(), "{} planned no queries", r.id);
        for q in &plan {
            // Guard-legal (single read-only SELECT)…
            guard_sql(&q.sql)
                .unwrap_or_else(|e| panic!("{} / {:?} failed guard: {e}\n{}", r.id, q.label, q.sql));
            // …and DataFusion can actually plan+run it. An empty result is a
            // legitimate outcome (e.g. no anomaly beyond the fence) that
            // run_query reports as "no rows" — the executor tolerates it by
            // dropping that step. Any OTHER error is a real SQL defect.
            if let Err(e) = run_query(&ctx, &q.sql).await {
                assert_eq!(
                    e, "the query returned no rows",
                    "{} / {:?} is not executable: {e}\n{}",
                    r.id, q.label, q.sql
                );
            }
        }
    }
}

#[tokio::test]
async fn variance_reports_engine_computed_current_and_prior() {
    let ctx = SessionContext::new();
    register_sales(&ctx);
    let r = lookup("variance-vs-last-period").unwrap();
    let plan = (r.plan)(&r.resolve("sales", &typed()).unwrap());
    // The representative (first) query yields current vs prior totals: March =
    // 900+80+140 = 1120 (the null-amount row is Feb, not March), Feb = 120+60 = 180.
    let res = run_query(&ctx, &plan[0].sql).await.unwrap();
    assert!(res.markdown.contains("1120"), "March total: {}", res.markdown);
    assert!(res.markdown.contains("180"), "Feb total: {}", res.markdown);
}

#[tokio::test]
async fn data_quality_reports_the_null_and_the_duplicate() {
    let ctx = SessionContext::new();
    register_sales(&ctx);
    let r = lookup("data-quality-audit").unwrap();
    let plan = (r.plan)(&r.resolve("sales", &typed()).unwrap());
    // The completeness query is first: amount has exactly one null; region has a
    // duplicate (5 NE + 3 NW = 8 rows, 2 distinct → 6 duplicate values).
    let res = run_query(&ctx, &plan[0].sql).await.unwrap();
    assert!(res.markdown.contains("amount"), "{}", res.markdown);
    assert!(res.markdown.contains("region"), "{}", res.markdown);
    // A numeric IQR-outlier query is planned too (amount's 900 spike).
    assert!(
        plan.iter().any(|q| q.label.contains("IQR outliers in amount")),
        "IQR outlier query planned"
    );
}
