//! Extraction parity tests: PDF (the same fixture the TS suite uses), a
//! generated DOCX, XLS/CSV handling, and the mtime+size disk cache contract.

mod common;

use std::io::Write as _;

use lighthouse_core::extract::{extract_rich_text, is_rich_file};

#[test]
fn rich_file_detection_is_extension_based() {
    assert!(is_rich_file("report.PDF"));
    assert!(is_rich_file("deck.docx"));
    assert!(is_rich_file("sheet.xlsx"));
    assert!(is_rich_file("legacy.xls"));
    assert!(!is_rich_file("notes.md"));
    assert!(!is_rich_file("archive.zip"));
    assert!(!is_rich_file("pdf")); // no stem — not an extension
}

#[test]
fn pdf_fixture_extracts_text_and_caches() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // The same fixture the TS test suite uses (test/fixtures/sample.pdf).
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/sample.pdf");
    let dest = vault_dir.path().join("sample.pdf");
    std::fs::copy(&fixture, &dest).expect("fixture present in repo");

    let text = extract_rich_text(&dest, ".pdf");
    assert!(!text.trim().is_empty(), "fixture PDF must yield text");

    // Second call hits the cache: poison the cache entry and confirm it is
    // served verbatim (proving the mtime+size key short-circuits the parser).
    let cache_dir = vault_dir.path().join(".rag-vault/cache/extract");
    let entry = std::fs::read_dir(&cache_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&entry).unwrap()).unwrap();
    // Must track CACHE_VERSION in extract.rs AND src/server/extract.ts (bump all
    // three together). v5→6 pptx/odt/rtf (0.9.0), v6→7 OCR (add-ocr-perception).
    assert_eq!(record["v"], 7, "cache schema version matches the TS engine");
    let mut poisoned = record.clone();
    poisoned["text"] = serde_json::Value::String("FROM-CACHE".into());
    std::fs::write(&entry, serde_json::to_string(&poisoned).unwrap()).unwrap();
    assert_eq!(extract_rich_text(&dest, ".pdf"), "FROM-CACHE");

    // A stale schema version forces a re-parse.
    poisoned["v"] = serde_json::json!(1);
    std::fs::write(&entry, serde_json::to_string(&poisoned).unwrap()).unwrap();
    assert_ne!(extract_rich_text(&dest, ".pdf"), "FROM-CACHE");
}

#[test]
fn docx_zip_of_xml_extracts_paragraph_text() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // Build a minimal but well-formed DOCX (a zip holding word/document.xml).
    let doc_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Lighthouse rewrite scope</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph with keywords: calamine and tantivy.</w:t></w:r></w:p>
  </w:body>
</w:document>"#;
    let dest = vault_dir.path().join("scope.docx");
    let file = std::fs::File::create(&dest).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file::<_, ()>("word/document.xml", Default::default())
        .unwrap();
    zip.write_all(doc_xml.as_bytes()).unwrap();
    zip.finish().unwrap();

    let text = extract_rich_text(&dest, ".docx");
    assert!(text.contains("Lighthouse rewrite scope"));
    assert!(text.contains("calamine and tantivy"));
    assert!(
        text.contains("\n\n"),
        "paragraphs separated by a blank line"
    );
}

#[test]
fn corrupt_documents_degrade_to_empty_and_are_not_cached() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    let dest = vault_dir.path().join("broken.docx");
    std::fs::write(&dest, b"this is not a zip archive at all").unwrap();
    assert_eq!(extract_rich_text(&dest, ".docx"), "");

    // Failures must NOT be cached (a transient error is retried next scan).
    let cache_dir = vault_dir.path().join(".rag-vault/cache/extract");
    let cached = std::fs::read_dir(&cache_dir)
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(cached, 0, "failed parses are never pinned to empty");
}

#[test]
fn oversized_source_files_are_refused() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // A sparse-ish 65 MB "pdf" (just zeros) must be refused by the size guard
    // before any parse attempt.
    let dest = vault_dir.path().join("huge.pdf");
    let f = std::fs::File::create(&dest).unwrap();
    f.set_len(65 * 1024 * 1024).unwrap();
    assert_eq!(extract_rich_text(&dest, ".pdf"), "");
}
