//! Answer cache (openspec: add-answer-cache). Key composition over a real
//! vault (provider / model / attachments / local-only marks / per-file
//! freshness each re-key; normalization folds case, whitespace, and trailing
//! punctuation only), the history-gated store (history-off writes nothing and
//! deletes the disk mirror; history-on round-trips a bounded LRU through
//! disk), corrupt-store self-heal, and the E2E replay contract over the
//! model-free meta path: an unchanged question replays verbatim with a
//! `cachedAt` stamp and zero pipeline work; touching a source file runs live
//! again. The node twin is test/answerCache.test.mjs over the SAME fixture
//! values.

mod common;

use futures::StreamExt;
use lighthouse_core::answer_cache::{self, CacheCtl, CachedAnswer};
use lighthouse_core::contracts::{ChatChunk, ChunkMeta};
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::answer_pipeline;
use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// The store file the persistence gate manages (tests run without
/// LIGHTHOUSE_APP_STATE_DIR, so it falls back beside the vault state).
fn cache_file() -> std::path::PathBuf {
    lighthouse_core::config::app_state_dir().join("answer-cache.json")
}

fn entry(text: &str) -> CachedAnswer {
    CachedAnswer {
        key: String::new(), // stamped by insert
        created_ms: 1_000,
        text: text.to_string(),
        references: Vec::new(),
        analytics: None,
        meta: ChunkMeta {
            origin: "device".into(),
            excerpt_count: 0,
            source_file_count: 0,
            cached_at: None,
        },
    }
}

const ALLOWED: CacheCtl = CacheCtl { bypass_cache: false, persist_allowed: true };
const DISALLOWED: CacheCtl = CacheCtl { bypass_cache: false, persist_allowed: false };

// --- Key composition (fixture shared with the TS twin) ----------------------------

#[test]
fn every_key_component_is_load_bearing_and_normalization_folds_noise_only() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();
    write(&dir.path().join("report.md"), "quarterly revenue summary");
    write(&dir.path().join("private.csv"), "region,revenue\nNE,100\n");
    vault::invalidate_walk_cache();
    vault::set_included("report.md", true);
    vault::set_included("private.csv", true);

    let q = "What were Q3 sales?";
    let base = answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &[], &[], true);

    // Normalization: case, whitespace, and trailing `?!.` fold — nothing else.
    assert_eq!(
        answer_cache::cache_key("  what   WERE q3 sales?! ", Some("openai"), Some("gpt-5-mini"), &[], &[], true),
        base
    );
    assert_ne!(
        answer_cache::cache_key("What were Q4 sales?", Some("openai"), Some("gpt-5-mini"), &[], &[], true),
        base,
        "a reworded question is a different key"
    );

    // Provider and model each re-key (a different narrator is a different answer).
    assert_ne!(answer_cache::cache_key(q, Some("anthropic"), Some("gpt-5-mini"), &[], &[], true), base);
    assert_ne!(answer_cache::cache_key(q, Some("openai"), Some("gpt-5"), &[], &[], true), base);

    // The attachment SET re-keys; its order does not.
    let one = vec!["report.md".to_string()];
    let ab = vec!["report.md".to_string(), "private.csv".to_string()];
    let ba = vec!["private.csv".to_string(), "report.md".to_string()];
    let with_one = answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &one, &[], true);
    assert_ne!(with_one, base);
    assert_eq!(
        answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &ab, &[], true),
        answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &ba, &[], true)
    );

    // A local-only mark flip re-keys the CLOUD ask (the provider-effective
    // candidate set shrank) and leaves the DEVICE ask alone (the mark is inert
    // on-device — byte-identical answers, so the cache may keep serving).
    let device_base = answer_cache::cache_key(q, Some("local"), None, &[], &[], false);
    vault::set_local_only("private.csv", true);
    assert_ne!(answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &[], &[], true), base);
    assert_eq!(answer_cache::cache_key(q, Some("local"), None, &[], &[], false), device_base);

    // Per-file freshness: touching a candidate (new mtime/size) re-keys.
    write(&dir.path().join("report.md"), "quarterly revenue summary — updated");
    assert_ne!(answer_cache::cache_key(q, Some("local"), None, &[], &[], false), device_base);
}

// --- The history gate --------------------------------------------------------------

#[test]
fn history_off_serves_memory_only_and_deletes_the_disk_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();

    // An allowed insert writes through.
    answer_cache::insert("k1", entry("one"), ALLOWED);
    assert!(cache_file().exists(), "history-on mirrors to disk");

    // A disallowed ask still hits IN MEMORY — and removes the disk file.
    let hit = answer_cache::lookup("k1", DISALLOWED);
    assert_eq!(hit.map(|h| h.text), Some("one".to_string()));
    assert!(!cache_file().exists(), "history-off deletes the persisted cache");

    // Disallowed inserts never write anything.
    answer_cache::insert("k2", entry("two"), DISALLOWED);
    assert!(!cache_file().exists());
    assert!(answer_cache::lookup("k2", DISALLOWED).is_some(), "memory still serves");

    // Bypass skips the lookup itself, but the posture still applies.
    answer_cache::insert("k3", entry("three"), ALLOWED);
    assert!(cache_file().exists());
    assert!(
        answer_cache::lookup("k3", CacheCtl { bypass_cache: true, persist_allowed: false }).is_none(),
        "bypass always misses"
    );
    assert!(!cache_file().exists(), "a bypassed disallowed ask still clears the mirror");
}

#[test]
fn lru_is_bounded_at_64_touch_refreshes_and_the_store_round_trips_disk() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();

    for i in 0..70 {
        answer_cache::insert(&format!("k{i}"), entry(&format!("t{i}")), ALLOWED);
    }
    // Bounded: the six least-recent entries were evicted.
    assert!(answer_cache::lookup("k0", ALLOWED).is_none());
    assert!(answer_cache::lookup("k5", ALLOWED).is_none());
    assert!(answer_cache::lookup("k6", ALLOWED).is_some());
    assert!(answer_cache::lookup("k69", ALLOWED).is_some());

    // A hit is an LRU touch: k6 (just read) survives the next eviction; k7
    // (now least recent) does not.
    answer_cache::insert("k70", entry("t70"), ALLOWED);
    assert!(answer_cache::lookup("k7", ALLOWED).is_none(), "least-recent evicts");
    assert!(answer_cache::lookup("k6", ALLOWED).is_some(), "a touched entry survives");

    // Round-trips disk: a fresh process (reset) reloads the same bounded set.
    answer_cache::reset_store();
    assert_eq!(
        answer_cache::lookup("k69", ALLOWED).map(|h| h.text),
        Some("t69".to_string())
    );
    assert!(answer_cache::lookup("k0", ALLOWED).is_none());
}

#[test]
fn corrupt_or_version_mismatched_store_is_a_miss_and_self_heals() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();

    // Corrupt file: reads as empty (miss ⇒ live), never an error.
    std::fs::create_dir_all(cache_file().parent().unwrap()).unwrap();
    std::fs::write(cache_file(), "{ not json").unwrap();
    assert!(answer_cache::lookup("k", ALLOWED).is_none());

    // The next allowed insert rewrites the store cleanly.
    answer_cache::insert("k", entry("fresh"), ALLOWED);
    answer_cache::reset_store();
    assert_eq!(
        answer_cache::lookup("k", ALLOWED).map(|h| h.text),
        Some("fresh".to_string()),
        "the rewritten store round-trips"
    );

    // An envelope version bump reads as empty too (doubt means live).
    std::fs::write(
        cache_file(),
        r#"{"v":2,"entries":[{"key":"k9","createdMs":1,"text":"x","references":[],"meta":{"origin":"device","excerptCount":0,"sourceFileCount":0}}]}"#,
    )
    .unwrap();
    answer_cache::reset_store();
    assert!(answer_cache::lookup("k9", ALLOWED).is_none(), "version mismatch is a miss");
}

// --- E2E over the model-free meta path ---------------------------------------------

async fn drive(
    mut stream: std::pin::Pin<Box<dyn futures::Stream<Item = ChatChunk> + Send>>,
) -> (String, Vec<ChatChunk>) {
    let mut text = String::new();
    let mut chunks: Vec<ChatChunk> = Vec::new();
    while let Some(c) = stream.next().await {
        text.push_str(&c.delta);
        chunks.push(c);
    }
    (text, chunks)
}

#[tokio::test]
async fn unchanged_question_replays_verbatim_and_a_touched_file_runs_live() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();
    write(
        &dir.path().join("sales.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
    );
    write(&dir.path().join("notes.md"), "# planning\nsome prose\n");
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);
    vault::set_included("notes.md", true);

    let ids = vec!["sales.csv".to_string(), "notes.md".to_string()];
    let cfg = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let ask = |cfg: ModelCfg| {
        answer_pipeline(
            "What's new this week?".to_string(),
            ids.clone(),
            vec![],
            vec![],
            cfg,
            Default::default(),
            vec![],
        )
    };

    // 1st ask: live over the deterministic meta path — no replay stamp.
    let (text1, chunks1) = drive(ask(cfg.clone())).await;
    let done1 = chunks1.iter().find(|c| c.done).expect("terminating chunk");
    assert!(!text1.trim().is_empty());
    assert!(done1.meta.as_ref().unwrap().cached_at.is_none(), "a live answer carries no cachedAt");

    // 2nd ask, nothing changed: a verbatim replay — byte-equal text, the same
    // references and stamp, `cachedAt` present, and the whole stream is
    // exactly ONE text chunk + the final chunk (no progress, no draft).
    let (text2, chunks2) = drive(ask(cfg.clone())).await;
    assert_eq!(text2, text1, "replay is byte-verbatim");
    assert_eq!(chunks2.len(), 2, "one text chunk + one final chunk");
    assert!(chunks2[0].progress.is_none() && chunks2[0].draft.is_none());
    let done2 = chunks2.last().unwrap();
    assert!(done2.done);
    let meta2 = done2.meta.as_ref().unwrap();
    assert!(meta2.cached_at.is_some(), "replay stamps the original answer time");
    let refs = |c: &ChatChunk| -> Vec<String> {
        c.references.iter().flatten().map(|r| r.file_id.clone()).collect()
    };
    assert_eq!(refs(done2), refs(done1), "replayed references match the original");
    assert_eq!(meta2.origin, done1.meta.as_ref().unwrap().origin);
    // Default (absent) persistence verdict: nothing ever landed on disk.
    assert!(!cache_file().exists(), "memory-only by default — no disk mirror");

    // Touch a source file (content + size change) → the ask-time key changes
    // → the same question runs LIVE again.
    write(
        &dir.path().join("sales.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n2026-01-07,SE,75\n",
    );
    vault::invalidate_walk_cache();
    let (_text3, chunks3) = drive(ask(cfg)).await;
    let done3 = chunks3.iter().find(|c| c.done).expect("terminating chunk");
    assert!(
        done3.meta.as_ref().unwrap().cached_at.is_none(),
        "a touched candidate invalidates — the answer ran live"
    );
}

/// Re-run (`bypass_cache`) skips the lookup, runs live, and REFRESHES the
/// entry: the replay that follows carries the refreshed `created_ms`.
#[tokio::test]
async fn bypass_runs_live_and_refreshes_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
    answer_cache::reset_store();
    write(&dir.path().join("notes.md"), "# planning\nsome prose\n");
    vault::invalidate_walk_cache();
    vault::set_included("notes.md", true);

    let ids = vec!["notes.md".to_string()];
    let cfg = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let ask = |cache: CacheCtl| {
        answer_pipeline(
            "What's new this week?".to_string(),
            ids.clone(),
            vec![],
            vec![],
            cfg.clone(),
            cache,
            vec![],
        )
    };

    let (_t1, _c1) = drive(ask(CacheCtl::default())).await; // live, inserted
    let (_t2, c2) = drive(ask(CacheCtl::default())).await; // hit
    let first_stamp = c2.last().unwrap().meta.as_ref().unwrap().cached_at.expect("hit");

    // Bypass: live again (no cachedAt), entry refreshed…
    let (_t3, c3) = drive(ask(CacheCtl { bypass_cache: true, persist_allowed: false })).await;
    assert!(
        c3.iter().find(|c| c.done).unwrap().meta.as_ref().unwrap().cached_at.is_none(),
        "bypass runs live"
    );
    // …so the next plain ask replays with a stamp at least as new.
    let (_t4, c4) = drive(ask(CacheCtl::default())).await;
    let second_stamp = c4.last().unwrap().meta.as_ref().unwrap().cached_at.expect("hit again");
    assert!(second_stamp >= first_stamp, "Re-run refreshed the entry");
}
