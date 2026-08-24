//! run_direct: the guarded, model-free re-execution path behind Edit SQL and
//! Save-as-CSV — exercised over a conversation's attachments.

mod common;

use lighthouse_core::analytics::run_direct;

const CONV: &str = "conv-direct";

#[tokio::test]
async fn direct_execution_is_guarded_and_provenanced() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let mut ids = common::attach_all(CONV, &[("sales.csv", b"region,amount\nNE,100\nNW,50\n")]);
    // An id that resolves to nothing — detached, or never attached here.
    ids.push("att-000000000000".to_string());

    // A valid SELECT answers with result + full provenance footer.
    let r = run_direct(
        CONV,
        "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC",
        &ids,
    )
    .await
    .expect("query runs");
    assert!(r.markdown.contains("NE") && r.markdown.contains("100"), "{}", r.markdown);
    assert!(r.footer.contains("*Query used:*"), "{}", r.footer);
    assert!(r.footer.contains("Computed from"), "{}", r.footer);
    assert!(r.footer.contains("skipped 1 file"), "unresolvable id noted: {}", r.footer);
    assert!(r.chart.is_some(), "two labeled numeric rows chart");

    // The guard still owns the gate: writes are rejected with its reason.
    let err = run_direct(CONV, "DROP TABLE sales", &ids).await.unwrap_err();
    assert!(err.contains("SELECT"), "{err}");

    // Nothing resolves ⇒ a clear error, not a panic.
    let err = run_direct(CONV, "SELECT 1", &["att-ffffffffffff".to_string()])
        .await
        .unwrap_err();
    assert!(err.contains("available"), "{err}");
}
