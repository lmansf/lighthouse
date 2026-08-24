//! The persistent incremental index, over the 0.15.0 corpus.
//!
//! Two of these cases used to be about the vault: an FS watcher bumping a
//! generation counter when a file appeared outside the app, and a perf gate on
//! a 2,000-file walk. Neither has a subject any more — attachments arrive
//! through the app, and a conversation holds at most ten of them. What
//! survives is the part that still carries weight, and now carries MORE of it:
//! the index must persist, must rebuild when content changes, must warm
//! itself the moment a file is attached, and must answer fast on the corpus
//! the app actually promises to be best at.

mod common;

use lighthouse_core::workspace;

const CONV: &str = "conv-index";

#[test]
fn index_persists_and_rebuilds_on_content_change() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    let ids = common::attach_all(
        CONV,
        &[
            ("a.md", b"alpha document about zebras and migration"),
            ("b.md", b"beta document about sourdough baking"),
        ],
    );

    // Retrieval builds both entries; persistence is DEBOUNCED (a background
    // flusher batches writes), so flush explicitly before reading the disk.
    let r = workspace::retrieve(CONV, "zebras migration", &[], 5, &[]);
    assert_eq!(r.references[0].file_id, ids[0]);
    let index_file = dir.path().join(".rag-vault/cache/index-v1.json");
    lighthouse_core::index::flush_now();
    let disk = std::fs::read_to_string(&index_file).expect("index persisted to disk");
    assert!(disk.contains("zebras"), "chunk text persisted");
    assert_eq!(
        disk.lines().count(),
        1,
        "index is compact JSON — pretty-printing a corpus-sized file cost real time per flush"
    );

    // Attachment blobs are write-once and content-addressed, so "editing a
    // file" is attaching different bytes: a new blob, a new id, and — the
    // property under test — a NEW index entry that does not inherit the old
    // one's text. The old entry survives alongside it, because the old blob
    // still exists and another conversation may still cite it.
    let edited =
        workspace::attach(CONV, "a.md", b"alpha document now about quasars and telescopes").unwrap();
    assert_ne!(edited.id, ids[0], "different bytes are a different attachment");
    let r = workspace::retrieve(CONV, "quasars telescopes", &[], 5, &[]);
    assert_eq!(r.references[0].file_id, edited.id);
    // In memory right away, on disk only after the debounce — that deferral is
    // the fix for the full-file fsync storm the vault era hit on big corpora.
    let disk = std::fs::read_to_string(&index_file).unwrap();
    assert!(!disk.contains("quasars"), "persistence is debounced, not per-query");
    lighthouse_core::index::flush_now();
    let disk = std::fs::read_to_string(&index_file).unwrap();
    assert!(disk.contains("quasars"), "new content indexed under its own key");

    // A fresh process (simulated: drop the in-memory index) serves from disk
    // without re-reading a single blob.
    lighthouse_core::index::invalidate_all();
    let warm = workspace::retrieve(CONV, "quasars telescopes", &[], 5, &[]);
    assert_eq!(warm.references[0].file_id, edited.id);
}

/// Attaching warms the index in the background — the first question after a
/// drop must not pay the extraction cost. This is the 0.15.0 heir to the
/// "slow after linking a large number of files" report: the work moved to the
/// moment of attach, where the user is already waiting on a file dialog.
#[test]
fn attaching_warms_the_index_in_the_background() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    let att = workspace::attach(
        "conv-warm",
        "notes.md",
        b"attached corpus mentions bioluminescence extensively",
    )
    .unwrap();
    workspace::ingest_detached(&att);

    // No query is ever issued — the detached ingest alone must index the
    // content (poll: the ingest thread races this test).
    let index_file = dir.path().join(".rag-vault/cache/index-v1.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut warmed = false;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
        lighthouse_core::index::flush_now();
        if std::fs::read_to_string(&index_file)
            .map(|d| d.contains("bioluminescence"))
            .unwrap_or(false)
        {
            warmed = true;
            break;
        }
    }
    assert!(warmed, "attach must index its content unprompted");
}

/// Perf gate for the corpus the app now stakes its name on: a FULL
/// conversation — ten attachments, ~1 MB each — must ingest in seconds and
/// answer in a small fraction of a second. The old gate measured a 2,000-file
/// walk; this one measures the promise ("the best at analyzing small groups of
/// files"), so the bounds are tighter than the vault's ever were.
#[test]
fn perf_gate_full_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

    let topics = ["budget", "recipe", "roadmap", "minutes", "inventory"];
    let mut blobs: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..workspace::MAX_ATTACHMENTS {
        let topic = topics[i % topics.len()];
        let mut text = String::new();
        // ~1 MB per file: 6,000 paragraphs of topical prose.
        for p in 0..6_000 {
            text.push_str(&format!(
                "Paragraph {p} of document {i} about {topic}. It discusses {topic} planning, \
                 {topic} review, and quarterly {topic} outcomes for team {}.\n",
                p % 17
            ));
        }
        blobs.push((format!("{topic}-{i}.md"), text.into_bytes()));
    }

    let t0 = std::time::Instant::now();
    for (name, bytes) in &blobs {
        let att = workspace::attach("conv-perf", name, bytes).unwrap();
        workspace::ingest(&att);
    }
    let ingest_ms = t0.elapsed().as_millis();

    let t1 = std::time::Instant::now();
    let cold = workspace::retrieve("conv-perf", "quarterly budget outcomes", &[], 5, &[]);
    let cold_ms = t1.elapsed().as_millis();
    assert!(!cold.references.is_empty());

    let t2 = std::time::Instant::now();
    let warm = workspace::retrieve("conv-perf", "sourdough recipe review", &[], 5, &[]);
    let warm_ms = t2.elapsed().as_millis();
    assert!(!warm.references.is_empty());

    let bytes: usize = blobs.iter().map(|(_, b)| b.len()).sum();
    eprintln!(
        "perf: ingest {ingest_ms} ms; first query {cold_ms} ms; warm query {warm_ms} ms \
         ({} files, {} MB)",
        blobs.len(),
        bytes / (1024 * 1024)
    );
    assert!(ingest_ms < 30_000, "ingesting a full conversation took {ingest_ms} ms");
    assert!(
        cold_ms < 2_000,
        "the first query after ingest took {cold_ms} ms — eager ingest must leave it warm"
    );
    assert!(warm_ms < 500, "warm query took {warm_ms} ms — the corpus is ten files");
}
