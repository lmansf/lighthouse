//! Recipes end-to-end (openspec: add-recipes §5.1) — the recipe branch driven
//! through the REAL streaming pipeline (`answer_pipeline`) over a real CSV vault,
//! so registration types the date column exactly as production does (an ISO-date
//! CSV column registers as Date32 — the recipe's cast-then-substr month bucket
//! must survive that). Covers: the LOCAL/extractive path (result tables +
//! provenance footer + the §1 assumption ledger, NO narration), the cloud
//! posture's freshness stamp, and that a recipe result's representative query
//! rechecks through the pin/board re-execution path (`run_direct`).

mod common;

use futures::StreamExt;
use lighthouse_core::analytics::run_direct;
use lighthouse_core::answer_cache::CacheCtl;
use lighthouse_core::contracts::ChatChunk;
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::answer_pipeline;
use lighthouse_core::vault;

const BYPASS: CacheCtl = CacheCtl {
    bypass_cache: true,
    persist_allowed: false,
};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A two-month sales table: Feb = 60 + 40 = 100, Mar = 100 + 200 = 300.
const SALES: &str = "d,region,amount\n\
     2024-02-10,North,60\n\
     2024-02-15,South,40\n\
     2024-03-05,North,100\n\
     2024-03-12,South,200\n";

async fn collect(
    mut stream: std::pin::Pin<Box<dyn futures::Stream<Item = ChatChunk> + Send>>,
) -> (String, Vec<ChatChunk>) {
    // The recipe branch emits no provisional draft, so the answer text is simply
    // every delta in order (progress chunks carry an empty delta).
    let mut text = String::new();
    let mut chunks = Vec::new();
    while let Some(c) = stream.next().await {
        text.push_str(&c.delta);
        chunks.push(c);
    }
    (text, chunks)
}

#[tokio::test]
async fn variance_recipe_local_path_tables_ledger_no_narration() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("sales.csv"), SALES);
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);

    // Extractive/local cfg: no provider ⇒ no model ⇒ NO narration. The recipe
    // still runs (it plans model-free, before the has_real_model gate).
    let (text, chunks) = collect(answer_pipeline(
        "run-recipe:variance-vs-last-period on sales.csv".to_string(),
        vec!["sales.csv".to_string()],
        vec![],
        vec![],
        ModelCfg::default(),
        BYPASS,
        vec![],
    ))
    .await;

    // Engine-computed variance over REAL CSV dates (registered Date32): the
    // cast-then-substr month bucket survives the production typing.
    assert!(text.contains("300"), "current (Mar) total 300 present:\n{text}");
    assert!(text.contains("100"), "prior (Feb) total 100 present:\n{text}");
    // Provenance footer lists the executed query, and the §1 assumption ledger
    // rides the answer naming the date column.
    assert!(
        text.contains("*Query used:*") || text.contains("*Queries used"),
        "provenance footer present:\n{text}"
    );
    assert!(text.contains("*Assumptions:*"), "assumption ledger present:\n{text}");
    assert!(
        text.contains("Date column: `d`"),
        "ledger names the date column:\n{text}"
    );
    // The freshness stamp names the source it read.
    assert!(text.contains("Computed from"), "freshness stamp present:\n{text}");
    // LOCAL path: no model was ever called, so there is no narration and no
    // "model unavailable" note — the deterministic tables + footers ARE the answer.
    assert!(
        !text.contains("model unavailable"),
        "extractive path calls no model:\n{text}"
    );

    // The terminating chunk carries the recipe's representative query so
    // pin/board/Edit-SQL keep working (the multi-step single-SQL contract).
    let done = chunks.iter().find(|c| c.done).expect("terminating chunk");
    let meta = done
        .analytics
        .as_ref()
        .expect("recipe answer carries AnalyticsMeta");
    assert!(
        meta.sql.contains("substr(CAST(d AS VARCHAR)") && meta.sql.to_lowercase().contains("sum(amount)"),
        "representative query is the variance primary template: {}",
        meta.sql
    );
}

#[tokio::test]
async fn recipe_result_rechecks_through_the_pin_board_path() {
    // "Pin the result to a board" exercises the pin/board/Edit-SQL re-execution
    // seam, which re-runs the pinned answer's representative query through
    // `run_direct` (the guarded model-free path behind pin rechecks). A recipe
    // result must recheck to the SAME engine numbers as any answer.
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("sales.csv"), SALES);
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);

    // Pull the representative query the recipe answer pinned.
    let (_text, chunks) = collect(answer_pipeline(
        "run-recipe:variance-vs-last-period on sales.csv".to_string(),
        vec!["sales.csv".to_string()],
        vec![],
        vec![],
        ModelCfg::default(),
        BYPASS,
        vec![],
    ))
    .await;
    let sql = chunks
        .iter()
        .find(|c| c.done)
        .and_then(|c| c.analytics.as_ref())
        .map(|m| m.sql.clone())
        .expect("recipe answer carries a representative query");

    // Re-execute it exactly as a pin recheck / board card would.
    let recheck = run_direct(&sql, &["sales.csv".to_string()])
        .await
        .expect("the representative query rechecks");
    assert!(
        recheck.markdown.contains("300") && recheck.markdown.contains("100"),
        "recheck recomputes the same current/prior totals:\n{}",
        recheck.markdown
    );
    assert!(
        recheck.footer.contains("Computed from"),
        "recheck carries its own provenance stamp:\n{}",
        recheck.footer
    );
}

#[tokio::test]
async fn recipe_cloud_posture_stamps_the_source_accurately() {
    // The cloud posture (a provider is selected) narrates over the results, but
    // the deterministic core — result tables, provenance footer, ledger, and the
    // freshness STAMP — never depends on narration (RISK-4). With no key the
    // narration is unavailable, yet the stamp + numbers still land accurately.
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("sales.csv"), SALES);
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);

    let cfg = ModelCfg {
        provider_id: Some("openai".to_string()),
        ..ModelCfg::default()
    };
    let (text, _chunks) = collect(answer_pipeline(
        "run-recipe:variance-vs-last-period on sales.csv".to_string(),
        vec!["sales.csv".to_string()],
        vec![],
        vec![],
        cfg,
        BYPASS,
        vec![],
    ))
    .await;

    // The engine numbers + the freshness stamp are present regardless of whether
    // the (keyless) model could narrate — the stamp is accurate on the cloud path.
    assert!(text.contains("300") && text.contains("100"), "engine numbers present:\n{text}");
    assert!(text.contains("Computed from"), "cloud-path freshness stamp present:\n{text}");
    assert!(text.contains("*Assumptions:*"), "ledger rides the cloud path too:\n{text}");
}
