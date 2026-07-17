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
use lighthouse_core::{answer_cache, policy, vault};

const META_QUESTION: &str = "What's new this week?";

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

async fn drive(mut stream: Pin<Box<dyn Stream<Item = ChatChunk> + Send>>) -> Vec<ChatChunk> {
    let mut chunks = Vec::new();
    while let Some(c) = stream.next().await {
        chunks.push(c);
    }
    chunks
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

/// The two-file provenance fixture, included and searchable. Returns the ids.
fn seed_meta_vault(vault_dir: &Path) -> Vec<String> {
    write(
        &vault_dir.join("sales.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
    );
    write(&vault_dir.join("notes.md"), "# planning\nsome prose\n");
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);
    vault::set_included("notes.md", true);
    vec!["sales.csv".to_string(), "notes.md".to_string()]
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
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
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
        AskOpts::default(),
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
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
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
        AskOpts { local: true, ..AskOpts::default() },
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
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
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
            AskOpts { local: true, ..AskOpts::default() },
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

// --- §1.4: the vault ⇒ state-root mapping (the one thing to get exactly right) -------

/// A one-shot `opts.vault = X` must READ X's vault AND WRITE its audit to X's OWN
/// state root — even when an ambient `LIGHTHOUSE_APP_STATE_DIR` (a desktop
/// install's private data dir) points elsewhere. This proves the helper sets
/// BOTH `VAULT_DIR` (vault + investigations, via the derived `state_dir()`) AND
/// `LIGHTHOUSE_APP_STATE_DIR` (audit + answer cache) from `opts.vault`.
#[tokio::test]
async fn opts_vault_redirects_vault_reads_and_audit_state_root() {
    let vault = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap(); // a decoy "desktop install" state dir
    let aux = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    // Simulate a desktop install whose state dir is NOT the vault's: audit/cache
    // would land HERE if `opts.vault` failed to override it.
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", elsewhere.path());
    // Let the audit path DERIVE from app_state_dir (no direct file override), so
    // the test actually exercises the state-root redirect.
    std::env::remove_var("LIGHTHOUSE_AUDIT_FILE");
    std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
    enable_audit(&aux.path().join("settings.json"));
    answer_cache::reset_store();

    let ids = seed_meta_vault(vault.path());
    // `opts.vault = X` — the helper sets VAULT_DIR = X and pins
    // LIGHTHOUSE_APP_STATE_DIR = X/.rag-vault before the first read.
    let chunks = drive(run_headless_ask(
        META_QUESTION.to_string(),
        ids.clone(),
        vec![],
        AskOpts { local: true, vault: Some(vault.path().to_path_buf()), ..AskOpts::default() },
    ))
    .await;

    // X's vault was READ: the answer cites X's fixture files.
    assert_eq!(sorted(cited_files(&chunks)), sorted(ids), "the answer read X's vault");

    // X's state root got the audit WRITE — under X/.rag-vault/audit …
    let x_audit_dir = vault.path().join(".rag-vault").join("audit");
    let wrote_under_x = std::fs::read_dir(&x_audit_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        })
        .unwrap_or(false);
    assert!(wrote_under_x, "opts.vault redirected the audit to X's own state root ({x_audit_dir:?})");

    // … and NOT to the ambient install state dir (opts.vault overrode it).
    let decoy_has_audit = std::fs::read_dir(elsewhere.path().join("audit"))
        .map(|mut rd| rd.next().is_some())
        .unwrap_or(false);
    assert!(!decoy_has_audit, "the ambient LIGHTHOUSE_APP_STATE_DIR was overridden, not written to");
}
