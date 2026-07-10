//! run_direct: the guarded, model-free re-execution path behind Edit SQL,
//! Save-as-CSV, and pin rechecks — exercised over a real vault.

mod common;

use lighthouse_core::analytics::run_direct;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn direct_execution_is_guarded_and_provenanced() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("sales.csv"), "region,amount\nNE,100\nNW,50\n");
    lighthouse_core::vault::invalidate_walk_cache();
    // Direct execution honors AI visibility — only included files register.
    lighthouse_core::vault::set_included("sales.csv", true);

    let ids = vec!["sales.csv".to_string(), "gone.csv".to_string()];

    // A valid SELECT answers with result + full provenance footer.
    let r = run_direct("SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC", &ids)
        .await
        .expect("query runs");
    assert!(r.markdown.contains("NE") && r.markdown.contains("100"), "{}", r.markdown);
    assert!(r.footer.contains("*Query used:*"), "{}", r.footer);
    assert!(r.footer.contains("Computed from"), "{}", r.footer);
    assert!(r.footer.contains("skipped 1 file"), "missing id noted: {}", r.footer);
    assert!(r.chart.is_some(), "two labeled numeric rows chart");

    // The guard still owns the gate: writes are rejected with its reason.
    let err = run_direct("DROP TABLE sales", &ids).await.unwrap_err();
    assert!(err.contains("SELECT"), "{err}");

    // All files gone ⇒ a clear error, not a panic.
    let err = run_direct("SELECT 1", &["nope.csv".to_string()]).await.unwrap_err();
    assert!(err.contains("available"), "{err}");
}
