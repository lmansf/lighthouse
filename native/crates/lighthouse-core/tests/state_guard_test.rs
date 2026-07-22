//! §39 §5: the state-file written_by guard, end to end against a real
//! state.json on disk. An app OLDER than the file's writer goes READ-ONLY on
//! that state — reads work, writes refuse — so a newer build's fields are
//! never clobbered by an older binary re-serializing a struct that doesn't
//! know them. Normal-path saves stamp the running version and round-trip
//! byte-identically.

use std::path::Path;

use lighthouse_core::vault::{set_included, state_written_by_newer};

mod common;

fn state_file(vault: &Path) -> std::path::PathBuf {
    vault.join(".rag-vault").join("state.json")
}

#[test]
fn version_compare_is_semver_triples_and_junk_never_reads_newer() {
    // Strictly newer writer → guard trips.
    assert!(state_written_by_newer(Some("99.0.0"), "0.14.5"));
    assert!(state_written_by_newer(Some("0.15.0"), "0.14.9"));
    assert!(state_written_by_newer(Some("0.14.6"), "0.14.5"));
    // Same or older → writable.
    assert!(!state_written_by_newer(Some("0.14.5"), "0.14.5"));
    assert!(!state_written_by_newer(Some("0.13.10"), "0.14.5"));
    // Pre-§39 files carry no stamp → writable (the additive migration story).
    assert!(!state_written_by_newer(None, "0.14.5"));
    // Junk stamps read (0,0,0) — the guard fails OPEN for garbage.
    assert!(!state_written_by_newer(Some("not-a-version"), "0.14.5"));
    // Pre-release digits still compare on their numeric prefix.
    assert!(state_written_by_newer(Some("1.0.0-beta"), "0.14.5"));
}

#[test]
fn an_older_build_reading_newer_state_goes_read_only_and_preserves_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let _lock = common::lock_env(dir.path());

    // A state.json from "the future": a newer writer stamp AND a field this
    // build has never heard of. serde-default loads it fine (the unknown key
    // is simply not represented in memory) — which is exactly why a write
    // from this build would DROP it.
    let file = state_file(dir.path());
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let future = r#"{"sourceAvailable":true,"included":{},"futureFeatureFlags":{"beam2":true},"writtenBy":"99.0.0"}"#;
    std::fs::write(&file, future).unwrap();

    // A write through the public API must REFUSE: the file's bytes — unknown
    // field included — survive untouched.
    set_included("some-node.md", true);
    let after = std::fs::read_to_string(&file).unwrap();
    assert_eq!(after, future, "the newer writer's file is byte-untouched");
    assert!(after.contains("futureFeatureFlags"), "the unknown field survives");
}

#[test]
fn normal_path_stamps_the_writer_and_round_trips_byte_identically() {
    let dir = tempfile::tempdir().unwrap();
    let _lock = common::lock_env(dir.path());

    // First write on a fresh vault: the save lands and stamps written_by
    // with the running version.
    set_included("notes.md", true);
    let file = state_file(dir.path());
    let first = std::fs::read_to_string(&file).unwrap();
    let running = lighthouse_core::config::app_version();
    assert!(
        first.contains(&format!("\"writtenBy\": \"{running}\"")),
        "the save stamps the running version: {first}"
    );

    // Same-version file, same effective write → byte-identical round-trip.
    set_included("notes.md", true);
    let second = std::fs::read_to_string(&file).unwrap();
    assert_eq!(first, second, "the current-version normal path is byte-stable");
}
