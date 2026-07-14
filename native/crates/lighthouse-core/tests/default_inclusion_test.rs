//! The user-facing default-inclusion choice: an explicit onboarding preference
//! ("include"/"exclude") overrides the fixed default, and the vault engine
//! honors it for newly-added files that carry no explicit flag.

mod common;

use lighthouse_core::{profile, vault};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn explicit_choice_overrides_the_default() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // Two files, never toggled — their effective inclusion is the default only.
    write(&vault_dir.path().join("a.md"), "alpha content here");
    write(&vault_dir.path().join("b.md"), "beta content here");

    // Baseline: the fixed default is exclude → nothing included.
    assert_eq!(profile::effective_default_inclusion(), "exclude");
    assert!(vault::active_included_file_ids().is_empty());

    // The user picks "include everything by default" during onboarding.
    profile::set_default_inclusion("include");
    vault::invalidate_walk_cache();
    assert_eq!(profile::effective_default_inclusion(), "include");
    let mut ids = vault::active_included_file_ids();
    ids.sort();
    assert_eq!(ids, vec!["a.md".to_string(), "b.md".to_string()], "include-by-default makes untouched files searchable");
    // The choice is surfaced in the onboarding state for the UI.
    assert_eq!(profile::get_state().default_inclusion, "include");

    // Switching back to exclude-by-default drops them again.
    profile::set_default_inclusion("exclude");
    vault::invalidate_walk_cache();
    assert!(vault::active_included_file_ids().is_empty(), "exclude-by-default hides untouched files");

    // An explicit per-file include still wins over exclude-by-default.
    vault::set_included("a.md", true);
    assert_eq!(vault::active_included_file_ids(), vec!["a.md".to_string()]);
}

#[test]
fn falls_back_to_the_fixed_default_when_no_explicit_choice() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    // No set_default_inclusion call → the fixed privacy-preserving default
    // (exclude) applies (experiments were removed).
    assert_eq!(profile::effective_default_inclusion(), "exclude");
    assert_eq!(profile::get_state().default_inclusion, "exclude");
}
