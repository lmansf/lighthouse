//! Identity pin (0.12.8): the app's bundle *identifier* is `app.lhvault`, but
//! the on-disk app-data path is deliberately PINNED to the historical
//! `com.lighthouse.app` so the rename moved no existing user's settings, sealed
//! API keys, or downloaded models (see `lib.rs::app_data_base`). These two
//! invariants are subtle and load-bearing — a well-meaning "unify the on-disk
//! paths too" edit would silently strand every existing install's data. This
//! test turns that into a red build instead of a field report.

/// The Tauri bundle identifier — the app's OS / App Store / updater identity —
/// is the unified `app.lhvault`.
#[test]
fn bundle_identifier_is_app_lhvault() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
    assert_eq!(
        conf["identifier"].as_str(),
        Some("app.lhvault"),
        "the Tauri bundle identifier must be app.lhvault (0.12.8 rename)"
    );
}

/// The on-disk data path stays pinned to `com.lighthouse.app` across the rename.
/// If any of these literals disappears, existing installs would read from an
/// empty `app.lhvault` directory and appear to have lost their data.
#[test]
fn app_data_path_stays_pinned_to_the_legacy_identifier() {
    let lib = include_str!("../src/lib.rs");
    assert!(
        lib.contains("fn app_data_base("),
        "the app_data_base pin helper is missing from lib.rs — the identifier \
         rename would relocate every install's settings/keys/models"
    );
    assert!(
        lib.contains("com.lighthouse.app"),
        "lib.rs must pin the app-data base to com.lighthouse.app; do NOT follow \
         the identifier rename without shipping a first-launch data migration"
    );

    // boot_guard's pre-Tauri state dir (read before any webview exists) must use
    // the same pinned literal, or safe-mode/boot markers desync from the data.
    let boot = include_str!("../src/desktop/boot_guard.rs");
    assert!(
        boot.contains("com.lighthouse.app"),
        "boot_guard.rs state_dir must stay pinned to com.lighthouse.app"
    );

    // The NSIS pre-install hook clears boot_guard's marker at the pinned path.
    let hooks = include_str!("../installer-hooks.nsh");
    assert!(
        hooks.contains("com.lighthouse.app"),
        "installer-hooks.nsh must clear boot-state under the pinned path"
    );

    // The keychain sealing-secret service name (inert unless built with
    // --features keychain) is likewise decoupled from the bundle identifier: a
    // rename would strand the sealing secret for keychain builds.
    let secrets = include_str!("../../lighthouse-core/src/secrets.rs");
    assert!(
        secrets.contains("KEYCHAIN_SERVICE") && secrets.contains("com.lighthouse.app"),
        "secrets.rs KEYCHAIN_SERVICE must stay com.lighthouse.app (decoupled from \
         the Tauri identifier)"
    );
}
