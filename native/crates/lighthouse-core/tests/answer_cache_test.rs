//! Answer cache (openspec: add-answer-cache). Key composition over a real
//! conversation workspace (provider / model / attachment subset / attachment
//! CONTENT each re-key; normalization folds case, whitespace, and trailing
//! punctuation only), the history-gated store (history-off writes nothing and
//! deletes the disk mirror; history-on round-trips a bounded LRU through
//! disk), corrupt-store self-heal, and the E2E replay contract over the
//! model-free meta path: an unchanged question replays verbatim with a
//! `cachedAt` stamp and zero pipeline work; a changed corpus runs live again.
//! The node twin is test/answerCache.test.mjs over the SAME fixture values.
//!
//! Two vault-era key components went with the vault: the local-only mark (no
//! per-file cloud gate survives — the provider choice IS the gate) and the
//! `mtime:size` freshness heuristic, replaced by the attachment's content
//! hash. The hash is strictly better: exact rather than approximate, and
//! LOCAL, so one conversation's change can no longer invalidate another's
//! entries.

mod common;

use futures::StreamExt;
use lighthouse_core::answer_cache::{self, CacheCtl, CachedAnswer};
use lighthouse_core::beam::PlanCtl;
use lighthouse_core::contracts::{
    AnalyticsMeta, ChatChunk, ChunkMeta, CostMeta, CtxManifestEntry, TrustVerdict,
};
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::{answer_pipeline, Corpus};
use lighthouse_core::workspace;

/// The store file the persistence gate manages.
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
            cost: None,
            manifest: None,
            chart: None,
            table: None,
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
    answer_cache::reset_store();
    const CONV: &str = "conv-key";
    let ids = common::attach_all(
        CONV,
        &[
            ("report.md", b"quarterly revenue summary"),
            ("private.csv", b"region,revenue\nNE,100\n"),
        ],
    );
    let key = |q: &str, provider: Option<&str>, model: Option<&str>, atts: &[String]| {
        answer_cache::workspace_cache_key(CONV, q, provider, model, atts)
    };

    let q = "What were Q3 sales?";
    let base = key(q, Some("openai"), Some("gpt-5-mini"), &[]);

    // Normalization: case, whitespace, and trailing `?!.` fold — nothing else.
    assert_eq!(key("  what   WERE q3 sales?! ", Some("openai"), Some("gpt-5-mini"), &[]), base);
    assert_ne!(
        key("What were Q4 sales?", Some("openai"), Some("gpt-5-mini"), &[]),
        base,
        "a reworded question is a different key"
    );

    // Provider and model each re-key (a different narrator is a different answer).
    assert_ne!(key(q, Some("anthropic"), Some("gpt-5-mini"), &[]), base);
    assert_ne!(key(q, Some("openai"), Some("gpt-5"), &[]), base);

    // The attachment SUBSET re-keys; its order does not.
    let one = vec![ids[0].clone()];
    let ab = vec![ids[0].clone(), ids[1].clone()];
    let ba = vec![ids[1].clone(), ids[0].clone()];
    assert_ne!(key(q, Some("openai"), Some("gpt-5-mini"), &one), base);
    assert_eq!(
        key(q, Some("openai"), Some("gpt-5-mini"), &ab),
        key(q, Some("openai"), Some("gpt-5-mini"), &ba)
    );

    // Attachment CONTENT re-keys: attaching a further file changes the
    // conversation's candidate digest, so the whole-conversation key moves…
    let whole_before = key(q, Some("local"), None, &[]);
    let subset_before = key(q, Some("local"), None, &one);
    workspace::attach(CONV, "addendum.md", b"a late arrival").unwrap();
    assert_ne!(key(q, Some("local"), None, &[]), whole_before, "a new attachment re-keys");
    // …while a key SCOPED to a named subset is untouched by a file outside it.
    // That locality is the whole point of the content-hash digest: in the vault
    // era ANY change under the folder invalidated EVERY entry.
    assert_eq!(
        key(q, Some("local"), None, &one),
        subset_before,
        "a subset key depends only on the subset"
    );

    // Two conversations holding byte-identical files key identically — the
    // portability the vault-era global digest could never offer.
    common::attach_all(
        "conv-twin",
        &[
            ("report.md", b"quarterly revenue summary"),
            ("private.csv", b"region,revenue\nNE,100\n"),
            ("addendum.md", b"a late arrival"),
        ],
    );
    assert_eq!(
        answer_cache::workspace_cache_key("conv-twin", q, Some("openai"), Some("gpt-5-mini"), &[]),
        key(q, Some("openai"), Some("gpt-5-mini"), &[]),
        "identical bytes ⇒ identical key, in any conversation"
    );

    // One changed byte anywhere in the corpus is a different key.
    common::attach_all("conv-diff", &[("report.md", b"quarterly revenue summary!")]);
    assert_ne!(
        answer_cache::workspace_cache_key("conv-diff", q, Some("openai"), Some("gpt-5-mini"), &[]),
        base
    );
}

// --- The history gate --------------------------------------------------------------

#[test]
fn history_off_serves_memory_only_and_deletes_the_disk_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
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

// --- Cost meter persistence + replay (openspec: add-beam-loop §3.3/§3.5) -----------

#[test]
fn a_cache_replay_reports_zero_new_cost_but_carries_the_original_as_history() {
    // A stored answer's cost meter is HISTORY; replaying it re-stamps `cachedAt`
    // (the replay computed nothing) and reports 0 NEW cost, so the running total
    // never double-counts a replay.
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();

    // A billable cloud answer's stored meter: 100/50 provider-reported tokens
    // and a labeled estimate of $0.01.
    let mut e = entry("verified cloud answer");
    e.meta.origin = "anthropic".into();
    e.meta.cost = Some(CostMeta {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        reported: true,
        cost_estimate_usd: Some(0.01),
    });
    answer_cache::insert("k", e, ALLOWED);

    // The original figures survive the store byte-for-byte (persisted history).
    let hit = answer_cache::lookup("k", ALLOWED).expect("stored");
    let stored = hit.meta.cost.clone().expect("cost persisted in CachedAnswer");
    assert_eq!(stored.total_tokens, 150);
    assert_eq!(stored.cost_estimate_usd, Some(0.01));
    assert!(stored.reported);

    // The replay stamp the wrapper adds (`cachedAt`) means 0 NEW cost, while the
    // stored figures ride along as the historical record.
    let replay_meta = ChunkMeta { cached_at: Some(hit.created_ms), ..hit.meta };
    assert!(replay_meta.cost.is_some(), "the original figures ride the replay as history");
    assert!(
        lighthouse_core::audit::ask_new_cost(&replay_meta).is_none(),
        "a replay reports 0 new tokens / $0"
    );
}

// --- Context manifest persistence + replay (openspec: add-beam-loop §5.4/§5.7) -----

#[test]
fn a_cache_replay_shows_the_original_manifest_not_a_blank() {
    // The context manifest is stored on the cached answer and rides the replay via
    // `..hit.meta` (the same seam the provenance stamp and cost meter get), so a
    // replay renders the ORIGINAL manifest, never an empty one. METADATA ONLY —
    // the persisted entries carry names/kinds/counts/file ids, never context text.
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();

    let mut e = entry("verified answer over private files");
    e.meta.manifest = Some(vec![
        CtxManifestEntry {
            name: "budget.csv — schema".into(),
            kind: "schema-card".into(),
            chars: 128,
            file_id: Some("id-budget".into()),
            local_only: None,
            score: 0.0,
        },
        CtxManifestEntry {
            name: "q3.md".into(),
            kind: "retrieved-chunk".into(),
            chars: 512,
            file_id: Some("id-q3".into()),
            local_only: None,
            score: 0.9,
        },
    ]);
    answer_cache::insert("k", e, ALLOWED);

    // The manifest survives the store byte-for-byte (persisted history).
    let hit = answer_cache::lookup("k", ALLOWED).expect("stored");
    let stored = hit.meta.manifest.clone().expect("manifest persisted in CachedAnswer");
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[1].kind, "retrieved-chunk");
    assert_eq!(stored[1].file_id.as_deref(), Some("id-q3"), "a chunk carries its file id");

    // The replay stamp the wrapper adds (`cachedAt`) carries the ORIGINAL manifest
    // forward via the `..hit.meta` spread — the replay shows it, not a blank.
    let replay_meta = ChunkMeta { cached_at: Some(hit.created_ms), ..hit.meta };
    let m = replay_meta.manifest.expect("the original manifest rides the replay");
    assert_eq!(m.len(), 2, "a replay shows the original manifest, not an empty one");
}

#[test]
fn the_structured_table_rides_the_replay_like_the_chart_does() {
    // §32 §3: `meta.table` (the apple-fm prose contract's verified rows) rides
    // `ChunkMeta` exactly like `meta.chart` — stored whole on the cached answer
    // and re-emitted by the `..hit.meta` replay spread, so a cached prose
    // answer replays WITH its table, and a legacy cache entry (no field)
    // deserializes to None instead of failing.
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();

    let mut e = entry("prose answer over a fact sheet");
    e.meta.chart = Some(r#"{"kind":"bar"}"#.into());
    e.meta.table = Some(r#"{"columns":["region","total"],"rows":[["West","42"]]}"#.into());
    answer_cache::insert("kt", e, ALLOWED);

    let hit = answer_cache::lookup("kt", ALLOWED).expect("stored");
    let replay = ChunkMeta { cached_at: Some(hit.created_ms), ..hit.meta };
    assert_eq!(replay.chart.as_deref(), Some(r#"{"kind":"bar"}"#));
    assert_eq!(
        replay.table.as_deref(),
        Some(r#"{"columns":["region","total"],"rows":[["West","42"]]}"#),
        "the original table rides the replay"
    );

    // Legacy shape: a pre-§32 meta JSON (no `table` key) still deserializes.
    let legacy: ChunkMeta = serde_json::from_str(
        r#"{"origin":"device","excerptCount":1,"sourceFileCount":1,"chart":"{}"}"#,
    )
    .expect("legacy meta parses");
    assert!(legacy.table.is_none(), "missing field defaults to None");
}

#[test]
fn a_certified_answer_replays_certified_from_the_stored_analytics_meta() {
    // openspec: add-semantic-layer §3.4/§4 — the certified mark + trust verdict
    // ride `AnalyticsMeta`, which `CachedAnswer.analytics` stores and a replay
    // re-emits via `..hit.analytics`, so a cached certified answer replays STILL
    // certified with its ORIGINAL verdict, NOTHING recomputed (no ctx, no model:
    // the model-free meta path). The additive-optional fields round-trip the
    // store byte-for-byte through disk.
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();

    let mut e = entry("Revenue by region.\n\n*Certified:* revenue");
    e.analytics = Some(AnalyticsMeta {
        sql: "SELECT region, SUM(amount) FILTER (WHERE status = 'paid') AS revenue \
              FROM sales GROUP BY region"
            .into(),
        file_ids: vec!["id-sales".into()],
        certified: Some(vec!["revenue".into()]),
        trust: Some(TrustVerdict {
            certified: true,
            reconciled: true,
            metric: Some("revenue".into()),
            expected: Some("37.0".into()),
            got: Some("37.0".into()),
        }),
    });
    answer_cache::insert("k", e, ALLOWED);

    // Drop the in-memory store so the lookup RELOADS from disk — a genuine serde
    // round-trip of the new wire fields, not just a clone.
    answer_cache::reset_store();
    let hit = answer_cache::lookup("k", ALLOWED).expect("stored");
    let analytics = hit.analytics.clone().expect("analytics persisted in CachedAnswer");
    assert_eq!(
        analytics.certified,
        Some(vec!["revenue".to_string()]),
        "the certified mark survives the store"
    );
    let trust = analytics.trust.expect("trust verdict persisted");
    assert!(trust.certified && trust.reconciled, "{trust:?}");
    assert_eq!(trust.metric.as_deref(), Some("revenue"));
    assert_eq!(trust.expected, trust.got, "the original figures replay unchanged");

    // The `*Certified:*` footer rides inside the stored answer TEXT, so it
    // replays verbatim too (engine text, never recomputed).
    assert!(hit.text.contains("*Certified:* revenue"), "{}", hit.text);

    // A replay re-emits the stored analytics via `..hit.analytics` — the same
    // seam the manifest/cost/provenance use — unchanged.
    let replayed = hit.analytics.expect("rides the replay");
    assert_eq!(replayed.certified, Some(vec!["revenue".to_string()]));
    assert!(replayed.trust.is_some());
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
async fn unchanged_question_replays_verbatim_and_a_changed_corpus_runs_live() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();
    const CONV: &str = "conv-replay";
    common::attach_all(
        CONV,
        &[
            ("sales.csv", b"date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n"),
            ("notes.md", b"# planning\nsome prose\n"),
        ],
    );

    let cfg = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let ask = |cfg: ModelCfg| {
        answer_pipeline(
            "What's new this week?".to_string(),
            vec![],
            vec![],
            vec![],
            cfg,
            Default::default(),
            Default::default(),
            vec![],
            Corpus { conversation_id: Some(CONV.to_string()) },
        )
    };

    // 1st ask: live over the deterministic meta path — no replay stamp.
    let (text1, chunks1) = drive(ask(cfg.clone())).await;
    let done1 = chunks1.iter().find(|c| c.done).expect("terminating chunk");
    assert!(!text1.trim().is_empty());
    let meta1 = done1.meta.as_ref().unwrap();
    assert!(meta1.cached_at.is_none(), "a live answer carries no cachedAt");
    // The model-free meta path runs no model, so its cost meter is honestly
    // "not reported" — never a fabricated count (openspec: add-beam-loop §3.1).
    let cost1 = meta1.cost.as_ref().expect("a live answer carries a cost meter");
    assert!(!cost1.reported, "no model call ⇒ not reported");
    assert_eq!(cost1.total_tokens, 0);

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
    // The replay carries the original answer's cost meter as history; its 0-new
    // reading follows from the `cachedAt` stamp above (openspec §3.3).
    assert!(meta2.cost.is_some(), "the replay carries the stored cost meter");
    let refs = |c: &ChatChunk| -> Vec<String> {
        c.references.iter().flatten().map(|r| r.file_id.clone()).collect()
    };
    assert_eq!(refs(done2), refs(done1), "replayed references match the original");
    assert_eq!(meta2.origin, done1.meta.as_ref().unwrap().origin);
    // Default (absent) persistence verdict: nothing ever landed on disk.
    assert!(!cache_file().exists(), "memory-only by default — no disk mirror");

    // Change the corpus (attach a further file) → the conversation's content
    // digest changes → the ask-time key changes → the same question runs LIVE
    // again. In the vault era this was a `mtime:size` touch; the content hash
    // makes it exact — a rewrite with IDENTICAL bytes would still replay.
    workspace::attach(CONV, "extra.csv", b"date,region,amount\n2026-01-07,SE,75\n").unwrap();
    let (_text3, chunks3) = drive(ask(cfg)).await;
    let done3 = chunks3.iter().find(|c| c.done).expect("terminating chunk");
    assert!(
        done3.meta.as_ref().unwrap().cached_at.is_none(),
        "a changed corpus invalidates — the answer ran live"
    );
}

/// Re-run (`bypass_cache`) skips the lookup, runs live, and REFRESHES the
/// entry: the replay that follows carries the refreshed `created_ms`.
#[tokio::test]
async fn bypass_runs_live_and_refreshes_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();
    const CONV: &str = "conv-bypass";
    common::attach_all(CONV, &[("notes.md", b"# planning\nsome prose\n")]);

    let cfg = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let ask = |cache: CacheCtl| {
        answer_pipeline(
            "What's new this week?".to_string(),
            vec![],
            vec![],
            vec![],
            cfg.clone(),
            cache,
            Default::default(),
            vec![],
            Corpus { conversation_id: Some(CONV.to_string()) },
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

// --- Two-phase plan approval, cache bypass (openspec: add-beam-loop §4.3) -----------

/// Phase 1: a `plan_only` op is a PREVIEW, not an answer — it must neither READ
/// nor WRITE the answer cache; caching keys on the APPROVED ask instead. The
/// plan preview itself needs a live model (it egresses a plan-generation call)
/// and so can't run in this no-network harness — but the cache decision is
/// MODEL-FREE, so it is exercised here over the deterministic meta path: with
/// `plan_only` set, `answer_pipeline` bypasses the whole key/lookup/insert path.
#[tokio::test]
async fn plan_only_neither_reads_nor_writes_the_answer_cache() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    answer_cache::reset_store();
    const CONV: &str = "conv-plan-only";
    common::attach_all(
        CONV,
        &[
            ("sales.csv", b"date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n"),
            ("notes.md", b"# planning\nsome prose\n"),
        ],
    );

    let cfg = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let ask = |plan: PlanCtl| {
        answer_pipeline(
            "What's new this week?".to_string(),
            vec![],
            vec![],
            vec![],
            cfg.clone(),
            CacheCtl::default(),
            plan,
            vec![],
            Corpus { conversation_id: Some(CONV.to_string()) },
        )
    };
    let plan_only = || PlanCtl { plan_only: true, approved_plan: None };
    let cached_at = |chunks: &[ChatChunk]| -> Option<i64> {
        chunks.iter().rfind(|c| c.done).unwrap().meta.as_ref().unwrap().cached_at
    };

    // 1. A plan_only op runs live and writes NOTHING to the cache…
    let (_t0, c0) = drive(ask(plan_only())).await;
    assert!(cached_at(&c0).is_none(), "a plan_only op runs live");

    // 2. …so a following ORDINARY ask still runs LIVE — the cache is empty
    //    because the plan_only op never populated it. Had it cached, this replays.
    let (_t1, c1) = drive(ask(PlanCtl::default())).await;
    assert!(cached_at(&c1).is_none(), "the plan_only op left the cache unwritten");

    // 3. The ordinary ask DID key + cache normally; a repeat replays it.
    let (_t2, c2) = drive(ask(PlanCtl::default())).await;
    assert!(cached_at(&c2).is_some(), "an ordinary ask caches normally");

    // 4. A plan_only op does NOT read that cached answer — it bypasses the
    //    lookup and runs live (no replay stamp), leaving the entry intact.
    let (_t3, c3) = drive(ask(plan_only())).await;
    assert!(
        cached_at(&c3).is_none(),
        "plan_only bypasses the lookup — it never replays a cached answer"
    );
}
