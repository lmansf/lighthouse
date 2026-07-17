//! Proactive insights scan (openspec: add-quant-depth §5), end to end. Writes
//! fixture CSVs, builds the `(file_id, name, path)` triples the op passes, and
//! drives `insights::scan` — the same on-device DataFusion path the surface
//! uses. No VAULT_DIR and no provider: `scan` reads the files it is handed and
//! runs the detectors as model-free SQL, so these need no env lock and prove the
//! zero-network posture by construction (no key is ever set).

use std::path::PathBuf;

use lighthouse_core::insights::scan;

fn write_csv(dir: &std::path::Path, name: &str, body: &str) -> (String, String, PathBuf) {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    (format!("id-{name}"), name.to_string(), path)
}

/// A monthly series that holds ~100 then spikes to 400 in October — a >2σ
/// anomaly the scan surfaces WITHOUT a question.
const ANOMALY_CSV: &str = "d,amount\n\
    2024-01-15,100\n2024-02-15,100\n2024-03-15,100\n2024-04-15,100\n2024-05-15,100\n\
    2024-06-15,100\n2024-07-15,100\n2024-08-15,100\n2024-09-15,100\n2024-10-15,400\n";

/// A flat series — nothing stands out (no anomaly, no material changepoint, and
/// no group column for movers).
const FLAT_CSV: &str = "d,amount\n\
    2024-01-15,300\n2024-02-15,300\n2024-03-15,300\n2024-04-15,300\n\
    2024-05-15,300\n2024-06-15,300\n2024-07-15,300\n2024-08-15,300\n";

#[tokio::test]
async fn scan_surfaces_a_ranked_anomaly_and_discloses_counts() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![
        write_csv(dir.path(), "spikes.csv", ANOMALY_CSV),
        write_csv(dir.path(), "flat.csv", FLAT_CSV),
    ];

    let out = scan(&files, false).await;

    // Both tables are Date+Numeric, both scanned (well under the cap).
    assert_eq!(out.tables_available, 2, "two analyzable tables");
    assert_eq!(out.tables_scanned, 2, "both scanned (no cap hit)");

    // The spike surfaces as an anomaly finding, unprompted, naming the table +
    // the October period + an engine-computed z-score.
    let anomaly = out
        .findings
        .iter()
        .find(|f| f.kind == "anomaly" && f.table == "spikes.csv")
        .expect("the October spike is surfaced as an anomaly");
    assert!(anomaly.headline.contains("2024-10"), "headline names the period: {}", anomaly.headline);
    assert!(anomaly.magnitude > 2.0, "a >2σ anomaly, got {}", anomaly.magnitude);

    // The flat table contributes NOTHING (no anomaly, no material shift, no
    // group for movers) — nothing is fabricated for it.
    assert!(
        !out.findings.iter().any(|f| f.table == "flat.csv"),
        "the flat series has nothing standing out"
    );

    // Findings are ranked by descending magnitude.
    for pair in out.findings.windows(2) {
        assert!(pair[0].magnitude >= pair[1].magnitude, "findings rank by magnitude");
    }
}

#[tokio::test]
async fn a_quiet_vault_returns_no_findings() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "flat.csv", FLAT_CSV)];

    let out = scan(&files, false).await;

    assert_eq!(out.tables_available, 1);
    assert!(out.findings.is_empty(), "an honest empty — nothing stands out");
}

#[tokio::test]
async fn an_unanalyzable_table_is_skipped_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    // A text-only table (no numeric column) can't carry a temporal detector; it
    // must be skipped silently while the spikes table is still scanned.
    let junk = "label,note\na,hello\nb,world\n";
    let files = vec![
        write_csv(dir.path(), "notes.csv", junk),
        write_csv(dir.path(), "spikes.csv", ANOMALY_CSV),
    ];

    let out = scan(&files, false).await;

    assert_eq!(out.tables_available, 1, "only the spikes table is analyzable");
    assert!(
        out.findings.iter().any(|f| f.kind == "anomaly"),
        "the analyzable table's anomaly still surfaces despite the junk table"
    );
}
