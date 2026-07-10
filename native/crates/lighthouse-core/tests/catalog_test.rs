//! Column-catalog behavior over real files: header + kind reading, the
//! mtime+size cache, and the never-fatal contract for unreadable members.

mod common;

use lighthouse_core::catalog::{columns_for, ColumnKind};

#[test]
fn catalog_reads_kinds_caches_and_omits_broken_files() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());

    let csv = vault.path().join("sales.csv");
    std::fs::write(&csv, "date,region,amount\n2025-01-02,NE,10\n2025-01-03,NW,20\n").unwrap();
    let bad = vault.path().join("broken.xlsx");
    std::fs::write(&bad, b"not a workbook").unwrap();
    let files = vec![
        ("s".to_string(), "sales.csv".to_string(), csv.clone()),
        ("b".to_string(), "broken.xlsx".to_string(), bad),
    ];

    let cols = columns_for(&files);
    assert_eq!(cols.len(), 1, "unreadable file omitted, never fatal");
    let names: Vec<&str> = cols[0].columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["date", "region", "amount"]);
    assert_eq!(cols[0].columns[0].kind, ColumnKind::Date);
    assert_eq!(cols[0].columns[1].kind, ColumnKind::Text);
    assert_eq!(cols[0].columns[2].kind, ColumnKind::Numeric);

    // A pure cache hit does not rewrite the cache file.
    let cache = vault.path().join(".rag-vault/cache/columns.json");
    assert!(cache.exists(), "catalog persisted");
    let before = std::fs::read_to_string(&cache).unwrap();
    let again = columns_for(&files);
    assert_eq!(again.len(), 1);
    assert_eq!(std::fs::read_to_string(&cache).unwrap(), before);

    // Editing the file (size changes) invalidates its entry.
    std::fs::write(&csv, "date,region,amount,rep\n2025-01-02,NE,10,alice\n").unwrap();
    let cols = columns_for(&files);
    assert_eq!(cols[0].columns.len(), 4, "re-read after edit");
    assert_eq!(cols[0].columns[3].name, "rep");

    // A corrupt cache degrades to recompute, not failure.
    std::fs::write(&cache, "{ not json").unwrap();
    let cols = columns_for(&files);
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].columns.len(), 4);
}
