//! Desktop app settings shared with the shell (port of `src/server/settings.ts`).
//! The shell owns the file and passes its path via LIGHTHOUSE_SETTINGS_FILE; on
//! the plain web build there is no settings file, so reads return empty and
//! writes are no-ops.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::write_json;

/// The out-of-the-box keyed summon chord (Wispr-adjacent, but with a real
/// key — no standard hotkey API can register a modifier-only chord).
pub const DEFAULT_SUMMON_SHORTCUT: &str = "ctrl+super+shift+space";

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
    /// W3 "Whisper mode": summon the search bar by tapping Ctrl+Super+Shift
    /// with no other key. Opt-in (it installs an OS keyboard hook where
    /// supported); default off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whisper_mode: Option<bool>,
    /// The keyed summon shortcut (global-hotkey syntax, e.g.
    /// "ctrl+super+shift+space" or "ctrl+alt+KeyP"). None = the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summon_shortcut: Option<String>,
    /// B2 hybrid search: embed indexed chunks with the bundled on-device model
    /// and fuse vector similarity into retrieval. Default ON (None = on);
    /// turning it off also stops the embedding server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_search: Option<bool>,
    /// Background-conserve: while the app sits in the tray or unfocused (window
    /// mode), stop the local llama-server processes to free their RAM+CPU, and
    /// bring them back on return. Default ON (None = on); off keeps the servers
    /// resident, as they were before this setting existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_conserve: Option<bool>,
    /// OCR: read printed text in image files and scanned PDFs with the bundled
    /// on-device models (add-ocr-perception). Default ON (None = on); off makes
    /// image/scan extraction return empty — and, deliberately, uncached — so
    /// flipping it back on re-reads them with no rescan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_enabled: Option<bool>,
    /// Local audit log (add-audit-log): keep a tamper-evident record of each
    /// answered question. Default OFF (None = off); the managed policy key
    /// `auditLog: "on"` forces it on regardless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_enabled: Option<bool>,
    /// Keys this struct doesn't model (e.g. the shell's hand-persisted
    /// `widgetPos`) must survive a read-modify-write round trip — without
    /// this flatten, any Preferences toggle would silently delete them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
#[allow(clippy::too_many_arguments)]
pub fn write_desktop_settings(
    run_on_startup: Option<bool>,
    startup_asked: Option<bool>,
    ui_mode: Option<String>,
    whisper_mode: Option<bool>,
    summon_shortcut: Option<String>,
    semantic_search: Option<bool>,
    background_conserve: Option<bool>,
    ocr_enabled: Option<bool>,
    audit_enabled: Option<bool>,
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
    if whisper_mode.is_some() {
        next.whisper_mode = whisper_mode;
    }
    // Syntax is validated by the desktop shell before it saves (it parses the
    // shortcut and refuses unregistrable strings); empty resets to default.
    if summon_shortcut.is_some() {
        next.summon_shortcut = summon_shortcut.filter(|s| !s.trim().is_empty());
    }
    if semantic_search.is_some() {
        next.semantic_search = semantic_search;
    }
    if background_conserve.is_some() {
        next.background_conserve = background_conserve;
    }
    if ocr_enabled.is_some() {
        next.ocr_enabled = ocr_enabled;
    }
    if audit_enabled.is_some() {
        next.audit_enabled = audit_enabled;
    }
    write_json(&f, &next); // best-effort: a read-only location just means unsaved
    next
}
