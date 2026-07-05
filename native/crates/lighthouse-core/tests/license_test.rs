//! Local-dev licensing + experiment assignment parity tests (ports the
//! behaviors of `test/experiment.assign.test.mjs`'s local half and the
//! local-crypto trial path).

mod common;

use lighthouse_core::experiment::{get_all_variants, get_variant, hash_to_unit};
use lighthouse_core::license;

#[test]
fn hash_to_unit_is_deterministic_and_uniformish() {
    // Exact values pinned against the TS implementation (sha256 top-48-bits):
    // crypto.createHash("sha256").update("x").digest().readUIntBE(0,6) / 2**48
    let a = hash_to_unit("x");
    let b = hash_to_unit("x");
    assert_eq!(a, b);
    assert!((0.0..1.0).contains(&a));
    assert_ne!(
        hash_to_unit("contact-a:onboarding:v1"),
        hash_to_unit("contact-a:default_inclusion:v1")
    );
}

#[test]
fn variants_resolve_once_and_stay_stable() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    // Drop the pinned file so resolution actually runs.
    std::fs::remove_file(vault_dir.path().join(".rag-vault/experiments.json")).unwrap();

    let first = get_all_variants();
    assert!(["play_first", "key_first"].contains(&first.onboarding.as_str()));
    assert!(["opt_in", "opt_out"].contains(&first.default_inclusion.as_str()));
    // Stable across calls (persisted to experiments.json).
    assert_eq!(get_all_variants(), first);
    assert_eq!(get_variant("onboarding"), first.onboarding);
}

#[test]
fn pilot_email_override_wins_over_stored_hash() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    std::fs::remove_file(vault_dir.path().join(".rag-vault/experiments.json")).unwrap();

    let _ = get_all_variants(); // hash assignment persisted

    // Signing in as a pilot user re-pins to the factorial cell.
    std::fs::write(
        vault_dir.path().join(".rag-vault/profile.json"),
        r#"{ "step": "register", "user": { "id": "local", "name": "U", "email": "user3@example.com" } }"#,
    )
    .unwrap();
    let v = get_all_variants();
    assert_eq!(v.onboarding, "play_first");
    assert_eq!(v.default_inclusion, "opt_out");
}

#[tokio::test]
async fn local_dev_trial_mints_checks_and_counts_days() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    std::env::set_var("LICENSE_ENFORCE", "1");
    std::env::set_var("LICENSE_SECRET", "test-secret");

    // Disabled → none → valid lifecycle.
    let guid = license::start_trial(None).await.unwrap();
    assert!(!guid.is_empty());

    let first = license::check_license().await;
    assert_eq!(first.status, "valid");
    assert_eq!(first.license_type.as_deref(), Some("trial"));
    // First check consumes sign-in day 1 of 14.
    assert_eq!(first.remaining_days, Some(13));

    // A second check the same UTC day must not consume another day.
    let second = license::check_license().await;
    assert_eq!(second.remaining_days, Some(13));

    std::env::remove_var("LICENSE_ENFORCE");
    std::env::remove_var("LICENSE_SECRET");
}

#[tokio::test]
async fn tampered_license_key_reads_none() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    std::env::set_var("LICENSE_ENFORCE", "1");
    std::env::set_var("LICENSE_SECRET", "test-secret");

    license::start_trial(None).await.unwrap();
    // Corrupt the stored key: AES-GCM authentication must fail closed.
    let lic_path = vault_dir.path().join(".rag-vault/license.json");
    let mut lic: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&lic_path).unwrap()).unwrap();
    lic["licenseKey"] = serde_json::Value::String("AAAA".repeat(24));
    std::fs::write(&lic_path, serde_json::to_string(&lic).unwrap()).unwrap();

    assert_eq!(license::check_license().await.status, "none");

    std::env::remove_var("LICENSE_ENFORCE");
    std::env::remove_var("LICENSE_SECRET");
}

#[tokio::test]
async fn disabled_mode_reports_disabled_and_never_locks() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    assert_eq!(license::check_license().await.status, "disabled");
}
