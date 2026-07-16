//! Analytics correctness scorecard (openspec: add-analytics-eval-floor).
//!
//! Two sections:
//!
//!   1. MODEL-FREE floor (always runs): golden (fixture → SQL → expected
//!      numbers) cases run through the REAL guarded executor (`run_query`),
//!      asserting the exact statistics and the truncation-honesty contract.
//!      Deterministic, so this section is safe to gate CI on — the process
//!      exits non-zero on any mismatch.
//!
//!   2. PROVIDER NL scorecard (opt-in, never a CI gate): when
//!      `LIGHTHOUSE_EVAL_PROVIDER` (+ `LIGHTHOUSE_EVAL_MODEL`,
//!      `LIGHTHOUSE_EVAL_KEY`) is set, each natural-language question is run
//!      end-to-end — `sql_question` → provider → `extract_sql` → `guard_sql` →
//!      `run_query` — and every expected number must appear in the VERIFIED
//!      result. A final case then narrates the verified result the way
//!      synth.rs does and asserts the lead-with-the-number style (SYSTEM_PROMPT
//!      Style section): the figure must sit on the FIRST non-empty line of the
//!      answer. With no provider configured it prints a note and exits 0, so it
//!      never flakes CI.
//!
//! Run: `cargo run -p lighthouse-core --example analytics_eval`
//! With a provider:
//!   LIGHTHOUSE_EVAL_PROVIDER=anthropic LIGHTHOUSE_EVAL_MODEL=claude-… \
//!   LIGHTHOUSE_EVAL_KEY=sk-… cargo run -p lighthouse-core --example analytics_eval

use std::fs;
use std::path::PathBuf;
use std::process::exit;
use std::time::{Duration, Instant};

use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::util::display::array_value_to_string;
use datafusion::prelude::{CsvReadOptions, SessionContext};
use futures::StreamExt;
use lighthouse_core::analytics::{
    chart_card, extract_sql, guard_sql, register_tables, run_query, sql_question, QueryResult,
    TableReg,
};
use lighthouse_core::beam::{BeamLoop, Budget, StopReason};
use lighthouse_core::catalog::ColumnKind;
use lighthouse_core::ledger::assumption_ledger;
use lighthouse_core::llm::{stream_answer, Ctx, ModelCfg};
use lighthouse_core::recipes::lookup;

/// A fixture written to the temp vault: (file name, CSV body).
const FIXTURES: &[(&str, &str)] = &[
    // ISO dates + a numeric measure — exercises month grouping via substr.
    (
        "sales.csv",
        "d,amount\n2024-01-05,100\n2024-01-20,50\n2024-02-10,200\n2024-02-25,25\n2024-03-01,10\n",
    ),
    // A numeric column with a blank cell — exercises null-skipping AVG.
    ("ratios.csv", "region,ratio\nNE,2.0\nNW,4.0\nSE,\nS,6.0\n"),
    // A "messy" amount column — currency-prefixed text DataFusion infers as
    // Utf8 — the exact shape a shaped VIEW cleans (add-shaped-views §6.2).
    (
        "messy_sales.csv",
        "region,amount\nNE,$1200\nNE,$300\nNW,$500\n",
    ),
];

/// The shaped-view definition the §6.2 Golden answers through: one guarded
/// SELECT that casts the currency-text column to a real number. Passes
/// `guard_sql` (asserted below) exactly as `views::create` requires, and
/// registers virtually via `df.into_view()` — the same primitive
/// `analytics::register_views` uses at ask time.
const CLEAN_SALES_VIEW_SQL: &str =
    "SELECT region, CAST(REPLACE(amount, '$', '') AS DOUBLE) AS amount FROM messy_sales";

/// A model-free golden case: known-good SQL over the fixtures, plus a checker on
/// the verified result.
struct Golden {
    what: &'static str,
    sql: &'static str,
    check: fn(&QueryResult) -> Result<(), String>,
}

fn contains(res: &QueryResult, needles: &[&str]) -> Result<(), String> {
    for n in needles {
        if !res.markdown.contains(n) {
            return Err(format!("missing {n:?} in:\n{}", res.markdown));
        }
    }
    Ok(())
}

const GOLDEN: &[Golden] = &[
    Golden {
        // NOTE: DataFusion's CSV reader infers an ISO-date column as Date32, so
        // the few-shots' bare `substr(date,1,7)` fails on CSV date columns (it
        // works on the workbook path, where dates are Utf8 strings). The robust
        // form casts first — see the known-limitations note in design.md.
        what: "monthly totals over ISO dates (cast-then-substr grouping)",
        sql: "SELECT substr(CAST(d AS VARCHAR), 1, 7) AS month, SUM(amount) AS total FROM sales GROUP BY month ORDER BY month",
        // Jan 150, Feb 225, Mar 10.
        check: |r| contains(r, &["2024-01", "150", "2024-02", "225", "2024-03", "10"]),
    },
    Golden {
        what: "AVG skips a NULL cell (denominator is the non-null count)",
        // (2 + 4 + 6) / 3 = 4  — the blank SE row must not drag it to /4.
        sql: "SELECT AVG(ratio) AS avg_ratio FROM ratios",
        check: |r| contains(r, &["4"]),
    },
    Golden {
        // add-shaped-views §6.2: a question answered THROUGH a saved view. The
        // view (CLEAN_SALES_VIEW_SQL) is registered into this ctx before the
        // loop, so this query reads cleaned DOUBLE amounts the raw CSV never
        // held. NE: 1200 + 300 = 1500; NW: 500.
        what: "totals through a shaped view over a messy currency column",
        sql: "SELECT region, SUM(amount) AS total FROM clean_sales GROUP BY region ORDER BY region",
        check: |r| contains(r, &["NE", "1500", "NW", "500"]),
    },
];

// --- Recipe golden fixtures (openspec: add-recipes §4.1) --------------------------
//
// Two hand-computed CSV fixtures registered with EXPLICIT schemas (see the recipe
// section in `main`). The date column is typed Utf8 TEXT — not the Date32 that CSV
// inference would pick — because the recipe planners bucket months with a bare
// `substr(date, 1, 7)`, whose contract is an ISO-TEXT date column (the same typing
// `recipes_test.rs` uses and the same shape the engine registers a date column as).
// `amount` is a nullable Float64 so a blank cell reads as a real NULL.

/// Shared fixture for FOUR recipes (variance / cohort / data-quality / top-movers).
/// Two months (Feb, Mar) × two regions (North, South), engineered so every total is
/// hand-computable, plus an injected NULL amount and a duplicated `order_id`:
///
///   month totals: Feb = 60+40 = 100, Mar = 100+200+0 = 300 (the null row skipped)
///   region totals: North = 60+100 = 160, South = 40+200+0 = 240, grand = 400
///   duplicates:   order_id R05 appears twice → 1 duplicate value
///   nulls:        amount is blank on exactly one row → 1 null (16.7% of 6 rows)
const RECIPE_SALES_CSV: &str = "\
d,region,order_id,amount
2024-02-10,North,R01,60
2024-02-15,South,R02,40
2024-03-05,North,R03,100
2024-03-12,South,R04,200
2024-03-20,South,R05,
2024-03-25,South,R05,0
";

/// Dedicated fixture for the anomaly scan: ten monthly points, nine at 100 and a
/// single 400 spike in October. A 2-sigma fence needs ≥6 points to ever flag a
/// lone spike (the sample-stddev z-score is bounded by (n-1)/√n), so this recipe
/// gets its own longer series. With nine 100s + one 400 (n=10): mean = 130,
/// sample sd = √9000 ≈ 94.87, so October's z = (400-130)/94.87 ≈ 2.85 clears the
/// 2σ fence (2·94.87 ≈ 189.7 < 270) while every 100-month (z ≈ -0.32) stays inside.
const RECIPE_TREND_CSV: &str = "\
d,amount
2024-01-31,100
2024-02-29,100
2024-03-31,100
2024-04-30,100
2024-05-31,100
2024-06-30,100
2024-07-31,100
2024-08-31,100
2024-09-30,100
2024-10-31,400
";

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join(format!("lh-analytics-eval-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let mut files: Vec<(String, String, PathBuf)> = Vec::new();
    for (name, body) in FIXTURES {
        let path = dir.join(name);
        fs::write(&path, body).expect("write fixture");
        files.push((name.to_string(), name.to_string(), path));
    }

    let mut failures = 0usize;

    // --- Section 1: model-free golden floor (always enforced) -------------
    println!("== model-free executor floor ==");
    let ctx = SessionContext::new();
    for (_, name, path) in &files {
        let table = name.trim_end_matches(".csv");
        ctx.register_csv(table, path.to_str().unwrap(), CsvReadOptions::new())
            .await
            .expect("register fixture");
    }
    // add-shaped-views §6.2: register the shaped view virtually — the SAME
    // path the engine takes at ask time (guard the definition, then
    // `df.into_view()`). A guard failure or a bad definition fails the floor.
    guard_sql(CLEAN_SALES_VIEW_SQL).expect("shaped-view definition passes the SQL guard");
    match ctx.sql(CLEAN_SALES_VIEW_SQL).await {
        Ok(df) => {
            ctx.register_table("clean_sales", df.into_view())
                .expect("register shaped view");
            println!("  PASS  shaped view registered virtually (guarded, into_view)");
        }
        Err(e) => {
            failures += 1;
            println!("  FAIL  shaped view failed to register: {e}");
        }
    }
    for g in GOLDEN {
        match run_query(&ctx, g.sql)
            .await
            .and_then(|r| (g.check)(&r).map(|_| ()))
        {
            Ok(()) => println!("  PASS  {}", g.what),
            Err(e) => {
                failures += 1;
                println!("  FAIL  {}\n        {e}", g.what);
            }
        }
    }

    // Truncation honesty: a 250-row result reports its TRUE total, not the cap.
    {
        let big = dir.join("big.csv");
        let mut body = String::from("id,v\n");
        for i in 0..250 {
            body.push_str(&format!("{i},{i}\n"));
        }
        fs::write(&big, &body).unwrap();
        let bctx = SessionContext::new();
        bctx.register_csv("big", big.to_str().unwrap(), CsvReadOptions::new())
            .await
            .unwrap();
        match run_query(&bctx, "SELECT id, v FROM big").await {
            Ok(r) if r.truncated && r.total == Some(250) => {
                println!("  PASS  truncated result reports true total 250 (not the 200 cap)");
            }
            Ok(r) => {
                failures += 1;
                println!(
                    "  FAIL  truncation: truncated={} total={:?} (want true 250)",
                    r.truncated, r.total
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  truncation query errored: {e}");
            }
        }
    }

    // Read-only guard: SELECT ... INTO and modifying CTEs must be rejected.
    for bad in [
        "SELECT * INTO exfil FROM sales",
        "WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t",
    ] {
        if guard_sql(bad).is_err() {
            println!("  PASS  guard rejects: {bad}");
        } else {
            failures += 1;
            println!("  FAIL  guard ADMITTED a write: {bad}");
        }
    }

    // --- Section 1 (cont.): per-recipe goldens (openspec: add-recipes §4.1) ---
    //
    // Each built-in resolves against a hand-computed fixture, plans its bundle of
    // guarded SELECTs, and EVERY template runs through the same `run_query` the
    // real executor uses — then the exact engine-computed numbers are asserted
    // against the cell strings DataFusion renders (ryu floats, integer counts).
    // Model-free and deterministic, so this gates CI exactly like the goldens
    // above: a mismatch bumps `failures` and the process exits non-zero.
    println!("\n== recipe goldens (model-free) ==");
    {
        // Explicit schemas mirror the REAL CSV path: the date column is Date32
        // (what register_csv infers for ISO dates — see the ISO-date golden note
        // above), amount is nullable Float64 (blank → NULL). Recipes bucket months
        // with substr(CAST(date AS VARCHAR),1,7), robust to a Date32 date column.
        let sales_schema = Schema::new(vec![
            Field::new("d", DataType::Date32, false),
            Field::new("region", DataType::Utf8, false),
            Field::new("order_id", DataType::Utf8, false),
            Field::new("amount", DataType::Float64, true),
        ]);
        let trend_schema = Schema::new(vec![
            Field::new("d", DataType::Date32, false),
            Field::new("amount", DataType::Float64, false),
        ]);
        let rctx = SessionContext::new();
        let sales_path = dir.join("recipe_sales.csv");
        fs::write(&sales_path, RECIPE_SALES_CSV).expect("write recipe_sales fixture");
        rctx.register_csv(
            "recipe_sales",
            sales_path.to_str().unwrap(),
            CsvReadOptions::new().schema(&sales_schema),
        )
        .await
        .expect("register recipe_sales");
        let trend_path = dir.join("recipe_trend.csv");
        fs::write(&trend_path, RECIPE_TREND_CSV).expect("write recipe_trend fixture");
        rctx.register_csv(
            "recipe_trend",
            trend_path.to_str().unwrap(),
            CsvReadOptions::new().schema(&trend_schema),
        )
        .await
        .expect("register recipe_trend");

        // The typed catalog the executor resolves params from. `region` precedes
        // `order_id` so the first Text column (the group) is region; `amount` is
        // the only numeric (the metric); `d` is the date.
        let sales_cols = vec![
            ("d".to_string(), ColumnKind::Date),
            ("region".to_string(), ColumnKind::Text),
            ("order_id".to_string(), ColumnKind::Text),
            ("amount".to_string(), ColumnKind::Numeric),
        ];
        let trend_cols = vec![
            ("d".to_string(), ColumnKind::Date),
            ("amount".to_string(), ColumnKind::Numeric),
        ];

        // variance-vs-last-period: Mar (current) = 300 vs Feb (prior) = 100,
        // delta = +200, pct = 100·200/100 = 200.0%.
        match run_recipe(&rctx, "variance-vs-last-period", "recipe_sales", &sales_cols).await {
            Ok(steps) => {
                record(
                    &mut failures,
                    "variance: current 300 / prior 100 / delta 200 / +200.0%",
                    assert_row(
                        &steps[0].2,
                        &[
                            ("current_period", "2024-03"),
                            ("current_total", "300.0"),
                            ("prior_period", "2024-02"),
                            ("prior_total", "100.0"),
                            ("delta", "200.0"),
                            ("pct_change", "200.0"),
                        ],
                    ),
                );
                record(
                    &mut failures,
                    "variance: monthly totals Feb=100, Mar=300",
                    assert_keyed(&steps[1].2, "period", "2024-02", &[("total", "100.0")])
                        .and_then(|_| {
                            assert_keyed(&steps[1].2, "period", "2024-03", &[("total", "300.0")])
                        }),
                );

                // Ledger snapshot sibling check (§4.1): the assumption ledger is
                // derived from the executed SQL + the result's row facts alone, so
                // it is byte-identical every run. Pinned over the monthly-totals
                // template (the month-bucket + SUM idiom).
                let reg = TableReg {
                    table: "recipe_sales".to_string(),
                    file_id: "recipe_sales-id".to_string(),
                    file_name: "recipe_sales.csv".to_string(),
                    card: String::new(),
                    modified_ms: None,
                    columns: vec![
                        "d".to_string(),
                        "region".to_string(),
                        "order_id".to_string(),
                        "amount".to_string(),
                    ],
                    group: None,
                    capped_rows: None,
                };
                let expected = "*Assumptions:*\n\
                    - Date column: `d` (grouped by month)\n\
                    - Aggregates (`SUM`) skip null cells.\n\
                    - Considered `2` rows.";
                let got = assumption_ledger(
                    steps[1].1.as_str(),
                    std::slice::from_ref(&reg),
                    &steps[1].2,
                );
                record(
                    &mut failures,
                    "ledger snapshot (monthly-totals template) byte-identical",
                    match got.as_deref() {
                        Some(l) if l == expected => Ok(()),
                        other => Err(format!("got {other:?}\n        want {expected:?}")),
                    },
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  variance-vs-last-period — {e}");
            }
        }

        // cohort-breakdown: South = 240 (60%), North = 160 (40%) of the 400 total.
        match run_recipe(&rctx, "cohort-breakdown", "recipe_sales", &sales_cols).await {
            Ok(steps) => {
                record(
                    &mut failures,
                    "cohort: South leads with 240 (60.0% of total)",
                    assert_row(
                        &steps[0].2,
                        &[
                            ("cohort", "South"),
                            ("total", "240.0"),
                            ("pct_of_total", "60.0"),
                        ],
                    ),
                );
                record(
                    &mut failures,
                    "cohort: North 160 (40.0% of total)",
                    assert_keyed(
                        &steps[0].2,
                        "cohort",
                        "North",
                        &[("total", "160.0"), ("pct_of_total", "40.0")],
                    ),
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  cohort-breakdown — {e}");
            }
        }

        // data-quality-audit (the spec's named scenario): amount has EXACTLY one
        // null (16.7% of 6 rows) and order_id flags EXACTLY one duplicate value.
        match run_recipe(&rctx, "data-quality-audit", "recipe_sales", &sales_cols).await {
            Ok(steps) => {
                record(
                    &mut failures,
                    "dq: amount reports exactly 1 null (16.7%)",
                    assert_keyed(
                        &steps[0].2,
                        "column_name",
                        "amount",
                        &[("nulls", "1"), ("null_pct", "16.7")],
                    ),
                );
                record(
                    &mut failures,
                    "dq: order_id flags exactly 1 duplicate value",
                    assert_keyed(
                        &steps[0].2,
                        "column_name",
                        "order_id",
                        &[("duplicate_vals", "1")],
                    ),
                );
                record(
                    &mut failures,
                    "dq: region's repeated values counted (4 duplicates)",
                    assert_keyed(
                        &steps[0].2,
                        "column_name",
                        "region",
                        &[("duplicate_vals", "4")],
                    ),
                );
                record(
                    &mut failures,
                    "dq: an IQR-outlier scan over the numeric column is planned + runs",
                    if steps.iter().any(|(l, _, _)| l.contains("IQR outliers in amount")) {
                        Ok(())
                    } else {
                        Err("no IQR-outlier template for amount".to_string())
                    },
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  data-quality-audit — {e}");
            }
        }

        // anomaly-scan: only the October 400 spike lands beyond the 2σ fence, at
        // z ≈ +2.85; every 100-month stays inside, so exactly one row is flagged.
        match run_recipe(&rctx, "anomaly-scan", "recipe_trend", &trend_cols).await {
            Ok(steps) => {
                record(
                    &mut failures,
                    "anomaly: Oct (total 400) flagged at z = +2.85",
                    assert_row(
                        &steps[0].2,
                        &[
                            ("period", "2024-10"),
                            ("total", "400.0"),
                            ("z_score", "2.85"),
                        ],
                    ),
                );
                record(
                    &mut failures,
                    "anomaly: exactly one period beyond the 2σ fence",
                    match grid(&steps[0].2).1.len() {
                        1 => Ok(()),
                        n => Err(format!("{n} periods flagged, want 1")),
                    },
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  anomaly-scan — {e}");
            }
        }

        // top-movers (dated shape): South moved +160 (+400%), the biggest mover;
        // North moved +40 (+66.7%).
        match run_recipe(&rctx, "top-movers", "recipe_sales", &sales_cols).await {
            Ok(steps) => {
                record(
                    &mut failures,
                    "top-movers: South is the biggest mover (+160, +400.0%)",
                    assert_row(
                        &steps[0].2,
                        &[
                            ("cohort", "South"),
                            ("current_total", "200.0"),
                            ("prior_total", "40.0"),
                            ("change", "160.0"),
                            ("pct_change", "400.0"),
                        ],
                    ),
                );
                record(
                    &mut failures,
                    "top-movers: North second (+40, +66.7%)",
                    assert_keyed(
                        &steps[0].2,
                        "cohort",
                        "North",
                        &[("change", "40.0"), ("pct_change", "66.7")],
                    ),
                );
            }
            Err(e) => {
                failures += 1;
                println!("  FAIL  top-movers — {e}");
            }
        }
    }

    // --- Section 1 (cont.): Beam loop budget floor (openspec: add-beam-loop §6.1) ---
    //
    // The budgeted multi-step loop (§2) must stop at DETERMINISTIC step counts
    // that depend only on the `Budget` and the no-progress guard — never on the
    // model's narration (removing narration must change no figure). Drive the
    // real `BeamLoop` exactly as synth.rs's generator does — consult
    // `stop_before_step` before each iteration, `is_repeat_sql` on a planned SQL,
    // record an advancing step or a non-advance — over scripted outcomes, and
    // assert the exact steps executed and the stop reason. Model-free and
    // deterministic (no wall-clock arm exercised), so it gates CI like the goldens
    // above: a mismatch bumps `failures` and the process exits non-zero.
    println!("\n== beam loop budget floor (model-free) ==");
    {
        let far = Instant::now() + Duration::from_secs(600);

        // max_steps: a budget of 3 executes EXACTLY 3 advancing steps, then the
        // pre-step gate returns MaxSteps — the 4th step never starts.
        {
            let mut beam = BeamLoop::new(Budget::new(3, far, None));
            let mut steps = 0usize;
            let reason = loop {
                if let Some(r) = beam.stop_before_step(steps, None) {
                    break r;
                }
                beam.record_step(format!("SELECT {steps}")); // a fresh, advancing step
                steps += 1;
            };
            if steps == 3 && reason == StopReason::MaxSteps {
                println!("  PASS  max_steps=3 runs exactly 3 steps then stops (MaxSteps)");
            } else {
                failures += 1;
                println!(
                    "  FAIL  max_steps: ran {steps} steps, stopped {reason:?} (want 3 / MaxSteps)"
                );
            }
        }

        // no-progress: one advancing step, then two consecutive non-advancing
        // replies trip the guard — the loop halts after exactly 1 executed step.
        {
            let mut beam = BeamLoop::new(Budget::new(5, far, None));
            beam.record_step("SELECT 1".into()); // step 1 advances
            let tripped = beam.record_non_advance() || beam.record_non_advance();
            let reason = beam.stop_before_step(1, None);
            if tripped && reason == Some(StopReason::NoProgress) {
                println!("  PASS  two non-advancing replies halt the loop (NoProgress) after 1 step");
            } else {
                failures += 1;
                println!(
                    "  FAIL  no-progress: tripped={tripped} reason={reason:?} (want true / NoProgress)"
                );
            }
        }

        // repeat-SQL guard: a planned SQL byte-identical to an executed step cannot
        // advance (re-running recomputes the same result); a fresh SQL is allowed.
        {
            let mut beam = BeamLoop::new(Budget::new(5, far, None));
            let q = "SELECT region, SUM(amount) FROM sales GROUP BY region";
            beam.record_step(q.into());
            if beam.is_repeat_sql(q) && !beam.is_repeat_sql("SELECT COUNT(*) FROM sales") {
                println!("  PASS  repeat-SQL guard flags a byte-identical replan, not a fresh one");
            } else {
                failures += 1;
                println!("  FAIL  repeat-SQL guard misclassified a planned query");
            }
        }

        // unreported-usage fallback (§1.4): with no provider usage the token
        // ceiling cannot bind — the loop still bounds on max_steps.
        {
            let beam = BeamLoop::new(Budget::new(2, far, Some(1_000)));
            if beam.stop_before_step(2, None) == Some(StopReason::MaxSteps) {
                println!("  PASS  unreported usage never binds the ceiling; max_steps still stops");
            } else {
                failures += 1;
                println!("  FAIL  unreported-usage fallback did not fall back to MaxSteps");
            }
        }
    }

    // --- Section 2: provider NL scorecard (opt-in; never a CI gate) -------
    println!("\n== provider NL scorecard ==");
    match provider_from_env() {
        None => println!(
            "  (no LIGHTHOUSE_EVAL_PROVIDER set — model-free floor above is authoritative)"
        ),
        Some(cfg) => {
            let regs = register_tables(&ctx, &files, false).await;
            let sql_ctxs: Vec<Ctx> = regs
                .iter()
                .map(|r| Ctx {
                    name: r.file_name.clone(),
                    text: r.card.clone(),
                    score: 1.0,
                })
                .collect();
            // (question, numbers that MUST appear in the verified result)
            let nl: &[(&str, &[&str])] = &[
                ("What were total sales per month?", &["150", "225"]),
                ("What is the total of all amounts?", &["385"]),
            ];
            for (q, expect) in nl {
                match nl_answer(&ctx, &cfg, &sql_ctxs, q).await {
                    Ok((_, res)) => match contains(&res, expect) {
                        Ok(()) => println!("  PASS  {q:?}"),
                        Err(e) => {
                            failures += 1;
                            println!("  FAIL  {q:?}\n        {e}");
                        }
                    },
                    Err(e) => {
                        failures += 1;
                        println!("  FAIL  {q:?} — {e}");
                    }
                }
            }
            // Lead-with-the-number (time-savers 7): narrate the verified total
            // the way synth.rs does and require the figure on the FIRST
            // non-empty line of the answer — the SYSTEM_PROMPT Style rule,
            // observed end-to-end rather than assumed.
            let q = "What is the total of all amounts?";
            match nl_answer(&ctx, &cfg, &sql_ctxs, q).await {
                Ok((sql, res)) => {
                    let narration = narrate(&cfg, &sql_ctxs, q, &sql, &res).await;
                    match first_line_leads_with(&narration, "385") {
                        Ok(()) => {
                            println!(
                                "  PASS  narration leads with the number (385 on the first line)"
                            );
                        }
                        Err(e) => {
                            failures += 1;
                            println!("  FAIL  narration leads with the number\n        {e}");
                        }
                    }
                }
                Err(e) => {
                    failures += 1;
                    println!("  FAIL  narration leads with the number — setup: {e}");
                }
            }
        }
    }

    let _ = fs::remove_dir_all(&dir);
    if failures == 0 {
        println!("\nanalytics_eval: all checks passed");
        exit(0);
    }
    eprintln!("\nanalytics_eval: {failures} check(s) FAILED");
    exit(1);
}

fn provider_from_env() -> Option<ModelCfg> {
    let provider = std::env::var("LIGHTHOUSE_EVAL_PROVIDER").ok()?;
    Some(ModelCfg {
        provider_id: Some(provider),
        model_id: std::env::var("LIGHTHOUSE_EVAL_MODEL").ok(),
        api_key: std::env::var("LIGHTHOUSE_EVAL_KEY").ok(),
    })
}

/// The real analytics NL loop: model writes SQL, the guard vets it, the engine
/// executes it, and the VERIFIED result is returned (numbers never model text)
/// along with the executed SQL (the narration prompt embeds it).
async fn nl_answer(
    ctx: &SessionContext,
    cfg: &ModelCfg,
    sql_ctxs: &[Ctx],
    question: &str,
) -> Result<(String, QueryResult), String> {
    let prompt = sql_question(question, None);
    let mut stream = stream_answer(prompt, sql_ctxs.to_vec(), cfg.clone(), Vec::new(), None);
    let mut raw = String::new();
    while let Some(d) = stream.next().await {
        raw.push_str(&d);
    }
    let sql = extract_sql(&raw).ok_or_else(|| format!("no SQL in model reply: {raw}"))?;
    guard_sql(&sql)?;
    let res = run_query(ctx, &sql).await?;
    Ok((sql, res))
}

/// Narrate a verified result the way synth.rs does: the result rides as the
/// top context block, schema cards behind it, plus the chart card when the
/// untruncated result could chart. Returns the model's full narration text.
async fn narrate(
    cfg: &ModelCfg,
    schema_ctxs: &[Ctx],
    question: &str,
    sql: &str,
    res: &QueryResult,
) -> String {
    let mut ctxs = vec![Ctx {
        name: "query result — computed exactly by Lighthouse".to_string(),
        text: format!("SQL:\n{sql}\n\nResult ({} row(s)):\n{}", res.shown, res.markdown),
        score: 1.0,
    }];
    ctxs.extend(schema_ctxs.iter().cloned().map(|mut c| {
        c.name = format!("{} — schema", c.name);
        c.score = 0.0;
        c
    }));
    if !res.truncated {
        if let Some(card) = chart_card(&res.batches) {
            ctxs.push(Ctx {
                name: "chart options".to_string(),
                text: card,
                score: 0.0,
            });
        }
    }
    let mut stream = stream_answer(question.to_string(), ctxs, cfg.clone(), Vec::new(), None);
    let mut out = String::new();
    while let Some(d) = stream.next().await {
        out.push_str(&d);
    }
    out
}

/// Lead-with-the-number style check (SYSTEM_PROMPT Style section): the FIRST
/// non-empty line of the narration must already carry the expected figure.
fn first_line_leads_with(narration: &str, figure: &str) -> Result<(), String> {
    let first = narration
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    if first.contains(figure) {
        Ok(())
    } else {
        Err(format!(
            "first line {first:?} does not carry {figure:?}; full narration:\n{narration}"
        ))
    }
}

// --- Recipe golden helpers (openspec: add-recipes §4.1) --------------------------

/// Resolve + plan a recipe against a typed catalog and run EVERY template through
/// the same `run_query` the real executor uses. Returns (label, sql, verified
/// result) per step; any execution error (including the executor's "no rows") is
/// a golden failure, since each fixture is engineered to produce rows.
async fn run_recipe(
    ctx: &SessionContext,
    id: &str,
    table_name: &str,
    cols: &[(String, ColumnKind)],
) -> Result<Vec<(String, String, QueryResult)>, String> {
    let r = lookup(id).ok_or_else(|| format!("unknown recipe {id}"))?;
    let resolved = r
        .resolve(table_name, cols)
        .ok_or_else(|| format!("{id} did not resolve against {table_name}"))?;
    let plan = (r.plan)(&resolved);
    if plan.is_empty() {
        return Err(format!("{id} planned no queries"));
    }
    let mut out = Vec::new();
    for q in plan {
        let res = run_query(ctx, &q.sql)
            .await
            .map_err(|e| format!("{id} / {} failed to execute: {e}\nSQL: {}", q.label, q.sql))?;
        out.push((q.label, q.sql, res));
    }
    Ok(out)
}

/// A (small) result flattened to the exact cell strings DataFusion renders, with
/// the column order. Assertions pin ENGINE output (ryu-formatted floats like
/// "300.0", integer counts like "1"), never our own formatting.
fn grid(res: &QueryResult) -> (Vec<String>, Vec<Vec<String>>) {
    let mut cols: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    for b in &res.batches {
        if b.num_columns() == 0 {
            continue;
        }
        if cols.is_empty() {
            cols = b
                .schema()
                .fields()
                .iter()
                .map(|f| f.name().to_string())
                .collect();
        }
        for r in 0..b.num_rows() {
            rows.push(
                (0..b.num_columns())
                    .map(|c| array_value_to_string(b.column(c), r).unwrap_or_default())
                    .collect(),
            );
        }
    }
    (cols, rows)
}

/// The cell under column `col` in `row` (empty string if the column is absent).
fn cell<'a>(cols: &[String], row: &'a [String], col: &str) -> &'a str {
    cols.iter()
        .position(|c| c == col)
        .map(|i| row[i].as_str())
        .unwrap_or("")
}

/// Assert the FIRST row's named cells equal the expected rendered strings.
fn assert_row(res: &QueryResult, want: &[(&str, &str)]) -> Result<(), String> {
    let (cols, rows) = grid(res);
    let row = rows.first().ok_or_else(|| "empty result".to_string())?;
    check_cells(&cols, row, want)
}

/// Assert the row keyed by `key_col == key` has the named cells (order-independent).
fn assert_keyed(
    res: &QueryResult,
    key_col: &str,
    key: &str,
    want: &[(&str, &str)],
) -> Result<(), String> {
    let (cols, rows) = grid(res);
    let row = rows
        .iter()
        .find(|r| cell(&cols, r, key_col) == key)
        .ok_or_else(|| format!("no row with {key_col}={key:?} in {rows:?}"))?;
    check_cells(&cols, row, want)
}

fn check_cells(cols: &[String], row: &[String], want: &[(&str, &str)]) -> Result<(), String> {
    for (c, v) in want {
        let got = cell(cols, row, c);
        if got != *v {
            return Err(format!(
                "col {c:?}: got {got:?}, want {v:?} (cols={cols:?}, row={row:?})"
            ));
        }
    }
    Ok(())
}

/// Record a golden check into the failure counter, printing PASS/FAIL like the
/// rest of Section 1.
fn record(failures: &mut usize, what: &str, r: Result<(), String>) {
    match r {
        Ok(()) => println!("  PASS  {what}"),
        Err(e) => {
            *failures += 1;
            println!("  FAIL  {what}\n        {e}");
        }
    }
}
