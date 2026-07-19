//! Crash-guarded SAFE MODE for launches that take the machine down with them.
//!
//! Field report class: "started the app and the whole PC froze" on first run
//! (Windows 10). A userland app can't do that by itself — the usual culprits
//! are a GPU-driver hang triggered by the webview's hardware compositing on
//! old drivers, or RAM/disk thrash on a weak machine while an unsigned first
//! launch spawns webviews under full antivirus scanning. Both share one
//! standard escape hatch: software rendering and a minimal boot.
//!
//! Mechanism: a marker file flips "booting" → "ready" 20 s into a launch (or
//! at clean exit). A launch that dies inside that window leaves "booting"
//! behind; the NEXT launch sees it and comes up in safe mode — webview GPU
//! acceleration off, the widget webview created on demand instead of at
//! boot, no background index warm. Safe mode then STICKS for the current app
//! version (recorded in a side file) so the app doesn't flap between a
//! freezing normal boot and a working safe boot; the next update tries
//! normal rendering again.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static SAFE: AtomicBool = AtomicBool::new(false);

/// Whether this launch is running in safe mode (decided once in `begin`).
pub fn safe_mode() -> bool {
    SAFE.load(Ordering::Relaxed)
}

/// Tauri's app-data dir for our identifier, computed by hand because the
/// marker must be read before the app (and any webview) exists.
fn state_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join("com.lighthouse.app"))
}

fn boot_marker() -> Option<PathBuf> {
    state_dir().map(|d| d.join("boot-state"))
}

fn safe_lock() -> Option<PathBuf> {
    state_dir().map(|d| d.join("safe-mode"))
}

/// Call FIRST THING in main(), before the Tauri builder runs (webview
/// environment variables only count if set before any webview is created).
/// Returns whether this launch is in safe mode.
pub fn begin(version: &str) -> bool {
    let Some(marker) = boot_marker() else {
        return false;
    };
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }

    let crashed = std::fs::read_to_string(&marker)
        .map(|s| s.trim() == "booting")
        .unwrap_or(false);
    let sticky = safe_lock()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == version)
        .unwrap_or(false);

    if crashed {
        // Stick for this version so we don't flap between a freezing normal
        // boot and a working safe boot; an update retries normal rendering.
        if let Some(lock) = safe_lock() {
            let _ = std::fs::write(lock, version);
        }
    } else if !sticky {
        // Healthy history on this version — clear any stale lock from a
        // previous version so updates get a fresh chance.
        if let Some(lock) = safe_lock() {
            let _ = std::fs::remove_file(lock);
        }
    }

    let safe = crashed || sticky;
    let _ = std::fs::write(&marker, "booting");

    if safe {
        SAFE.store(true, Ordering::Relaxed);
        eprintln!(
            "previous launch never became ready — safe mode: software rendering, minimal boot"
        );
        // WebView2 (Windows): the documented escape hatch for GPU-driver
        // hangs. Append rather than clobber a user-supplied value.
        let extra = "--disable-gpu --disable-gpu-compositing";
        let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(prev) if !prev.trim().is_empty() => format!("{prev} {extra}"),
            _ => extra.to_string(),
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        // WebKitGTK (Linux): same idea, its own switch.
        #[cfg(target_os = "linux")]
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    safe
}

/// Mark this launch healthy — called ~20 s in (a machine-freezing launch
/// never gets there) and again on clean exit (quitting early is healthy too).
pub fn mark_ready() {
    if let Some(marker) = boot_marker() {
        let _ = std::fs::write(marker, "ready");
    }
}

/// Whether safe mode is version-sticky (the lock file pins it for this build,
/// so plain restarts never leave it — only an update or `clear_safe_mode`).
pub fn sticky() -> bool {
    safe_lock().map(|p| p.exists()).unwrap_or(false)
}

/// Leave safe mode: drop the sticky lock and mark the boot history healthy.
/// Takes effect on the NEXT launch (this process keeps its safe-mode webview
/// flags — they were applied before any window existed).
pub fn clear_safe_mode() {
    if let Some(lock) = safe_lock() {
        let _ = std::fs::remove_file(lock);
    }
    mark_ready();
}
