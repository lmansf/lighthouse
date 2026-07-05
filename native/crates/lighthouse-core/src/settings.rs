//! Desktop app settings shared with the shell (port of `src/server/settings.ts`).
//! The shell owns the file and passes its path via LIGHTHOUSE_SETTINGS_FILE; on
//! the plain web build there is no settings file, so reads return empty and
//! writes are no-ops.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::write_json;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_dir: Option<String>,
    /// Launch Lighthouse when the user signs in to their computer. Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_on_startup: Option<bool>,
    /// Whether the one-time "run on startup?" prompt has been answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_asked: Option<bool>,
    /// How the app presents itself at launch: "window" (classic, the default)
    /// or "widget" (experimental — the floating search bar IS the app; the
    /// main window stays in the tray). None = the first-run chooser hasn't
    /// been answered yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_mode: Option<String>,
}

fn settings_file() -> Option<PathBuf> {
    std::env::var("LIGHTHOUSE_SETTINGS_FILE")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn read_desktop_settings() -> DesktopSettings {
    let Some(f) = settings_file() else {
        return DesktopSettings::default();
    };
    fs::read_to_string(&f)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Merge `patch` into the on-disk settings, preserving keys the shell owns.
pub fn write_desktop_settings(
    run_on_startup: Option<bool>,
    startup_asked: Option<bool>,
    ui_mode: Option<String>,
) -> DesktopSettings {
    let Some(f) = settings_file() else {
        return DesktopSettings::default();
    };
    let mut next = read_desktop_settings();
    if run_on_startup.is_some() {
        next.run_on_startup = run_on_startup;
    }
    if startup_asked.is_some() {
        next.startup_asked = startup_asked;
    }
    // Only the two known modes are storable — anything else is a client bug.
    if matches!(ui_mode.as_deref(), Some("window") | Some("widget")) {
        next.ui_mode = ui_mode;
    }
    write_json(&f, &next); // best-effort: a read-only location just means unsaved
    next
}
