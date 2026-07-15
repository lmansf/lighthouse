//! Local-only marks ("Private — this device only", openspec: add-local-only-
//! marks). Covers the ancestor-wins resolver, migration tolerance, the shareable
//! gate, move/rename remap, the cross-engine parity contract (identical
//! retrieval candidate ids under a cloud provider — the node twin is
//! test/localOnly.test.mjs over the SAME fixture), and an end-to-end assertion
//! that a marked file's content never reaches the outbound prompt while the
//! honest skip note renders.

mod common;

use futures::StreamExt;
use lighthouse_core::contracts::ChatChunk;
use lighthouse_core::llm::ModelCfg;
use lighthouse_core::synth::answer_pipeline;
use lighthouse_core::vault::{self, VaultState};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn include_all(ids: &[&str]) {
    for id in ids {
        vault::set_included(id, true);
    }
}

// --- Resolver + migration (unit) -------------------------------------------------

#[test]
fn resolver_is_ancestor_wins() {
    let mut st = VaultState::default();
    st.local_only.insert("docs".to_string(), true);
    // The folder and everything beneath it resolve local-only, even without an
    // own mark; a sibling subtree does not.
    assert!(vault::is_effectively_local_only("docs", &st));
    assert!(vault::is_effectively_local_only("docs/a.md", &st));
    assert!(vault::is_effectively_local_only("docs/deep/b.md", &st));
    assert!(!vault::is_effectively_local_only("other/c.md", &st));

    // A child's own `false` cannot override a marked ancestor (safe direction).
    st.local_only.insert("docs/a.md".to_string(), false);
    assert!(vault::is_effectively_local_only("docs/a.md", &st), "ancestor wins over child false");

    // An independently-marked child with no marked ancestor is local-only.
    let mut st2 = VaultState::default();
    st2.local_only.insert("loose/child.md".to_string(), true);
    assert!(vault::is_effectively_local_only("loose/child.md", &st2));
    assert!(!vault::is_effectively_local_only("loose", &st2), "parent isn't marked by a child");
}

#[test]
fn old_state_json_loads_as_unmarked() {
    // A state.json written before this change (no `localOnly` key) must load with
    // every inclusion preserved and nothing local-only — the serde-default
    // tolerance IS the migration story (state.json stays un-versioned).
    let json = r#"{"sourceAvailable":true,"included":{"a.md":true,"docs/b.md":false},"references":{}}"#;
    let st: VaultState = serde_json::from_str(json).expect("old state parses");
    assert!(st.local_only.is_empty(), "no localOnly ⇒ empty map");
    assert_eq!(st.included.get("a.md"), Some(&true), "inclusion preserved");
    assert_eq!(st.included.get("docs/b.md"), Some(&false));
    assert!(!vault::is_effectively_local_only("a.md", &st));
}

// --- Shareable gate (through the public API) -------------------------------------

#[test]
fn folder_mark_privatizes_subtree_only_on_the_cloud_path() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("docs/a.md"), "alpha content");
    write(&dir.path().join("docs/b.md"), "beta content");
    write(&dir.path().join("public.md"), "public content");
    vault::invalidate_walk_cache();
    include_all(&["docs/a.md", "docs/b.md", "public.md"]);

    vault::set_local_only("docs", true);

    // Device path: local-only is inert — the full included set is shareable.
    let mut device = vault::shareable_file_ids(false);
    device.sort();
    assert_eq!(device, vec!["docs/a.md".to_string(), "docs/b.md".to_string(), "public.md".to_string()]);
    // active_included is never narrowed by the mark.
    assert_eq!(vault::active_included_file_ids().len(), 3);

    // Cloud path: the whole marked subtree drops out; the sibling stays.
    let cloud = vault::shareable_file_ids(true);
    assert_eq!(cloud, vec!["public.md".to_string()], "cloud shareable set = unmarked only");
    // And the skip-note counter sees exactly the two withheld files.
    let mut dropped = vault::local_only_subset(&vault::active_included_file_ids(), true);
    dropped.sort();
    assert_eq!(dropped, vec!["docs/a.md".to_string(), "docs/b.md".to_string()]);
}

#[test]
fn set_local_only_writes_only_the_target_no_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("docs/a.md"), "alpha");
    write(&dir.path().join("docs/b.md"), "beta");
    vault::invalidate_walk_cache();
    include_all(&["docs/a.md", "docs/b.md"]);

    // Mark then UNMARK the folder. With a descendant cascade (like set_included),
    // the children would have been stamped `true` and survive the folder's
    // `false`. With no cascade, only the folder's own flag ever existed, so
    // clearing it makes the whole subtree shareable again.
    vault::set_local_only("docs", true);
    assert!(vault::shareable_file_ids(true).is_empty(), "subtree withheld while folder marked");
    vault::set_local_only("docs", false);
    let mut back = vault::shareable_file_ids(true);
    back.sort();
    assert_eq!(
        back,
        vec!["docs/a.md".to_string(), "docs/b.md".to_string()],
        "no cascade: clearing the folder frees the never-stamped children"
    );
}

#[test]
fn mark_follows_move_and_rename() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("src/keep.md"), "x");
    std::fs::create_dir_all(dir.path().join("dst")).unwrap();
    vault::invalidate_walk_cache();
    vault::set_included("src/keep.md", true);
    vault::set_local_only("src/keep.md", true);

    let new_id = vault::move_node("src/keep.md", Some("dst")).unwrap();
    assert_eq!(new_id, "dst/keep.md");
    vault::invalidate_walk_cache();
    assert!(vault::shareable_file_ids(true).is_empty(), "mark rode the move");
    assert_eq!(vault::shareable_file_ids(false), vec!["dst/keep.md".to_string()]);

    let renamed = vault::rename_node("dst/keep.md", "kept.md").unwrap();
    assert_eq!(renamed, "dst/kept.md");
    vault::invalidate_walk_cache();
    assert!(vault::shareable_file_ids(true).is_empty(), "mark rode the rename");
}

// --- Cross-engine parity ---------------------------------------------------------

/// The byte-pinned parity fixture. The node twin (test/localOnly.test.mjs)
/// builds the SAME vault + marks and asserts the SAME candidate ids, so
/// local-only enforcement can't drift between the engines.
#[test]
fn parity_retrieval_candidate_ids_under_a_cloud_provider() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("quarterly report.md"), "quarterly revenue report growth summary");
    write(&dir.path().join("salaries.md"), "quarterly revenue report confidential salary figures");
    vault::invalidate_walk_cache();
    include_all(&["quarterly report.md", "salaries.md"]);
    vault::set_local_only("salaries.md", true);

    let ids = vec!["quarterly report.md".to_string(), "salaries.md".to_string()];
    // Cloud: the marked file is dropped from the candidate set even though its
    // content matches the query best.
    let cloud = vault::retrieve("quarterly revenue report", &ids, 5, &[], &[], true);
    let cloud_ids: Vec<String> = cloud.references.iter().map(|r| r.file_id.clone()).collect();
    assert_eq!(cloud_ids, vec!["quarterly report.md".to_string()], "cloud candidate ids");

    // Device: both files are candidates (the mark is inert on-device).
    let device = vault::retrieve("quarterly revenue report", &ids, 5, &[], &[], false);
    let mut device_ids: Vec<String> = device.references.iter().map(|r| r.file_id.clone()).collect();
    device_ids.sort();
    assert_eq!(device_ids, vec!["quarterly report.md".to_string(), "salaries.md".to_string()]);
}

// --- End-to-end ------------------------------------------------------------------

async fn collect_pipeline(question: &str, ids: Vec<String>, cfg: ModelCfg) -> (String, Vec<String>) {
    let mut stream = answer_pipeline(question.to_string(), ids, vec![], vec![], cfg);
    let mut text = String::new();
    let mut final_files: Vec<String> = Vec::new();
    while let Some(c) = stream.next().await {
        let c: ChatChunk = c;
        text.push_str(&c.delta);
        if c.done {
            if let Some(refs) = &c.references {
                final_files = refs.iter().map(|r| r.file_id.clone()).collect();
            }
        }
    }
    (text, final_files)
}

#[tokio::test]
async fn marked_file_never_reaches_the_cloud_prompt_and_skip_note_renders() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    // The shareable file matches the query; the marked file carries distinctive
    // secret content + column names that must never surface on the cloud path.
    write(&dir.path().join("public.md"), "The quarterly revenue report shows steady growth this period.");
    write(
        &dir.path().join("private.csv"),
        "employee,salary\nalice,TOPSECRET_999999\nbob,TOPSECRET_888888\n",
    );
    vault::invalidate_walk_cache();
    include_all(&["public.md", "private.csv"]);
    vault::set_local_only("private.csv", true);

    let ids = vec!["public.md".to_string(), "private.csv".to_string()];
    // A CLOUD provider selected but KEYLESS: origin is "anthropic" (cloud, so
    // local-only is armed), yet the answer resolves via the extractive fallback
    // with zero network — a hermetic E2E that still exercises the cloud gate.
    let cloud = ModelCfg {
        provider_id: Some("anthropic".into()),
        model_id: None,
        api_key: None,
    };
    let (text, final_files) =
        collect_pipeline("summarize the quarterly revenue report", ids.clone(), cloud).await;

    // The marked file's content, column names, and its very name never appear.
    for needle in ["TOPSECRET_999999", "TOPSECRET_888888", "salary", "private.csv"] {
        assert!(
            !text.contains(needle),
            "cloud answer leaked local-only material {needle:?}: {text}"
        );
    }
    assert!(
        !final_files.iter().any(|f| f == "private.csv"),
        "final citations must not include the marked file: {final_files:?}"
    );
    // The honest skip note renders (byte-shared template).
    assert!(
        text.contains("1 file skipped — marked private"),
        "skip note must render: {text}"
    );

    // Sanity: on the DEVICE path the same ask keeps the file (mark is inert) and
    // emits no skip note.
    vault::invalidate_walk_cache();
    let local = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
    let (device_text, _) =
        collect_pipeline("summarize the quarterly revenue report", ids, local).await;
    assert!(
        !device_text.contains("skipped — marked private"),
        "the device path never emits the skip note: {device_text}"
    );
}
