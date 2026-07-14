//! Local-dev licensing parity tests (the local-crypto trial path). The
//! A/B-experiment assignment tests were removed with the experiment engine.

mod common;

use lighthouse_core::license;

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
