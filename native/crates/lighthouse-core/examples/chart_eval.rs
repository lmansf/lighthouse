//! Chart correctness scorecard (openspec: add-chart-directive).
//!
//! Two sections, mirroring `analytics_eval.rs`:
//!
//!   1. MODEL-FREE floor (always runs; the CI gate): the known heuristic
//!      misfire classes (date-ish labels, top-N candidates, single-value
//!      results, identifier columns, float-encoded categories) run as CSV
//!      fixtures through the REAL executor (`run_query`), asserting the
//!      expected kind-or-none; the directive grammar/validator cases (unknown
//!      column, over-limit series, fabricated values, "none", title cap) run
//!      through the REAL parse → validate → materialize path (`decide_chart`);
//!      the chart card's budget and few-shot integrity are re-checked. The
//!      process exits non-zero on any violation, so heuristic or card drift is
//!      a reviewed diff.
//!
//!   2. PROVIDER NL scorecard (opt-in, never a CI gate): with
//!      `LIGHTHOUSE_EVAL_PROVIDER` (+ `LIGHTHOUSE_EVAL_MODEL`,
//!      `LIGHTHOUSE_EVAL_KEY`) set, a narration-shaped ask (verified result +
//!      chart card as context) runs end-to-end and the directive the model
//!      emits must validate against the real result columns — measuring
//!      whether the card actually teaches the mechanism. Without a provider it
//!      prints a note and exits 0.
//!
//! Run: `cargo run -p lighthouse-core --example chart_eval`

use std::fs;
use std::path::PathBuf;
use std::process::exit;

use datafusion::prelude::{CsvReadOptions, SessionContext};
use futures::StreamExt;
use lighthouse_core::analytics::{
    chart_card, chart_columns, decide_chart, parse_chart_directive, run_query,
    validate_directive, ChartDirectiveKind, DirectiveScrubber, QueryResult,
    CHART_CARD_MAX_CHARS,
};
use lighthouse_core::llm::{stream_answer, Ctx, ModelCfg};

/// A fixture written to the temp dir: (table name, CSV body).
const FIXTURES: &[(&str, &str)] = &[
    // Date-ish labels: months must chart as a time series (area), not bars.
    (
        "months",
        "month,total\n2024-01,1.0\n2024-02,2.0\n2024-03,3.0\n",
    ),
    // Top-N candidates: categorical bar (and a directed desc sort re-ranks it).
    (
        "topn",
        "customer,revenue\nacme,50\nglobex,900\ninitech,300\numbrella,120\nwayne,700\n",
    ),
    // Identifier columns: 4-digit ids in an id-NAMED column must not chart —
    // no fake time series, no meaningless bar per identifier.
    (
        "stores",
        "store_id,revenue\n1001,5.0\n1002,6.0\n1003,7.0\n1004,8.0\n",
    ),
    // Float-encoded categories (1.0..5.0) are keys → bar, never scatter.
    (
        "ratings",
        "rating,cnt\n1.0,3\n2.0,8\n3.0,20\n4.0,40\n5.0,12\n",
    ),
    // A genuinely continuous x keeps its scatter.
    ("weights", "weight,price\n10.5,1\n22.0,4\n30.0,9\n"),
    // Bare plausible years stay a time axis.
    ("years", "yr,total\n2019,5\n2020,6\n2021,7\n"),
];

/// One model-free golden: fixture SQL → the expected chart kind (None = "the
/// heuristic must decline").
struct Golden {
    what: &'static str,
    sql: &'static str,
    kind: Option<&'static str>,
}

const GOLDEN: &[Golden] = &[
    Golden {
        what: "date-ish labels chart as a time series (area)",
        sql: "SELECT month, total FROM months ORDER BY month",
        kind: Some("area"),
    },
    Golden {
        what: "top-N candidates chart as a categorical bar",
        sql: "SELECT customer, revenue FROM topn ORDER BY revenue DESC",
        kind: Some("bar"),
    },
    Golden {
        what: "a single-value result draws nothing",
        sql: "SELECT 'total' AS label, SUM(revenue) AS total FROM topn",
        kind: None,
    },
    Golden {
        what: "4-digit ids in an id-named column draw nothing by default",
        sql: "SELECT store_id, revenue FROM stores ORDER BY store_id",
        kind: None,
    },
    Golden {
        what: "float-encoded category keys stay a bar, not a scatter",
        sql: "SELECT rating, cnt FROM ratings ORDER BY rating",
        kind: Some("bar"),
    },
    Golden {
        what: "a genuinely continuous x keeps its scatter",
        sql: "SELECT weight, price FROM weights ORDER BY weight",
        kind: Some("scatter"),
    },
    Golden {
        what: "bare plausible years keep their time axis (area)",
        sql: "SELECT yr, total FROM years ORDER BY yr",
        kind: Some("area"),
    },
];

fn kind_of(spec: &Option<String>) -> Option<String> {
    spec.as_deref().and_then(|s| {
        serde_json::from_str::<serde_json::Value>(s)
            .ok()?
            .get("kind")?
            .as_str()
            .map(str::to_string)
    })
}

fn fence(json: &str) -> String {
    format!("```lighthouse-chart-request\n{json}\n```")
}

#[tokio::main]
async fn main() {
    let dir = std::env::temp_dir().join(format!("lh-chart-eval-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let ctx = SessionContext::new();
    let mut files: Vec<(String, String, PathBuf)> = Vec::new();
    for (table, body) in FIXTURES {
        let path = dir.join(format!("{table}.csv"));
        fs::write(&path, body).expect("write fixture");
        ctx.register_csv(*table, path.to_str().unwrap(), CsvReadOptions::new())
            .await
            .expect("register fixture");
        files.push((format!("{table}.csv"), format!("{table}.csv"), path));
    }

    let mut failures = 0usize;
    let mut check = |name: &str, outcome: Result<(), String>| match outcome {
        Ok(()) => println!("  PASS  {name}"),
        Err(e) => {
            failures += 1;
            println!("  FAIL  {name}\n        {e}");
        }
    };

    // --- Section 1a: heuristic misfire floor (always enforced) ------------
    println!("== model-free heuristic floor ==");
    for g in GOLDEN {
        let outcome = match run_query(&ctx, g.sql).await {
            Err(e) => Err(format!("query failed: {e}")),
            Ok(res) => {
                let got = kind_of(&res.chart);
                if got.as_deref() == g.kind {
                    Ok(())
                } else {
                    Err(format!("expected kind {:?}, got {:?}", g.kind, got))
                }
            }
        };
        check(g.what, outcome);
    }

    // --- Section 1b: directive floor (parse → validate → materialize) -----
    println!("\n== model-free directive floor ==");
    let stores: QueryResult = run_query(&ctx, "SELECT store_id, revenue FROM stores ORDER BY store_id")
        .await
        .expect("stores fixture");
    let topn: QueryResult = run_query(&ctx, "SELECT customer, revenue FROM topn ORDER BY revenue DESC")
        .await
        .expect("topn fixture");

    // A valid directive charts an id column DELIBERATELY, numbers straight
    // from the batches.
    let directed = decide_chart(
        &stores.batches,
        &fence(r#"{"kind":"bar","label_column":"store_id","series_columns":["revenue"]}"#),
    );
    check(
        "a valid directive charts an id column deliberately, from the batches",
        match directed.as_deref().map(serde_json::from_str::<serde_json::Value>) {
            Some(Ok(v))
                if v["kind"] == "bar"
                    && v["x"][0] == "1001"
                    && v["series"][0]["values"]
                        == serde_json::json!([5.0, 6.0, 7.0, 8.0]) =>
            {
                Ok(())
            }
            other => Err(format!("unexpected directed spec: {other:?}")),
        },
    );

    // Unknown column → byte-identical heuristic fallback (here: the topn bar).
    check(
        "an unknown column falls back to the unchanged heuristic",
        {
            let fallback = decide_chart(
                &topn.batches,
                &fence(r#"{"kind":"bar","label_column":"nope","series_columns":["revenue"]}"#),
            );
            if fallback == topn.chart {
                Ok(())
            } else {
                Err(format!("fallback {fallback:?} != heuristic {:?}", topn.chart))
            }
        },
    );

    // "none" suppresses a chart the heuristic would draw.
    check(
        "\"none\" suppresses the auto-chart",
        match decide_chart(&topn.batches, &fence(r#"{"kind":"none"}"#)) {
            None => Ok(()),
            Some(s) => Err(format!("charted anyway: {s}")),
        },
    );

    // Fabricated x/values keys are ignored wholesale — same spec either way.
    check(
        "fabricated x/values keys are ignored wholesale",
        {
            let clean = decide_chart(
                &topn.batches,
                &fence(r#"{"kind":"bar","label_column":"customer","series_columns":["revenue"]}"#),
            );
            let stuffed = decide_chart(
                &topn.batches,
                &fence(
                    r#"{"kind":"bar","label_column":"customer","series_columns":["revenue"],"x":["fake"],"values":[1,2]}"#,
                ),
            );
            if clean.is_some() && clean == stuffed {
                Ok(())
            } else {
                Err(format!("clean {clean:?} != stuffed {stuffed:?}"))
            }
        },
    );

    // Over-limit series and malformed JSON both land on the heuristic.
    check(
        "4+ series falls back to the heuristic",
        {
            let got = decide_chart(
                &topn.batches,
                &fence(
                    r#"{"kind":"bar","label_column":"customer","series_columns":["revenue","revenue","revenue","revenue"]}"#,
                ),
            );
            if got == topn.chart { Ok(()) } else { Err(format!("{got:?}")) }
        },
    );
    check(
        "malformed JSON falls back to the heuristic",
        {
            let got = decide_chart(&topn.batches, &fence("not json at all"));
            if got == topn.chart { Ok(()) } else { Err(format!("{got:?}")) }
        },
    );

    // The title is capped display copy — never more than 80 chars survive.
    check(
        "the directive title is capped at 80 chars",
        {
            let long = "x".repeat(120);
            let got = decide_chart(
                &topn.batches,
                &fence(&format!(
                    r#"{{"kind":"bar","label_column":"customer","series_columns":["revenue"],"title":"{long}"}}"#
                )),
            );
            match got.as_deref().map(serde_json::from_str::<serde_json::Value>) {
                Some(Ok(v)) if v["title"].as_str().map(|t| t.chars().count()) == Some(80) => Ok(()),
                other => Err(format!("unexpected: {other:?}")),
            }
        },
    );

    // The sort is applied engine-side, by the first series column.
    check(
        "sort=asc re-ranks engine-side without touching a number",
        {
            let got = decide_chart(
                &topn.batches,
                &fence(
                    r#"{"kind":"bar","label_column":"customer","series_columns":["revenue"],"sort":"asc"}"#,
                ),
            );
            match got.as_deref().map(serde_json::from_str::<serde_json::Value>) {
                Some(Ok(v))
                    if v["x"][0] == "acme"
                        && v["series"][0]["values"]
                            == serde_json::json!([50.0, 120.0, 300.0, 700.0, 900.0]) =>
                {
                    Ok(())
                }
                other => Err(format!("unexpected: {other:?}")),
            }
        },
    );

    // --- Section 1c: card + stream floor -----------------------------------
    println!("\n== model-free card + stream floor ==");
    check(
        "the chart card rides chartable results and stays inside budget",
        match chart_card(&topn.batches) {
            Some(card) if card.chars().count() <= CHART_CARD_MAX_CHARS => Ok(()),
            Some(card) => Err(format!("card budget blown: {} chars", card.chars().count())),
            None => Err("no card for a chartable result".to_string()),
        },
    );
    let single = run_query(&ctx, "SELECT 'total' AS label, SUM(revenue) AS total FROM topn")
        .await
        .expect("single fixture");
    check(
        "no card is built for an unchartable (single-value) result",
        match chart_card(&single.batches) {
            None => Ok(()),
            Some(_) => Err("card built for a single-value result".to_string()),
        },
    );
    check(
        "fence bytes never reach forwarded prose (stream scrub)",
        {
            let mut scrub = DirectiveScrubber::new();
            let mut out = String::new();
            for d in [
                "NW leads [1].\n\n```lighthouse-",
                "chart-request\n{\"kind\":\"none\"}\n``",
                "`\nDone.",
            ] {
                out.push_str(&scrub.push(d));
            }
            out.push_str(&scrub.finish());
            if out == "NW leads [1].\n\nDone." && !out.contains("```") {
                Ok(())
            } else {
                Err(format!("forwarded prose: {out:?}"))
            }
        },
    );

    // --- Section 2: provider NL scorecard (opt-in; never a CI gate) -------
    println!("\n== provider NL scorecard ==");
    match provider_from_env() {
        None => println!(
            "  (no LIGHTHOUSE_EVAL_PROVIDER set — model-free floor above is authoritative)"
        ),
        Some(cfg) => {
            // The narration shape synth.rs builds: verified result + chart
            // card as context; the model may end with ONE chart request.
            let res = &stores;
            let card = chart_card(&res.batches).expect("card for stores");
            let ctxs = vec![
                Ctx {
                    name: "query result — computed exactly by Lighthouse".to_string(),
                    text: format!(
                        "SQL:\nSELECT store_id, revenue FROM stores ORDER BY store_id\n\nResult ({} row(s)):\n{}",
                        res.shown, res.markdown
                    ),
                    score: 1.0,
                },
                Ctx { name: "chart options".to_string(), text: card, score: 0.0 },
            ];
            let mut stream = stream_answer(
                "How does revenue compare across our stores?".to_string(),
                ctxs,
                cfg,
                Vec::new(),
            );
            let mut raw = String::new();
            while let Some(d) = stream.next().await {
                raw.push_str(&d);
            }
            match parse_chart_directive(&raw) {
                None if raw.contains("lighthouse-chart-request") => {
                    failures += 1;
                    println!("  FAIL  the model emitted a fence the engine cannot parse:\n{raw}");
                }
                None => println!("  NOTE  no chart request emitted (allowed — the card says MAY)"),
                Some(d) if d.kind == ChartDirectiveKind::None => {
                    println!("  PASS  the model explicitly declined the chart (\"none\")");
                }
                Some(d) => match validate_directive(&d, &chart_columns(&res.batches)) {
                    Ok(()) => println!("  PASS  the emitted directive validates: {d:?}"),
                    Err(e) => {
                        failures += 1;
                        println!("  FAIL  the emitted directive is invalid ({e}): {d:?}");
                    }
                },
            }
        }
    }

    let _ = fs::remove_dir_all(&dir);
    if failures == 0 {
        println!("\nchart_eval: all checks passed");
        exit(0);
    }
    eprintln!("\nchart_eval: {failures} check(s) FAILED");
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
