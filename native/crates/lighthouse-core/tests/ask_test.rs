//! The shared headless-ask chokepoint (openspec: add-automation §1). These are
//! the store-touching scenarios for `ask::run_headless_ask`, serialized on the
//! shared VAULT_DIR env lock (ONE guard per test). Each drives the deterministic,
//! model-free vault-meta path ("What's new this week?" over a two-file fixture,
//! shared with provenance_test / answer_cache_test), so the whole suite runs
//! with ZERO network for every provider — including a keyless cloud one.
//!
//! The invariant under test: a headless ask is audited + egress-attributed
//! EXACTLY like an app ask, because it flows through the same
//! `resolve_ask_context` → `AnswerAudit::start` → `answer_pipeline` →
//! `.finish(provider, files, artifacts, ask_new_cost(&meta))` wrapper the UI
//! transports assemble inline.

mod common;

use std::path::Path;
use std::pin::Pin;

use futures::{Stream, StreamExt};

use lighthouse_core::ask::{run_headless_ask, AskOpts};
use lighthouse_core::audit::AuditRecord;
use lighthouse_core::contracts::{ChatChunk, ChunkMeta};
use lighthouse_core::{answer_cache, policy};

const META_QUESTION: &str = "What's new this week?";

async fn drive(mut stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>>) -> Vec<ChatChunk> {
    let mut chunks = Vec::new();
    while let Some(c) = stream.next().await {
        chunks.push(c);
    }
    chunks
}

/// The full streamed answer — every chunk's `delta` concatenated, as a caller
/// assembling the visible answer would.
fn answer_text(chunks: &[ChatChunk]) -> String {
    chunks.iter().map(|c| c.delta.as_str()).collect()
}

/// The final chunk's engine-emitted provenance stamp — what a caller READS to
/// report where the answer was computed and what it cost.
fn final_meta(chunks: &[ChatChunk]) -> ChunkMeta {
    chunks
        .iter()
        .rev()
        .find(|c| c.done)
        .and_then(|c| c.meta.clone())
        .expect("the final chunk carries a provenance stamp")
}

/// The file ids the final chunk cited (the audit record's `file_ids`).
fn cited_files(chunks: &[ChatChunk]) -> Vec<String> {
    chunks
        .iter()
        .rev()
        .find(|c| c.done)
        .and_then(|c| c.references.as_ref())
        .map(|refs| refs.iter().map(|r| r.file_id.clone()).collect())
        .unwrap_or_default()
}

fn read_records(file: &Path) -> Vec<AuditRecord> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<AuditRecord>(l).ok())
        .collect()
}

/// Turn the audit log ON via the install-global settings file, on a clean policy
/// slate so the gate is deterministic (no managed override).
fn enable_audit(settings: &Path) {
    std::fs::write(settings, r#"{"auditEnabled":true}"#).unwrap();
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", settings);
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    policy::reset_for_tests();
}

/// The conversation every case here asks inside.
const CONV: &str = "conv-ask";

/// The two-file provenance fixture, attached and searchable. Returns the ids.
fn seed_meta_vault(_dir: &Path) -> Vec<String> {
    common::attach_all(
        CONV,
        &[
            ("sales.csv", b"date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n"),
            ("notes.md", b"# planning\nsome prose\n"),
        ],
    )
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

// --- The audit + egress invariant ---------------------------------------------------

/// §1.7 / spec scenario "A headless ask is recorded in the audit + egress
/// ledger" + "The provenance comes from the engine stamp": one ask through the
/// helper appends one audit record shaped like an app ask's (provider from the
/// resolved cfg, the files read, the per-question egress delta), and the streamed
/// provenance stamp is the engine's own account that AGREES with that record.
#[tokio::test]
async fn headless_ask_is_recorded_like_an_app_ask() {
    let dir = tempfile::tempdir().unwrap();
    let aux = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    // A keyless CLOUD provider via the profile — the meta path is model-free, so
    // this answers on-device with zero network, yet the audit still records the
    // configured provider (read from cfg exactly as the transports derive it).
    for k in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"] {
        std::env::remove_var(k);
    }
    let profile = aux.path().join("profile.json");
    std::fs::write(&profile, r#"{"providerId":"anthropic","modelId":"claude-opus-4-8"}"#).unwrap();
    std::env::set_var("LIGHTHOUSE_PROFILE_FILE", &profile);
    let audit_file = aux.path().join("audit.jsonl");
    std::env::set_var("LIGHTHOUSE_AUDIT_FILE", &audit_file);
    enable_audit(&aux.path().join("settings.json"));
    answer_cache::reset_store();

    let ids = seed_meta_vault(dir.path());
    let chunks = drive(run_headless_ask(
        META_QUESTION.to_string(),
        ids.clone(),
        vec![],
        AskOpts { conversation_id: Some(CONV.to_string()), ..AskOpts::default() },
    ))
    .await;

    // Provenance is READ from the final ChunkMeta — the cloud id, not model text.
    let meta = final_meta(&chunks);
    assert_eq!(meta.origin, "anthropic", "the stamp carries the configured provider id");
    assert!(meta.cost.is_some(), "a live answer carries a cost meter for the caller to read");

    // Exactly one record, shaped like an app ask's.
    let recs = read_records(&audit_file);
    assert_eq!(recs.len(), 1, "one ask ⇒ one audit record");
    let rec = &recs[0];
    assert_eq!(rec.provider, "anthropic", "provider recorded from the resolved cfg");
    assert_eq!(rec.egress, vec!["none"], "a model-free ask egresses nothing (honest delta)");
    assert_eq!(sorted(rec.file_ids.clone()), sorted(ids), "audit fileIds = the files the answer read");
    // The two transparency surfaces agree: stamp source count ⇔ audit fileIds.
    assert_eq!(meta.source_file_count, rec.file_ids.len(), "stamp and audit never disagree");
}

/// §1.7 / spec scenario "A local-only investigation forces device even without
/// the flag" (here via the explicit `--local`): the engine stamp is `device` and
/// the audit agrees (device ⇔ local) with NO egress recorded.
#[tokio::test]
async fn local_forces_device_and_records_no_egress() {
    let dir = tempfile::tempdir().unwrap();
    let aux = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
    let audit_file = aux.path().join("audit.jsonl");
    std::env::set_var("LIGHTHOUSE_AUDIT_FILE", &audit_file);
    enable_audit(&aux.path().join("settings.json"));
    answer_cache::reset_store();

    let ids = seed_meta_vault(dir.path());
    // `local: true` forces the on-device, key-less config — most-restrictive
    // wins, zero network.
    let chunks = drive(run_headless_ask(
        META_QUESTION.to_string(),
        ids,
        vec![],
        AskOpts { local: true, conversation_id: Some(CONV.to_string()), ..AskOpts::default() },
    ))
    .await;

    assert_eq!(final_meta(&chunks).origin, "device", "--local forces the device origin");
    let recs = read_records(&audit_file);
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].provider, "local", "the resolved provider is the device model");
    assert_eq!(recs[0].egress, vec!["none"], "a device ask records no egress");
}

/// §1.7 / spec scenario "A replayed headless ask adds no new cost": the second,
/// unchanged ask replays the cached answer, and because `ask_new_cost` is None on
/// a `cached_at` stamp, the record carries NO cost node — 0 new, no double-count.
#[tokio::test]
async fn cache_replay_records_zero_new_cost() {
    let dir = tempfile::tempdir().unwrap();
    let aux = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
    let audit_file = aux.path().join("audit.jsonl");
    std::env::set_var("LIGHTHOUSE_AUDIT_FILE", &audit_file);
    enable_audit(&aux.path().join("settings.json"));
    answer_cache::reset_store();

    let ids = seed_meta_vault(dir.path());
    let ask = || {
        run_headless_ask(
            META_QUESTION.to_string(),
            ids.clone(),
            vec![],
            AskOpts { local: true, conversation_id: Some(CONV.to_string()), ..AskOpts::default() },
        )
    };

    // 1st ask: live — carries its (model-free, 0-token) new-cost meter.
    let live = drive(ask()).await;
    assert!(final_meta(&live).cached_at.is_none(), "the first ask is live");
    let after_live = read_records(&audit_file);
    assert_eq!(after_live.len(), 1);
    assert!(after_live[0].cost.is_some(), "a live ask records its new-cost meter");

    // 2nd ask, nothing changed: an in-memory replay — `ask_new_cost` None on the
    // `cached_at` stamp ⇒ the record carries NO cost node (0 new).
    let replay = drive(ask()).await;
    assert!(final_meta(&replay).cached_at.is_some(), "the second ask replays the cached answer");
    let after_replay = read_records(&audit_file);
    assert_eq!(after_replay.len(), 2, "the replay is still audited");
    assert!(
        after_replay[1].cost.is_none(),
        "a replay records 0 new cost (ask_new_cost None on cached_at)"
    );
}

// --- §6.1: the model-free ask golden — grounded + deterministic + stamp-agreeing -----

/// §6.1: a model-free `run_headless_ask --local` golden. Over a fixed fixture the
/// device path yields a GROUNDED answer (it names the vault's files), a DEVICE
/// provenance whose read-off fields AGREE with the streamed `ChunkMeta` stamp,
/// and — the guarantee beyond §1.7 — the SAME answer twice. Both runs are LIVE
/// (the cache is reset between them, so this proves the PIPELINE is deterministic,
/// not that the cache echoes its own bytes). The meta path bins mtime to "just
/// now" under 60s, so the freshly-written fixture makes the text byte-stable.
#[tokio::test]
async fn headless_local_ask_is_grounded_deterministic_and_stamp_agreeing() {
    let dir = tempfile::tempdir().unwrap();
    let aux = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
    std::env::remove_var("LIGHTHOUSE_AUDIT_FILE");
    enable_audit(&aux.path().join("settings.json"));

    let ids = seed_meta_vault(dir.path());
    let ask = || {
        run_headless_ask(
            META_QUESTION.to_string(),
            ids.clone(),
            vec![],
            AskOpts { local: true, conversation_id: Some(CONV.to_string()), ..AskOpts::default() },
        )
    };

    // Run 1 — live (fresh cache).
    answer_cache::reset_store();
    let first = drive(ask()).await;
    let first_meta = final_meta(&first);
    let first_answer = answer_text(&first);

    // Grounded: the device answer NAMES the fixture's files (not a generic reply).
    assert!(
        first_answer.contains("sales.csv") && first_answer.contains("notes.md"),
        "the grounded answer names the vault's files, got: {first_answer:?}"
    );
    // Device provenance, and the stamp's own source count AGREES with what it cited.
    assert_eq!(first_meta.origin, "device", "--local forces the device origin");
    assert_eq!(
        first_meta.source_file_count,
        cited_files(&first).len(),
        "the stamp's source_file_count equals the files the answer actually cited"
    );
    assert!(first_meta.cached_at.is_none(), "run 1 is live, not a replay");

    // Run 2 — also live (reset the cache so this is NOT a cached-bytes echo).
    answer_cache::reset_store();
    let second = drive(ask()).await;
    let second_meta = final_meta(&second);

    assert!(second_meta.cached_at.is_none(), "run 2 is live too (cache was reset)");
    // Determinism: the same question over the same fixture yields the SAME answer
    // and the SAME device provenance both times.
    assert_eq!(answer_text(&second), first_answer, "the model-free answer is deterministic across runs");
    assert_eq!(second_meta.origin, first_meta.origin, "origin is stable across runs");
    assert_eq!(
        second_meta.source_file_count, first_meta.source_file_count,
        "the source count is stable across runs"
    );
    assert_eq!(sorted(cited_files(&second)), sorted(cited_files(&first)), "the cited file set is stable");
}

// The `opts_vault_redirects_vault_reads_and_audit_state_root` case lived here.
// `opts.vault` pointed a one-shot ask at another vault directory and made its
// audit land in that directory's own state root; with the vault deleted in
// 0.15.0 there is one state root and nothing to redirect. The corpus a headless
// ask reads is now the conversation named in `opts.conversation_id`, which
// workspace_ask_test.rs and the cases above cover.
