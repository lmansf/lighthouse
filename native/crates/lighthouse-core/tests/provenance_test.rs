//! Per-answer provenance stamp (privacy-legibility, Section 1B): the engine
//! stamps the FINAL chunk with `meta { origin, excerptCount, sourceFileCount }`.
//! This asserts the stamp AGREES with what the transport choke point records in
//! the audit log for the SAME answer — `meta.origin` ⇔ the audit `provider`
//! (device⇔local/none), and `meta.sourceFileCount` ⇔ the audit `fileIds.length`
//! — so the two transparency surfaces can never quietly disagree.
//!
//! A vault meta-answer ("What's new this week?") is model-free, so the whole
//! path runs with zero network for every provider — including a cloud one,
//! which still stamps its own id.

mod common;

use futures::StreamExt;
use lighthouse_core::contracts::ChatChunk;
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::answer_pipeline;
use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// How the transport choke point (routes.rs / commands.rs) derives the audit
/// record's `provider` from the active model config — replicated verbatim so the
/// agreement assertion tests the real contract, not a restatement of it.
fn audit_provider(cfg: &ModelCfg) -> String {
    cfg.provider_id.clone().unwrap_or_else(|| "none".to_string())
}

/// Drive the pipeline to completion and return its terminating (`done`) chunk.
async fn final_chunk_for(cfg: ModelCfg) -> ChatChunk {
    let mut stream = answer_pipeline(
        "What's new this week?".to_string(),
        vec!["sales.csv".to_string(), "notes.md".to_string()],
        vec![],
        vec![],
        cfg,
    );
    let mut last_done: Option<ChatChunk> = None;
    while let Some(c) = stream.next().await {
        if c.done {
            last_done = Some(c);
        }
    }
    last_done.expect("pipeline emits a terminating chunk")
}

#[tokio::test]
async fn stamp_origin_and_source_count_agree_with_the_audit_record() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(
        &dir.path().join("sales.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
    );
    write(&dir.path().join("notes.md"), "# planning\nsome prose\n");
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);
    vault::set_included("notes.md", true);

    // The three provider shapes the choke point distinguishes: the private local
    // model, the model-free fallback (no provider), and a cloud vendor. Each
    // hits the model-free meta branch here, so no network is touched — but each
    // must still stamp the origin the audit would record.
    let cases = [
        ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None },
        ModelCfg { provider_id: None, model_id: None, api_key: None },
        ModelCfg {
            provider_id: Some("anthropic".into()),
            model_id: Some("claude-opus-4-8".into()),
            api_key: None,
        },
    ];

    for cfg in cases {
        // What the audit choke point would record for this same answer.
        let provider = audit_provider(&cfg);

        let chunk = final_chunk_for(cfg).await;
        let meta = chunk.meta.expect("final chunk carries a provenance stamp");
        let refs = chunk.references.unwrap_or_default();
        // The audit record's fileIds are exactly the final chunk's reference ids.
        let file_ids: Vec<String> = refs.iter().map(|r| r.file_id.clone()).collect();

        // origin ⇔ provider: "device" iff the audit provider is local/none,
        // otherwise the cloud id verbatim.
        let expected_origin = if provider == "local" || provider == "none" {
            "device"
        } else {
            provider.as_str()
        };
        assert_eq!(
            meta.origin, expected_origin,
            "stamp origin must agree with the audit provider {provider:?}"
        );

        // sourceFileCount ⇔ fileIds.length for the same answer.
        assert_eq!(
            meta.source_file_count,
            file_ids.len(),
            "stamp sourceFileCount must equal the audit fileIds length"
        );
        // The meta answer is model-free: zero excerpts were handed to a model.
        assert_eq!(meta.excerpt_count, 0, "a model-free answer sent no excerpts");
        // Sanity: this fixture cites both included files.
        assert_eq!(meta.source_file_count, 2, "both included files are cited");
    }
}
