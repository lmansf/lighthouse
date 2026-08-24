//! Read-only file inspector ("What the AI sees", openspec: add-file-inspector).
//!
//! Asserts the SHARED fields (name, extractPreview, chunkMode, testSearch)
//! render, the RUST-ONLY fields (fromOcr, chunkCount, columns catalog,
//! indexedAt + freshness) are present in the shipping engine, the test-search
//! reuses the existing scorer scoped to the ONE file id, and the op is
//! side-effect free. The node twin (test/inspect.test.mjs) builds the SAME
//! fixture and asserts the Rust-only fields are ABSENT (never faked) there.
//!
//! Since 0.15.0 the subject is a conversation's ATTACHMENT, so the `included`
//! and `localOnly` fields are gone with the inclusion gate that produced them
//! — attaching is the whole decision. What "side-effect free" now means is
//! narrower and easier to state: inspecting must not change the corpus a
//! later ask sees.

mod common;

use lighthouse_core::catalog::ColumnKind;
use lighthouse_core::inspect::inspect;
use lighthouse_core::workspace;

const SALES: &[u8] =
    b"date,region,product,amount\n2025-01-02,NE,widgets,10\n2025-01-03,NW,gadgets,20\n2025-01-04,SE,widgets,30\n";
const OTHER: &[u8] = b"Quarterly widgets summary. BETA_ONLY_MARKER for the scoping assertion.";

/// A tabular file + a prose file, attached and index-warmed. The prose file
/// shares the query term "widgets" so the scoping assertion is meaningful (a
/// naive scorer would surface it; the file-scoped test-search must not).
/// Returns (conversation, sales id, other id).
fn setup(conversation: &str) -> (String, String) {
    let ids = common::attach_all(conversation, &[("sales.csv", SALES), ("other.md", OTHER)]);
    // Warm the persistent index so the peek-based chunkCount/indexedAt/freshness
    // fields are populated — exactly what eager ingest does at attach time.
    let _ = workspace::retrieve(conversation, "warm", &[], 5, &[]);
    (ids[0].clone(), ids[1].clone())
}

#[test]
fn tabular_inspection_reports_all_rust_fields_and_scoped_test_search() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    const CONV: &str = "conv-inspect-tabular";
    let (sales, _other) = setup(CONV);

    // --- metadata-only inspect (no query): the pure-read path ---
    let insp = inspect(CONV, &sales, None);

    // Shared fields render.
    assert_eq!(insp.name.as_deref(), Some("sales.csv"));
    assert_eq!(insp.chunk_mode.as_deref(), Some("tabular"));
    let preview = insp.extract_preview.as_deref().expect("csv has extractable text");
    assert!(preview.contains("region"), "preview is the extracted text: {preview:?}");

    // Rust-only fields are PRESENT in the shipping engine.
    assert_eq!(insp.from_ocr, Some(false), "a csv is not OCR-derived");
    assert!(insp.chunk_count.unwrap_or(0) >= 1, "index chunk count present");
    assert!(insp.indexed_at.is_some(), "index freshness key present");
    assert_eq!(insp.fresh, Some(true), "freshly warmed ⇒ matches the blob");
    // fp3 §1: OCR availability is gated on OCR-relevant extensions — a csv
    // never carries it (and never pays the model-load probe).
    assert!(insp.ocr_availability.is_none(), "csv is not OCR-relevant");

    // Columns + kinds from the catalog.
    let cols = insp.columns.as_ref().expect("tabular file has catalog columns");
    let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["date", "region", "product", "amount"]);
    assert_eq!(cols[0].kind, ColumnKind::Date);
    assert_eq!(cols[1].kind, ColumnKind::Text);
    assert_eq!(cols[2].kind, ColumnKind::Text);
    assert_eq!(cols[3].kind, ColumnKind::Numeric);

    // CSV/TSV get a parsed table preview (header + first rows) — a SHARED field.
    let pt = insp.preview_table.as_ref().expect("a csv gets a parsed table preview");
    let header: Vec<&str> = pt.header.iter().map(String::as_str).collect();
    assert_eq!(header, vec!["date", "region", "product", "amount"]);
    assert_eq!(pt.rows.len(), 3);
    let row0: Vec<&str> = pt.rows[0].iter().map(String::as_str).collect();
    assert_eq!(row0, vec!["2025-01-02", "NE", "widgets", "10"]);
    assert!(!pt.truncated, "the small fixture is not truncated");

    // The serialized payload carries every Rust-only key (the node twin asserts
    // these SAME keys are absent on its side — the parity contract).
    let v = serde_json::to_value(&insp).unwrap();
    for key in ["fromOcr", "chunkCount", "columns", "indexedAt", "fresh"] {
        assert!(v.get(key).is_some(), "rust payload carries {key}");
    }
    // No test-search field without a query.
    assert!(insp.test_search.is_none(), "no query ⇒ no test-search");

    // --- test-search: the existing scorer, scoped to the one file ---
    let hit = inspect(CONV, &sales, Some("widgets"));
    let hits = hit.test_search.expect("query ⇒ test-search results");
    assert!(!hits.is_empty(), "the matching file returns scored chunks");
    assert!(hits.iter().all(|h| h.score > 0.0), "every hit carries a score");
    assert!(
        hits.iter().any(|h| h.text.contains("widgets")),
        "the file's matching chunk is returned"
    );
    // Scoped: the OTHER attachment also matches "widgets" but must never
    // appear — retrieval was scoped to the one file id.
    assert!(
        hits.iter().all(|h| !h.text.contains("BETA_ONLY_MARKER")),
        "test-search must not surface any other file's chunks: {hits:?}"
    );
}

#[test]
fn prose_mode_no_columns_and_a_damaged_blob_is_reported_stale() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    const CONV: &str = "conv-inspect-prose";
    let (_sales, other) = setup(CONV);

    // A prose file: word-window chunking, no catalog columns.
    let prose = inspect(CONV, &other, None);
    assert_eq!(prose.chunk_mode.as_deref(), Some("prose"));
    assert!(prose.columns.is_none(), "a prose file has no catalog columns");
    assert_eq!(prose.from_ocr, Some(false));
    assert_eq!(prose.fresh, Some(true), "freshly warmed");

    // Freshness has a NARROWER subject since 0.15.0: blobs are write-once and
    // content-addressed, so an attachment's bytes cannot change under the app.
    // What the field still catches is a DAMAGED store — a blob rewritten
    // underneath the index by something outside the app. Simulate exactly that.
    let blob = workspace::resolve(CONV, &other).expect("attachment resolves").1;
    std::fs::write(
        &blob,
        "Quarterly widgets summary. BETA_ONLY_MARKER plus a freshly appended sentence.",
    )
    .unwrap();

    let stale = inspect(CONV, &other, None);
    assert_eq!(stale.fresh, Some(false), "blob changed underneath ⇒ index entry is stale");
    assert!(stale.indexed_at.is_some(), "the stale entry still renders its key");
}

/// fp3 §1: for a file OCR could apply to (image / PDF) the inspection carries
/// the OCR availability verdict, so a build whose models never shipped is
/// diagnosable from the panel instead of silently name-only. The VALUE depends
/// on the environment (models fetched or not, toggle, policy, and the
/// process-wide OnceLock a sibling test may already have primed), so assert
/// presence + the closed value set rather than one env-dependent value.
#[test]
fn ocr_relevant_file_reports_availability_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    const CONV: &str = "conv-inspect-ocr";
    // Not a decodable image — extraction honestly yields no text, which is
    // exactly the silent state the availability field explains.
    let ids = common::attach_all(CONV, &[("scan.png", b"not really a png")]);

    let insp = inspect(CONV, &ids[0], None);
    let verdict = insp
        .ocr_availability
        .as_deref()
        .expect("png is OCR-relevant ⇒ availability present");
    assert!(
        ["ready", "off", "missing-models"].contains(&verdict),
        "verdict is one of the engine's three honest states: {verdict:?}"
    );
    assert!(insp.extract_preview.is_none(), "undecodable png has no text");

    // The serialized payload carries the camelCase key the UI reads (the node
    // twin fills the SAME key with its own constant "unsupported").
    let v = serde_json::to_value(&insp).unwrap();
    assert!(v.get("ocrAvailability").is_some(), "payload carries ocrAvailability");
}

/// Inspecting must not mutate the corpus: the conversation's attachment list —
/// ids, names, hashes and order — survives an inspect (with and without a
/// test-search query) exactly as it was.
#[test]
fn inspect_is_side_effect_free() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    const CONV: &str = "conv-inspect-pure";
    let (sales, other) = setup(CONV);

    let before: Vec<(String, String, String)> = workspace::list(CONV)
        .into_iter()
        .map(|f| (f.id, f.name, f.hash))
        .collect();

    let _ = inspect(CONV, &sales, None);
    let _ = inspect(CONV, &sales, Some("widgets region"));
    let _ = inspect(CONV, &other, Some("widgets"));
    // An id that does not resolve must also be a pure read, not a repair.
    let _ = inspect(CONV, "att-000000000000", Some("widgets"));

    let after: Vec<(String, String, String)> = workspace::list(CONV)
        .into_iter()
        .map(|f| (f.id, f.name, f.hash))
        .collect();
    assert_eq!(after, before, "the attachment manifest is unchanged by inspect");
    assert!(
        workspace::resolve(CONV, &sales).is_some(),
        "the inspected attachment still resolves to its blob"
    );
}

/// An id from another conversation — or one that was detached — inspects to an
/// EMPTY inspection rather than leaking across the boundary or panicking.
#[test]
fn an_id_outside_this_conversation_inspects_to_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let (sales, _) = setup("conv-owner");
    let _ = setup("conv-stranger");

    let leaked = inspect("conv-stranger", &sales, Some("widgets"));
    // Same bytes under the same name mint the same id in every conversation,
    // so this id DOES resolve in the stranger — the point is that resolution
    // goes through the stranger's OWN manifest, never the owner's.
    assert_eq!(leaked.name.as_deref(), Some("sales.csv"));

    let empty = inspect("conv-empty", &sales, Some("widgets"));
    assert!(empty.name.is_none(), "a conversation with no manifest inspects to nothing");
    assert!(empty.test_search.is_none(), "and runs no search");

    workspace::detach("conv-owner", &sales);
    let gone = inspect("conv-owner", &sales, None);
    assert!(gone.name.is_none(), "a detached id no longer inspects");
}
