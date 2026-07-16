//! Read-only file inspector ("What the AI sees", openspec: add-file-inspector).
//!
//! Asserts the SHARED fields (name, included, localOnly, extractPreview,
//! chunkMode, testSearch) render, the RUST-ONLY fields (fromOcr, chunkCount,
//! columns catalog, indexedAt + freshness) are present in the shipping engine,
//! the test-search reuses the existing scorer scoped to the ONE file id, and the
//! op is side-effect free. The node twin (test/inspect.test.mjs) builds the SAME
//! fixture and asserts the Rust-only fields are ABSENT (never faked) there.

mod common;

use lighthouse_core::catalog::ColumnKind;
use lighthouse_core::inspect::inspect;
use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A tabular file + a prose file, both included and index-warmed. The prose file
/// shares the query term "widgets" so the scoping assertion is meaningful (a
/// naive scorer would surface it; the file-scoped test-search must not).
fn setup(dir: &std::path::Path) {
    write(
        &dir.join("sales.csv"),
        "date,region,product,amount\n2025-01-02,NE,widgets,10\n2025-01-03,NW,gadgets,20\n2025-01-04,SE,widgets,30\n",
    );
    write(
        &dir.join("other.md"),
        "Quarterly widgets summary. BETA_ONLY_MARKER for the scoping assertion.",
    );
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);
    vault::set_included("other.md", true);
    // Warm the persistent index so the peek-based chunkCount/indexedAt/freshness
    // fields are populated — exactly what warm_index_async does on include/boot.
    let ids = vec!["sales.csv".to_string(), "other.md".to_string()];
    let _ = vault::retrieve("warm", &ids, 5, &[], &[], false, &[]);
}

#[test]
fn tabular_inspection_reports_all_rust_fields_and_scoped_test_search() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    setup(dir.path());

    // --- metadata-only inspect (no query): the pure-read path ---
    let insp = inspect("sales.csv", None);

    // Shared fields render.
    assert_eq!(insp.name.as_deref(), Some("sales.csv"));
    assert_eq!(insp.included, Some(true));
    assert_eq!(insp.local_only, Some(false));
    assert_eq!(insp.chunk_mode.as_deref(), Some("tabular"));
    let preview = insp.extract_preview.as_deref().expect("csv has extractable text");
    assert!(preview.contains("region"), "preview is the extracted text: {preview:?}");

    // Rust-only fields are PRESENT in the shipping engine.
    assert_eq!(insp.from_ocr, Some(false), "a csv is not OCR-derived");
    assert!(insp.chunk_count.unwrap_or(0) >= 1, "index chunk count present");
    assert!(insp.indexed_at.is_some(), "index freshness key present");
    assert_eq!(insp.fresh, Some(true), "freshly warmed ⇒ matches disk");

    // Columns + kinds from the catalog.
    let cols = insp.columns.as_ref().expect("tabular file has catalog columns");
    let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["date", "region", "product", "amount"]);
    assert_eq!(cols[0].kind, ColumnKind::Date);
    assert_eq!(cols[1].kind, ColumnKind::Text);
    assert_eq!(cols[2].kind, ColumnKind::Text);
    assert_eq!(cols[3].kind, ColumnKind::Numeric);

    // The serialized payload carries every Rust-only key (the node twin asserts
    // these SAME keys are absent on its side — the parity contract).
    let v = serde_json::to_value(&insp).unwrap();
    for key in ["fromOcr", "chunkCount", "columns", "indexedAt", "fresh"] {
        assert!(v.get(key).is_some(), "rust payload carries {key}");
    }
    // No test-search field without a query.
    assert!(insp.test_search.is_none(), "no query ⇒ no test-search");

    // --- test-search: the existing scorer, scoped to the one file ---
    let hit = inspect("sales.csv", Some("widgets"));
    let hits = hit.test_search.expect("query ⇒ test-search results");
    assert!(!hits.is_empty(), "the matching file returns scored chunks");
    assert!(hits.iter().all(|h| h.score > 0.0), "every hit carries a score");
    assert!(
        hits.iter().any(|h| h.text.contains("widgets")),
        "the file's matching chunk is returned"
    );
    // Scoped: the OTHER included file also matches "widgets" but must never
    // appear — retrieval was scoped to the one file id.
    assert!(
        hits.iter().all(|h| !h.text.contains("BETA_ONLY_MARKER")),
        "test-search must not surface any other file's chunks: {hits:?}"
    );
}

#[test]
fn prose_mode_no_columns_and_stale_index_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    setup(dir.path());

    // A prose file: word-window chunking, no catalog columns.
    let prose = inspect("other.md", None);
    assert_eq!(prose.chunk_mode.as_deref(), Some("prose"));
    assert!(prose.columns.is_none(), "a prose file has no catalog columns");
    assert_eq!(prose.from_ocr, Some(false));
    assert_eq!(prose.fresh, Some(true), "freshly warmed");

    // Freshness is the point: edit the file on disk (size changes ⇒ key changes)
    // WITHOUT re-warming, and the peek reports the persisted entry as stale
    // rather than silently rebuilding it.
    write(
        &dir.path().join("other.md"),
        "Quarterly widgets summary. BETA_ONLY_MARKER plus a freshly appended sentence.",
    );
    vault::invalidate_walk_cache();
    let stale = inspect("other.md", None);
    assert_eq!(stale.fresh, Some(false), "edited on disk ⇒ index entry is stale");
    assert!(stale.indexed_at.is_some(), "the stale entry still renders its key");
}

/// Inspecting must not mutate vault state: inclusion + local-only survive an
/// inspect (with and without a test-search query) exactly as they were.
#[test]
fn inspect_is_side_effect_free() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    setup(dir.path());
    vault::set_local_only("sales.csv", true);

    let included_before = vault::active_included_file_ids();
    let shareable_before = vault::shareable_file_ids(true); // cloud path drops marked

    let _ = inspect("sales.csv", None);
    let _ = inspect("sales.csv", Some("widgets region"));
    let _ = inspect("other.md", Some("widgets"));

    vault::invalidate_walk_cache();
    assert_eq!(
        vault::active_included_file_ids(),
        included_before,
        "inclusion unchanged by inspect"
    );
    assert_eq!(
        vault::shareable_file_ids(true),
        shareable_before,
        "local-only marks unchanged by inspect"
    );
    assert!(
        vault::node_is_local_only("sales.csv"),
        "the marked file is still marked after inspecting it"
    );
}
