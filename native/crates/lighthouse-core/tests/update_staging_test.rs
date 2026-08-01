//! §56 #2 — the update manifest never chooses a filesystem path.
//!
//! `update_now` stages the picked release asset on disk and only THEN checks
//! its minisign signature, so the staging path is decided from a remote,
//! unauthenticated document while nothing has been verified yet: an absolute
//! name or a `..` component turns the download into an arbitrary-file
//! create+truncate (and delete, on the failure arms) — a signature-gate bypass
//! that needs no signing key. `pick_update_asset` is no defence: it constrains
//! only the asset's SUFFIX.
//!
//! The shell half can't compile in the dev container (no webkit/gtk), so the
//! derivation lives here in the tauri-free engine, where these run for real.
//! `test/updateStagingPath.test.mjs` pins that `update_now` actually calls it,
//! by reading the Rust as text.

use lighthouse_core::updates::{pick_update_asset, staging_path, UpdatePlatform};

#[test]
fn a_traversing_asset_name_writes_outside_the_staging_dir_and_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("updates");
    std::fs::create_dir_all(&dir).unwrap();

    // The picker accepts it: only the suffix is checked, never the shape.
    let hostile = "../pwned.exe";
    assert_eq!(
        pick_update_asset(UpdatePlatform::Windows, &[hostile.to_string()])
            .expect("pick_update_asset constrains only the suffix")
            .name,
        hostile,
    );

    // The pre-fix derivation, reproduced: `dir.join(name)` + File::create puts
    // a byte OUTSIDE the staging dir, before any signature has been checked.
    let escaped = dir.join(hostile);
    std::fs::File::create(&escaped).expect("the bare join is a live write primitive");
    assert!(
        tmp.path().join("pwned.exe").is_file(),
        "the bare join wrote outside the staging dir",
    );
    // A `starts_with` check alone would have waved it through — path comparison
    // is LEXICAL, so `<dir>/../pwned.exe` does start with `<dir>`. The
    // single-Component::Normal rule is what actually stops this.
    assert!(escaped.starts_with(&dir), "starts_with alone is fooled by `..`");

    // THE INVARIANT: the derivation refuses the name, so nothing is created.
    assert_eq!(staging_path(&dir, hostile), None, "`..` must be refused");
}

#[test]
fn an_absolute_asset_name_discards_the_staging_dir_and_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("updates");
    std::fs::create_dir_all(&dir).unwrap();

    // Pointed inside the tempdir here; a real manifest would name a login item
    // or a cron drop-in. The picker accepts this shape too.
    let target = tmp.path().join("owned.AppImage");
    let hostile = target.to_str().unwrap();
    assert!(pick_update_asset(UpdatePlatform::Linux, &[hostile.to_string()]).is_some());

    // `join` with an absolute path DISCARDS the base entirely.
    assert_eq!(dir.join(hostile), target, "an absolute name replaces the staging dir");
    assert!(!dir.join(hostile).starts_with(&dir));

    assert_eq!(staging_path(&dir, hostile), None, "an absolute name must be refused");
}

#[test]
fn only_a_plain_filename_stages_and_every_other_shape_is_refused() {
    // Pure path math — no I/O, so the verdict is pinned identically on any host.
    let dir = std::path::Path::new("/var/lighthouse/updates");

    for hostile in [
        "",                                  // no name at all
        ".",                                 // CurDir
        "..",                                // ParentDir
        "/etc/cron.d/lighthouse.exe",        // absolute (RootDir)
        "../../../../etc/cron.d/x.AppImage", // traversal
        "sub/dir/Lighthouse-Setup.exe",      // nested — more than one component
        "..\\..\\Startup\\x.exe",            // Windows traversal (ONE component on Unix)
        "C:\\Windows\\System32\\x.exe",      // Windows absolute (Prefix)
        "\\\\server\\share\\x.exe",          // UNC
        "Lighthouse\0.exe",                  // NUL
    ] {
        assert_eq!(staging_path(dir, hostile), None, "must refuse {hostile:?}");
    }

    // Real release-asset names still stage — as DIRECT children of the staging
    // dir with the extension intact (it drives the OS hand-off: NSIS installer,
    // dmg open, chmod+exec).
    for name in [
        "Lighthouse-Setup.exe",
        "Lighthouse.app.tar.gz",
        "Lighthouse_0.14.20_x64.dmg",
        "Lighthouse_0.14.20_amd64.AppImage",
        "Lighthouse 0.14.20 (arm64).dmg", // spaces and parens are just characters
    ] {
        let dest = staging_path(dir, name).unwrap_or_else(|| panic!("must stage {name}"));
        assert_eq!(dest, dir.join(name));
        assert_eq!(dest.parent(), Some(dir), "staged as a direct child");
        assert!(dest.starts_with(dir));
        assert!(dest.to_str().unwrap().ends_with(name), "extension intact");
    }
}
