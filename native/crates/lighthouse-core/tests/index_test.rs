//! Phase 5 tests: persistent incremental index, FS watcher, and a perf gate on
//! a synthetic corpus.

mod common;

use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn index_persists_and_rebuilds_incrementally() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(
        &vault_dir.path().join("a.md"),
        "alpha document about zebras and migration",
    );
    write(
        &vault_dir.path().join("b.md"),
        "beta document about sourdough baking",
    );
    vault::set_included("a.md", true);
    vault::set_included("b.md", true);
    let ids: Vec<String> = vec!["a.md".into(), "b.md".into()];

    // First query builds both entries; persistence is DEBOUNCED (a background
    // flusher batches writes), so flush explicitly before reading the disk.
    let r = vault::retrieve("zebras migration", &ids, 5, &[], &[], false);
    assert_eq!(r.references[0].file_id, "a.md");
    let index_file = vault_dir.path().join(".rag-vault/cache/index-v1.json");
    lighthouse_core::index::flush_now();
    let disk = std::fs::read_to_string(&index_file).expect("index persisted to disk");
    assert!(disk.contains("zebras"), "chunk text persisted");
    assert_eq!(
        disk.lines().count(),
        1,
        "index is compact JSON — pretty-printing a corpus-sized file cost real time per flush"
    );

    // Editing one file re-indexes only it (the other entry's key is unchanged;
    // the persisted index reflects the new content after the next query).
    std::thread::sleep(std::time::Duration::from_millis(20)); // distinct mtime
    write(
        &vault_dir.path().join("a.md"),
        "alpha document now about quasars and telescopes",
    );
    let r = vault::retrieve("quasars telescopes", &ids, 5, &[], &[], false);
    assert_eq!(r.references[0].file_id, "a.md");
    // The rebuild is in memory right away, but the disk write is deferred —
    // that deferral is the fix for the full-file fsync storm on big corpora.
    let disk = std::fs::read_to_string(&index_file).unwrap();
    assert!(
        !disk.contains("quasars"),
        "persistence is debounced, not per-query"
    );
    lighthouse_core::index::flush_now();
    let disk = std::fs::read_to_string(&index_file).unwrap();
    assert!(
        disk.contains("quasars"),
        "stale entry rebuilt on key mismatch"
    );
    let stale = vault::retrieve("zebras migration", &ids, 5, &[], &[], false);
    assert!(
        stale.references.iter().all(|refr| refr.file_id != "a.md"),
        "old content no longer matches after rebuild"
    );

    // A fresh process (simulated: drop the in-memory index) serves from disk.
    lighthouse_core::index::invalidate_all();
    let warm = vault::retrieve("quasars telescopes", &ids, 5, &[], &[], false);
    assert_eq!(warm.references[0].file_id, "a.md");
}

#[test]
fn watcher_invalidates_walk_cache_and_bumps_generation() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    lighthouse_core::watch::start();
    // Give the watcher thread a moment to arm on this vault.
    let armed_by = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !lighthouse_core::watch::is_active() && std::time::Instant::now() < armed_by {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !lighthouse_core::watch::is_active() {
        eprintln!("watcher backend unavailable here; TTL fallback covers this platform");
        return;
    }

    // Warm the walk cache, then create a file OUTSIDE the app.
    let before = vault::list_nodes().len();
    let gen_before = lighthouse_core::watch::generation();
    write(
        &vault_dir.path().join("appeared.md"),
        "created outside the app",
    );

    // The event must invalidate the snapshot so the very next walk sees the
    // file (no 3 s TTL wait), and the generation counter must move.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut seen = false;
    while std::time::Instant::now() < deadline {
        if lighthouse_core::watch::generation() > gen_before && vault::list_nodes().len() > before {
            seen = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(seen, "external change must surface via the watcher");
}

/// Linking a folder warms the index in the background — the first question
/// afterwards must not pay the corpus build (the "slow after linking a large
/// number of files" report).
#[test]
fn linking_warms_the_index_in_the_background() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    let linked = tempfile::tempdir().unwrap();
    write(
        &linked.path().join("notes.md"),
        "linked corpus mentions bioluminescence extensively",
    );
    let (ref_id, kind) = vault::add_reference(&linked.path().to_string_lossy()).unwrap();
    assert_eq!(kind, "folder");
    vault::set_included(&ref_id, true);

    // No query is ever issued — the background warm alone must index the
    // linked content (poll: the warm thread races this test).
    let index_file = vault_dir.path().join(".rag-vault/cache/index-v1.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut warmed = false;
    while std::time::Instant::now() < deadline {
        lighthouse_core::vault::warm_index_async(); // idempotent; re-kick in case inclusion landed after the link's warm
        std::thread::sleep(std::time::Duration::from_millis(150));
        lighthouse_core::index::flush_now();
        if std::fs::read_to_string(&index_file)
            .map(|d| d.contains("bioluminescence"))
            .unwrap_or(false)
        {
            warmed = true;
            break;
        }
    }
    assert!(warmed, "background warm must index linked content unprompted");
}

/// Perf gate (generous bounds so CI stays stable): a 2,000-file corpus must
/// index in seconds and answer warm queries in well under a second.
#[test]
fn perf_gate_2k_file_corpus() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // 2,000 in CI; override with LIGHTHOUSE_PERF_FILES for local benchmarking.
    let files: usize = std::env::var("LIGHTHOUSE_PERF_FILES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_000);
    let topics = ["budget", "recipe", "roadmap", "minutes", "inventory"];
    for i in 0..files {
        let topic = topics[i % topics.len()];
        write(
            &vault_dir.path().join(format!("corpus/{topic}-{i}.md")),
            &format!(
                "Document {i} about {topic}. It discusses {topic} planning, {topic} review, \
                 and quarterly {topic} outcomes for team {}.",
                i % 17
            ),
        );
    }
    vault::set_included("corpus", true);
    let ids: Vec<String> = (0..files)
        .map(|i| format!("corpus/{}-{i}.md", topics[i % topics.len()]))
        .collect();

    let t0 = std::time::Instant::now();
    let cold = vault::retrieve("quarterly budget outcomes", &ids, 5, &[], &[], false);
    let cold_ms = t0.elapsed().as_millis();
    assert!(!cold.references.is_empty());

    let t1 = std::time::Instant::now();
    let warm = vault::retrieve("sourdough recipe review", &ids, 5, &[], &[], false);
    let warm_ms = t1.elapsed().as_millis();
    assert!(!warm.references.is_empty());

    eprintln!("perf: cold index+query {cold_ms} ms; warm query {warm_ms} ms ({files} files)");
    assert!(
        cold_ms < 30_000,
        "cold index of {files} files took {cold_ms} ms"
    );
    assert!(
        warm_ms < 1_000,
        "warm query took {warm_ms} ms — index must keep queries fast"
    );
}
