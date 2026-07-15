//! Vault engine parity tests — ports the behaviors covered by the TS suite
//! `test/vault.reference.test.mjs` plus inclusion/move/trash/upload semantics.

mod common;

use lighthouse_core::contracts::NodeKind;
use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn link_in_place_adds_reference_without_copying() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&outside.path().join("real.md"), "linked content stays put");
    let (id, kind) =
        vault::add_reference(outside.path().join("real.md").to_str().unwrap()).unwrap();
    assert_eq!(kind, "file");
    assert!(id.starts_with("ext"));

    // Nothing copied into the vault; the node lists as external.
    let nodes = vault::list_nodes();
    let node = nodes
        .iter()
        .find(|n| n.id == id)
        .expect("linked node listed");
    assert_eq!(node.external, Some(true));
    assert_eq!(node.kind, NodeKind::File);
    assert!(
        !vault_dir.path().join("real.md").exists(),
        "linking must not copy the file into the vault"
    );
}

#[test]
fn relinking_same_path_is_idempotent() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&outside.path().join("doc.txt"), "x");
    let (id1, _) = vault::add_reference(outside.path().join("doc.txt").to_str().unwrap()).unwrap();
    let (id2, _) = vault::add_reference(outside.path().join("doc.txt").to_str().unwrap()).unwrap();
    assert_eq!(
        id1, id2,
        "re-linking the exact same path returns the existing reference"
    );
}

#[test]
fn linking_file_inside_linked_folder_resolves_to_descendant_id() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&outside.path().join("folder/inner.md"), "covered");
    let (folder_id, kind) =
        vault::add_reference(outside.path().join("folder").to_str().unwrap()).unwrap();
    assert_eq!(kind, "folder");

    // A drop of an already-covered file resolves to the existing node id.
    let (inner_id, inner_kind) =
        vault::add_reference(outside.path().join("folder/inner.md").to_str().unwrap()).unwrap();
    assert_eq!(inner_kind, "file");
    assert_eq!(inner_id, format!("{folder_id}/inner.md"));
}

#[test]
fn overlapping_references_and_vault_paths_are_rejected() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // Linking anything overlapping the vault is a first-class error.
    write(&vault_dir.path().join("inside.md"), "vault file");
    let err = vault::add_reference(vault_dir.path().join("inside.md").to_str().unwrap())
        .expect_err("in-vault link must fail");
    assert_eq!(err.to_string(), "overlaps the vault");

    // An ancestor of an existing linked folder is an overlap.
    write(&outside.path().join("parent/child/file.md"), "x");
    vault::add_reference(outside.path().join("parent/child").to_str().unwrap()).unwrap();
    let err = vault::add_reference(outside.path().join("parent").to_str().unwrap())
        .expect_err("ancestor link must fail");
    assert_eq!(err.to_string(), "overlaps an existing reference");
}

#[test]
fn inclusion_defaults_off_and_ancestor_exclusion_wins() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("docs/a.md"), "alpha");
    write(&vault_dir.path().join("docs/b.md"), "beta");

    // opt_in default: nothing is included until toggled on.
    assert!(vault::active_included_file_ids().is_empty());

    // Including the folder includes the descendants.
    vault::set_included("docs", true);
    let mut ids = vault::active_included_file_ids();
    ids.sort();
    assert_eq!(ids, vec!["docs/a.md".to_string(), "docs/b.md".to_string()]);

    // An explicitly excluded ancestor forces every descendant out, even one
    // whose own flag is on.
    vault::set_included("docs/a.md", true);
    vault::set_included("docs", false);
    assert!(
        vault::active_included_file_ids().is_empty(),
        "ancestor exclusion wins"
    );
}

#[test]
fn move_preserves_inclusion_flags_under_new_prefix() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("src/keep.md"), "x");
    std::fs::create_dir_all(vault_dir.path().join("dst")).unwrap();
    vault::set_included("src/keep.md", true);

    let new_id = vault::move_node("src/keep.md", Some("dst")).unwrap();
    assert_eq!(new_id, "dst/keep.md");
    assert!(vault_dir.path().join("dst/keep.md").exists());
    assert!(!vault_dir.path().join("src/keep.md").exists());
    assert_eq!(
        vault::active_included_file_ids(),
        vec!["dst/keep.md".to_string()]
    );

    // Destination collisions are refused, not clobbered.
    write(&vault_dir.path().join("src/keep.md"), "again");
    let err = vault::move_node("src/keep.md", Some("dst")).expect_err("collision");
    assert_eq!(err.to_string(), "destination already exists");
}

#[test]
fn remove_moves_to_recoverable_trash_and_drops_flags() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("gone.md"), "bye");
    vault::set_included("gone.md", true);
    vault::remove_from_vault("gone.md").unwrap();

    assert!(!vault_dir.path().join("gone.md").exists());
    let trash_root = vault_dir.path().join(".rag-vault/trash");
    let day_dir = std::fs::read_dir(&trash_root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(
        day_dir.join("gone.md").exists(),
        "file lands in dated trash, not deleted"
    );
    assert!(vault::active_included_file_ids().is_empty());
}

#[test]
fn remove_of_linked_root_unlinks_and_leaves_real_files() {
    let vault_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&outside.path().join("mine.md"), "still mine");
    let (id, _) = vault::add_reference(outside.path().join("mine.md").to_str().unwrap()).unwrap();
    vault::remove_from_vault(&id).unwrap();

    assert!(
        outside.path().join("mine.md").exists(),
        "unlink never touches real files"
    );
    assert!(vault::list_nodes().iter().all(|n| n.id != id));
}

#[test]
fn remove_then_restore_brings_file_and_flags_back() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("keep.md"), "hello");
    vault::set_included("keep.md", true);
    let token = vault::remove_from_vault("keep.md").unwrap();
    assert!(!vault_dir.path().join("keep.md").exists(), "moved to trash");
    assert!(vault::active_included_file_ids().is_empty());

    let out = vault::restore_from_vault(&token).unwrap();
    assert_eq!(out["id"], "keep.md");
    assert!(
        vault_dir.path().join("keep.md").exists(),
        "restored from trash to its original location"
    );
    // Its AI-visibility flag came back with it.
    assert_eq!(
        vault::active_included_file_ids(),
        vec!["keep.md".to_string()]
    );
}

#[test]
fn rename_carries_flags_and_refuses_collisions() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("old.md"), "hi");
    vault::set_included("old.md", true);
    let new_id = vault::rename_node("old.md", "new.md").unwrap();
    assert_eq!(new_id, "new.md");
    assert!(!vault_dir.path().join("old.md").exists());
    assert!(vault_dir.path().join("new.md").exists());
    // The AI-visibility flag travels to the new id.
    assert_eq!(vault::active_included_file_ids(), vec!["new.md".to_string()]);

    // A rename onto an existing name is refused, not clobbered.
    write(&vault_dir.path().join("taken.md"), "other");
    let err = vault::rename_node("new.md", "taken.md").expect_err("collision");
    assert_eq!(err.to_string(), "destination already exists");
}

#[test]
fn create_folder_makes_an_empty_dir_and_rejects_bad_names() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    let id = vault::create_folder(None, "Reports").unwrap();
    assert_eq!(id, "Reports");
    assert!(vault_dir.path().join("Reports").is_dir());
    // Nested under a parent.
    let nested = vault::create_folder(Some("Reports"), "2026").unwrap();
    assert_eq!(nested, "Reports/2026");
    assert!(vault_dir.path().join("Reports/2026").is_dir());
    // Separators and dotfiles are refused.
    assert!(vault::create_folder(None, "a/b").is_err());
    assert!(vault::create_folder(None, ".hidden").is_err());
    // A name that already exists is refused.
    assert!(vault::create_folder(None, "Reports").is_err());
}

#[test]
fn restore_refuses_to_clobber_an_existing_file() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("dup.md"), "one");
    let token = vault::remove_from_vault("dup.md").unwrap();
    // Something new now occupies the original path — restore must not overwrite.
    write(&vault_dir.path().join("dup.md"), "two");
    let err = vault::restore_from_vault(&token).expect_err("must refuse to clobber");
    assert!(err.to_string().contains("already exists"));
}

#[test]
fn add_file_suffixes_collisions_and_rejects_dotfiles() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    let a = vault::add_file("note.md", b"one", None).unwrap();
    let b = vault::add_file("note.md", b"two", None).unwrap();
    assert_eq!(a, "note.md");
    assert_eq!(b, "note (1).md");
    assert!(vault::add_file(".hidden", b"x", None).is_err());
    // Only the basename is honored — a client can never write outside the vault.
    let c = vault::add_file("../escape.md", b"x", None).unwrap();
    assert_eq!(c, "escape.md");
}

#[test]
fn resolve_node_path_refuses_escapes() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    write(&vault_dir.path().join("ok.md"), "x");

    assert!(vault::resolve_node_path("ok.md").is_ok());
    let err = vault::resolve_node_path("../outside.md").expect_err("escape");
    assert_eq!(err.to_string(), "path escapes the vault");
}

#[test]
fn refresh_artifact_overwrites_in_place_and_guards_escape() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // First write creates Lighthouse Notes/Lighthouse Briefing.md.
    let (id1, name) =
        vault::refresh_artifact("Lighthouse Notes", "Lighthouse Briefing", "md", b"first").unwrap();
    assert_eq!(name, "Lighthouse Briefing.md");
    assert_eq!(id1, "Lighthouse Notes/Lighthouse Briefing.md");
    let path = vault_dir.path().join("Lighthouse Notes").join("Lighthouse Briefing.md");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

    // Second write REPLACES in place — same id, no " (1)" suffix, new content.
    let (id2, _) =
        vault::refresh_artifact("Lighthouse Notes", "Lighthouse Briefing", "md", b"second").unwrap();
    assert_eq!(id2, id1, "same id — overwritten, not suffixed");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    assert!(
        !vault_dir.path().join("Lighthouse Notes").join("Lighthouse Briefing (1).md").exists(),
        "must not accrete a suffixed sibling",
    );

    // A vault-escaping name hint is neutralized: path SEPARATORS become dashes,
    // so it stays inside the subdir and never traverses out of the vault.
    let (id3, _) = vault::refresh_artifact("Lighthouse Notes", "../../etc/passwd", "md", b"x").unwrap();
    assert!(id3.starts_with("Lighthouse Notes/"), "stays in the subdir: {id3}");
    assert!(!id3.contains('/') || id3.matches('/').count() == 1, "no traversal separators: {id3}");
    assert!(vault_dir.path().join(&id3).exists());
}
