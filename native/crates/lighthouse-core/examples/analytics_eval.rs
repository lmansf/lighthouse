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
//!      result. With no provider configured it prints a note and exits 0, so it
//!      never flakes CI.
//!
//! Run: `cargo run -p lighthouse-core --example analytics_eval`
//! With a provider:
//!   LIGHTHOUSE_EVAL_PROVIDER=anthropic LIGHTHOUSE_EVAL_MODEL=claude-… \
//!   LIGHTHOUSE_EVAL_KEY=sk-… cargo run -p lighthouse-core --example analytics_eval

use std::fs;
use std::path::PathBuf;
use std::process::exit;

use datafusion::prelude::{CsvReadOptions, SessionContext};
use futures::StreamExt;
use lighthouse_core::analytics::{
    extract_sql, guard_sql, register_tables, run_query, sql_question, QueryResult,
};
use lighthouse_core::llm::{stream_answer, Ctx, ModelCfg};

/// A fixture written to the temp vault: (file name, CSV body).
const FIXTURES: &[(&str, &str)] = &[
    // ISO dates + a numeric measure — exercises month grouping via substr.
    (
        "sales.csv",
        "d,amount\n2024-01-05,100\n2024-01-20,50\n2024-02-10,200\n2024-02-25,25\n2024-03-01,10\n",
    ),
    // A numeric column with a blank cell — exercises null-skipping AVG.
    ("ratios.csv", "region,ratio\nNE,2.0\nNW,4.0\nSE,\nS,6.0\n"),
];

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
];

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
                    Ok(res) => match contains(&res, expect) {
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
/// executes it, and the VERIFIED result is returned (numbers never model text).
async fn nl_answer(
    ctx: &SessionContext,
    cfg: &ModelCfg,
    sql_ctxs: &[Ctx],
    question: &str,
) -> Result<QueryResult, String> {
    let prompt = sql_question(question, None);
    let mut stream = stream_answer(prompt, sql_ctxs.to_vec(), cfg.clone(), Vec::new());
    let mut raw = String::new();
    while let Some(d) = stream.next().await {
        raw.push_str(&d);
    }
    let sql = extract_sql(&raw).ok_or_else(|| format!("no SQL in model reply: {raw}"))?;
    guard_sql(&sql)?;
    run_query(ctx, &sql).await
}
