//! §41 backup-exclusion pin: on iOS the sealing secret and the store it seals
//! must be OUT of the device backup.
//!
//! `lighthouse-core/src/secrets.rs` seals provider API keys — and, via
//! `provider_auth.rs`, the OAuth access/refresh tokens — with AES-256-GCM under
//! a per-install secret which, with the `keychain` feature off (the shipping
//! default), lives as `secret.key` right beside the `secrets.json` it seals:
//! both under `app_state_dir()`, which on iOS is the app's Application Support
//! container. Application Support is INSIDE the iCloud/Finder device backup, so
//! one backup carries the ciphertext AND its key — every stored key and token
//! recoverable in cleartext with no device access and no malware. That is
//! squarely inside the threat model `secrets.rs` documents ("casual disk/
//! backup/cloud-sync inspection"), and the control was specified:
//! `openspec/changes/add-mobile-apps/tasks.md` §3.2 — "`isExcludedFromBackup`
//! on vault/state/`secret.key`" — but only ever implemented for the regenerable
//! extraction cache (`state_home::mark_cache_no_backup`).
//!
//! The attribute itself can only be observed on a device, so this file pins the
//! two halves that CAN be checked here:
//!   1. the target SELECTION is a pure, platform-neutral fn — the house pattern
//!      (decide in a testable fn, side-effect in a thin cfg'd arm) — so "which
//!      paths get excluded" is a real unit test on every platform;
//!   2. the two call sites that cannot run here (`lighthouse-desktop` does not
//!      compile in the dev container, and the fresh-key ordering is an iOS
//!      runtime property) are pinned at the source level, each asserting the
//!      SAFE PROPERTY rather than the mere presence of code.

use std::path::Path;

/// The exclusion target set must cover the sealing secret and the sealed store,
/// not only the regenerable cache.
#[test]
fn no_backup_targets_cover_the_sealing_secret_and_the_sealed_store() {
    let root = std::env::temp_dir().join(format!("lh-nobackup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // Faithful to the shell's iOS layout: LIGHTHOUSE_APP_STATE_DIR is the app
    // data dir, and the engine state home is `.rag-vault` inside it.
    let app_state = root.join("Application Support/com.lighthouse.app");
    let state_home = app_state.join(".rag-vault");
    std::fs::create_dir_all(&state_home).unwrap();

    let targets = lighthouse_shell::state_home::no_backup_targets(&state_home, &app_state);
    let covered = |p: &Path| targets.iter().any(|t| t == p);

    assert!(
        covered(&app_state.join("secret.key")),
        "the sealing secret is not excluded from device backup — an iCloud/Finder \
         backup carries it next to the secrets.json it decrypts (targets: {targets:?})"
    );
    assert!(
        covered(&app_state.join("secrets.json")),
        "the sealed API-key / OAuth-token store is not excluded from device \
         backup (targets: {targets:?})"
    );
    // No regression on §41's original guarantee.
    assert!(
        covered(&state_home.join("cache")),
        "the regenerable extraction cache must stay excluded (§41)"
    );
    // Fail closed on aim: a target outside the two roots we were handed would
    // point the marker at the user's vault or at $HOME.
    for t in &targets {
        assert!(
            t.starts_with(&app_state) || t.starts_with(&state_home),
            "exclusion target escapes the app container: {}",
            t.display()
        );
    }
    // The side-effecting half is a no-op off iOS, but the shell calls it
    // unconditionally: it must be callable and non-panicking on every platform.
    lighthouse_shell::state_home::mark_no_backup(&targets);

    let _ = std::fs::remove_dir_all(&root);
}

/// The iOS bootstrap call site. `lighthouse-desktop` does not compile in the dev
/// container (no webkit/gtk), so this is a source pin — asserting the SAFE
/// PROPERTY: the backup-exclusion call in `bootstrap_env` is fed the app-state
/// dir it has just published as `LIGHTHOUSE_APP_STATE_DIR` (where `secret.key`
/// and `secrets.json` live), not only the engine state home.
#[test]
fn ios_bootstrap_excludes_the_secret_bearing_app_state_dir() {
    const LIB: &str = include_str!("../../lighthouse-desktop/src/lib.rs");
    let start = LIB
        .find("#[cfg(all(not(desktop), target_os = \"ios\"))]")
        .expect("the iOS state-home bootstrap block moved — re-point this pin");
    let rest = &LIB[start..];
    // Stop at the block's own closing brace; fall back to a fixed window if the
    // indentation ever changes, so the pin degrades to "too much" not "nothing".
    let end = rest
        .find("\n        }\n")
        .map(|i| i + "\n        }\n".len())
        .unwrap_or_else(|| rest.len().min(900));
    let block = &rest[..end];

    // Ordering (the designer's risk 3, and what the fresh-key guarantee rests
    // on): the exclusion must run INSIDE `bootstrap_env`, before any engine call
    // — the resources-path set_var is bootstrap_env's tail, so `start` between
    // the two brackets the block where nothing has yet opened state.
    let boot = LIB
        .find("fn bootstrap_env(")
        .expect("bootstrap_env moved — re-point this pin");
    let tail = LIB
        .find("std::env::set_var(\"LIGHTHOUSE_RESOURCES_PATH\"")
        .expect("bootstrap_env's tail moved — re-point this pin");
    assert!(
        boot < start && start < tail,
        "the backup exclusion must run inside bootstrap_env, before any engine \
         call — moved later, a freshly generated secret.key reaches the first \
         backup unmarked"
    );

    assert!(
        !block.contains("mark_cache_no_backup"),
        "the iOS bootstrap marks ONLY the regenerable extraction cache, so the \
         sealing secret and the sealed store stay inside the device backup"
    );
    assert!(
        block.contains("mark_no_backup"),
        "the iOS bootstrap must apply the generalized backup exclusion"
    );
    assert!(
        block.contains("no_backup_targets(") && block.contains("&data"),
        "the exclusion targets must be computed from the app-state dir (`data` — \
         where secret.key and secrets.json live), not only from the state home"
    );
}

/// Fresh-install ordering. `setResourceValue:forKey:error:` fails on a path that
/// does not exist, so a boot-time FILE-level mark cannot cover a `secret.key`
/// that `machine_secret()` only creates later, on first use — the fresh key
/// would ride into the very first backup. Two shapes close that window and this
/// pin accepts either:
///   A. the creation site marks the file it has just written, or
///   B. the app-state DIRECTORY is itself a target — iOS propagates the
///      exclusion to a directory's contents, including files created after the
///      attribute was set.
#[test]
fn a_freshly_generated_sealing_secret_is_never_backed_up_even_once() {
    const SECRETS: &str = include_str!("../../lighthouse-core/src/secrets.rs");
    let at = SECRETS
        .find("fn machine_secret()")
        .expect("machine_secret moved — re-point this pin");
    let body = &SECRETS[at..];
    let body = &body[..body.find("\nfn ").unwrap_or(body.len())];
    let write = body
        .find("write_json(&f, &s)")
        .expect("the fresh-key write moved — re-point this pin");
    let tail = &body[write..];
    let shape_a = tail.contains("no_backup") || tail.contains("ExcludedFromBackup");

    let app_state = std::env::temp_dir().join(format!("lh-freshkey-{}", std::process::id()));
    let state_home = app_state.join(".rag-vault");
    let targets = lighthouse_shell::state_home::no_backup_targets(&state_home, &app_state);
    let shape_b = targets.iter().any(|t| t == &app_state);

    assert!(
        shape_a || shape_b,
        "a freshly generated sealing secret can still reach a backup: \
         machine_secret() writes secret.key without marking it, and the \
         app-state dir is not itself an exclusion target (targets: {targets:?})"
    );
}
