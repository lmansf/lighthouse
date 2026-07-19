//! Pins the bundle-config wiring that keeps Windows upgrades installable.
//!
//! The NSIS pre-install/pre-uninstall hooks taskkill the bundled helper
//! processes (llama-server.exe); without them a running or
//! orphaned helper keeps DLLs under the install dir loaded and extraction
//! fails with "Error opening file for writing: …\llm\ggml-base.dll"
//! (0.6.x field reports). These tests fail if the hook file, its config
//! reference, or its process coverage ever drift apart.

#[test]
fn nsis_installer_hooks_are_wired() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
    let hooks = conf["bundle"]["windows"]["nsis"]["installerHooks"]
        .as_str()
        .expect("bundle.windows.nsis.installerHooks must be set");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(hooks);
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("hook file {} must exist: {e}", path.display()));

    // Both install and uninstall replace/remove files the helpers hold open.
    for name in ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"] {
        assert!(src.contains(&format!("!macro {name}")), "{name} macro missing from {hooks}");
    }
    // Every bundled helper that loads DLLs from the install dir must be
    // stopped before files are touched. Grows with any new sidecar process.
    for exe in ["llama-server.exe"] {
        assert!(src.contains(exe), "{exe} is not covered by the installer hooks");
    }
    // Update kills must not flag the next boot as crashed (sticky safe mode):
    // the pre-install hook clears boot_guard's in-flight marker.
    assert!(
        src.contains("boot-state"),
        "the PREINSTALL hook must clear boot_guard's boot-state marker"
    );
}

/// The hook kills processes by image name, so the names it uses must stay
/// the names the app actually spawns (supervise.rs).
#[test]
fn hook_process_names_match_the_supervisor() {
    let hooks = include_str!("../installer-hooks.nsh");
    let supervise = include_str!("../src/desktop/supervise.rs");
    assert!(
        supervise.contains("llama-server.exe") && hooks.contains("llama-server.exe"),
        "chat/embed server binary name drifted between supervise.rs and the hooks"
    );
}
