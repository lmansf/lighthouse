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

/// The Beam multi-step analytics loop's default step budget (openspec:
/// add-beam-loop §2) — the number of sequential verified SQL steps the loop may
/// run when `beam_max_steps` is unset. Replaces the former hardcoded 3.
pub const DEFAULT_BEAM_MAX_STEPS: usize = 5;

/// Hard ceiling on the configurable Beam step budget. Keeps the accumulated
/// per-step context (STEP_RESULT_CAP × N) a small fraction of any remote model
/// window even at the maximum; a persisted value above this clamps down.
pub const BEAM_MAX_STEPS_CEILING: usize = 12;

/// Resizable explorer width bounds (openspec: add-usability-field-patch §1). The
/// explorer/sidebar width persists per window mode; a value is clamped to these
/// bounds at BOTH write and read, so a hand-edited or stale settings file can
/// never render an unusable rail. PARITY: mirrored in src/server/settings.ts.
pub const EXPLORER_WIDTH_MIN: f64 = 200.0;
pub const EXPLORER_WIDTH_MAX: f64 = 720.0;

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
    /// G2 draft-then-verify: while the local model composes a grounded answer,
    /// stream an instant extractive draft from retrieval snippets, replaced in
    /// place by the verified answer. Default ON (None = on); off suppresses the
    /// draft and the answer streams as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_answers: Option<bool>,
    /// G5 briefing note: fire an OS notification when the scheduled note is
    /// refreshed. Default ON (None = on); the note is always written silently
    /// regardless. Suppressed while the app is hidden/conserving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub briefing_notify: Option<bool>,
    /// G5 briefing note: the local hour (0–23) at or after which the scheduled
    /// note may refresh, at most once per day. None = the default (9am).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub briefing_note_hour: Option<i64>,
    /// Whether the once-per-install first-run orientation tour has been shown.
    /// Written true the moment the tour first appears (so completing AND
    /// skipping both mark it done); only a wiped app-state dir re-shows it.
    /// Lives here (install-global settings) rather than the vault or
    /// localStorage so it survives vault switches. Default false (None = false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tour_shown: Option<bool>,
    /// Provider sign-in (0.12.1 §3): how the OpenAI provider authenticates —
    /// "key" (API key, the default; None = "key") or "signin" (the OAuth
    /// device flow in provider_auth.rs). Only meaningful when a maintainer
    /// has configured the sign-in identifiers; with the flow unconfigured a
    /// persisted "signin" makes asks fail with the honest reason rather than
    /// silently using a key (fail-closed — the user chose sign-in). Written
    /// by `set_openai_auth_method`, never by the positional writer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_auth_method: Option<String>,
    /// Beam loop (openspec: add-beam-loop §2.7): the multi-step analytics loop's
    /// step budget — how many sequential verified SQL steps a keyed-remote ask
    /// may run (replaces the former hardcoded 3). None = the default
    /// (`DEFAULT_BEAM_MAX_STEPS`). Read via `beam_max_steps_effective`, which
    /// clamps to `[1, BEAM_MAX_STEPS_CEILING]`. PARITY: mirrored as
    /// `beamMaxSteps` in src/server/settings.ts — the twin round-trips the pref
    /// for the UI, but the loop itself is Rust-only analytics, so the twin never
    /// runs it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beam_max_steps: Option<i64>,
    /// Keys this struct doesn't model (e.g. the shell's hand-persisted
    /// `widgetPos`) must survive a read-modify-write round trip — without
    /// this flatten, any Preferences toggle would silently delete them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl DesktopSettings {
    /// The effective Beam loop step budget (openspec: add-beam-loop §2.1): the
    /// configured `beam_max_steps` clamped to `[1, BEAM_MAX_STEPS_CEILING]`, or
    /// `DEFAULT_BEAM_MAX_STEPS` when unset or out of range. The loop reads this
    /// in place of the former hardcoded 3.
    pub fn beam_max_steps_effective(&self) -> usize {
        match self.beam_max_steps {
            Some(n) if n >= 1 => (n as usize).min(BEAM_MAX_STEPS_CEILING),
            _ => DEFAULT_BEAM_MAX_STEPS,
        }
    }

    /// The persisted resizable-explorer width for `mode` ("window"/"widget"),
    /// clamped to `[EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX]` (openspec:
    /// add-usability-field-patch §1). The value rides the `extra` map under
    /// `explorerWidth`, keyed by mode (the `widgetPos` precedent), so the struct
    /// stays additive. `None` when unset or unparseable — the UI then falls back
    /// to its layout default. PARITY: src/server/settings.ts::explorerWidth.
    pub fn explorer_width(&self, mode: &str) -> Option<f64> {
        self.extra
            .get("explorerWidth")
            .and_then(|v| v.get(mode))
            .and_then(|v| v.as_f64())
            .filter(|w| w.is_finite())
            .map(|w| w.clamp(EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX))
    }

    /// The persisted, validated appearance customization (openspec:
    /// add-usability-field-patch §3) — the curated accent, density, font scale,
    /// and theme preset. Only whitelisted keys carrying an in-vocabulary value
    /// survive; a free-form color or CSS could never be stored. Rides the
    /// `extra` map under `appearance` (the widgetPos precedent). PARITY:
    /// src/lib/appearanceSpec.ts::normalizeAppearance + settings.ts::appearance.
    pub fn appearance(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut out = serde_json::Map::new();
        if let Some(obj) = self.extra.get("appearance").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    if valid_appearance_value(k, s) {
                        out.insert(k.clone(), serde_json::Value::from(s));
                    }
                }
            }
        }
        out
    }
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
    draft_answers: Option<bool>,
    briefing_notify: Option<bool>,
    briefing_note_hour: Option<i64>,
    tour_shown: Option<bool>,
    beam_max_steps: Option<i64>,
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
    if draft_answers.is_some() {
        next.draft_answers = draft_answers;
    }
    if briefing_notify.is_some() {
        next.briefing_notify = briefing_notify;
    }
    // Store only a valid hour; a nonsense value falls back to the default at read.
    if let Some(h) = briefing_note_hour {
        if (0..=23).contains(&h) {
            next.briefing_note_hour = Some(h);
        }
    }
    if tour_shown.is_some() {
        next.tour_shown = tour_shown;
    }
    // Store only a sane positive budget (add-beam-loop §2.7); a value outside
    // [1, BEAM_MAX_STEPS_CEILING] is ignored so the default/clamp stands at read.
    if let Some(n) = beam_max_steps {
        if (1..=BEAM_MAX_STEPS_CEILING as i64).contains(&n) {
            next.beam_max_steps = Some(n);
        }
    }
    write_json(&f, &next); // best-effort: a read-only location just means unsaved
    next
}

/// Provider sign-in (0.12.1 §3): persist the OpenAI auth-method choice
/// ("key" | "signin") without disturbing any other key — a narrow
/// read-modify-write beside the positional writer, so the shell's call
/// sites don't grow a parameter for a field only the sign-in control
/// touches. Any other value is ignored (the two methods are the whole
/// domain); a garbled caller leaves the settings unchanged.
pub fn set_openai_auth_method(method: &str) -> DesktopSettings {
    let Some(f) = settings_file() else {
        return DesktopSettings::default();
    };
    let mut next = read_desktop_settings();
    if method == "key" || method == "signin" {
        next.openai_auth_method = Some(method.to_string());
        write_json(&f, &next); // best-effort, like the writer above
    }
    next
}

/// Persist the resizable explorer's width for one window mode (openspec:
/// add-usability-field-patch §1) without disturbing any other key — a narrow
/// read-modify-write beside the positional writer, the `set_openai_auth_method`
/// precedent. The width rides the `extra` map under `explorerWidth` keyed by
/// mode ("window"/"widget"), clamped to `[EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX]`
/// at write (and again at read, in `explorer_width`). An unknown mode or a
/// non-finite width is ignored, leaving the file untouched. PARITY:
/// src/server/settings.ts::setExplorerWidth.
pub fn set_explorer_width(mode: &str, width: f64) -> DesktopSettings {
    let Some(f) = settings_file() else {
        return DesktopSettings::default();
    };
    let mut next = read_desktop_settings();
    if matches!(mode, "window" | "widget") && width.is_finite() {
        let w = width.clamp(EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX);
        let entry = next
            .extra
            .entry("explorerWidth".to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !entry.is_object() {
            *entry = serde_json::Value::Object(serde_json::Map::new());
        }
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(mode.to_string(), serde_json::Value::from(w));
        }
        write_json(&f, &next);
    }
    next
}

/// Whether `val` is an in-vocabulary value for appearance key `key` (openspec:
/// add-usability-field-patch §3). The whole enum surface — no free-form color,
/// no CSS. PARITY: the isThemePreset/isAccent/isDensity/isFontScale guards in
/// src/lib/appearanceSpec.ts; keep the value sets byte-identical.
fn valid_appearance_value(key: &str, val: &str) -> bool {
    match key {
        "themePreset" => matches!(val, "beam-light" | "beam-dark" | "auto"),
        "accent" => matches!(val, "amber" | "teal" | "orchid"),
        "density" => matches!(val, "comfortable" | "compact"),
        "fontScale" => matches!(val, "s" | "m" | "l"),
        _ => false,
    }
}

/// Merge a validated appearance patch into the settings file (openspec §3) —
/// only whitelisted keys with an in-vocabulary value are written, so a
/// free-form color or CSS can never be stored. Merges over any existing
/// appearance so a single-key change (the directive setting only `accent`)
/// keeps the rest. Ignores non-object input, leaving the file untouched.
/// PARITY: src/server/settings.ts::setAppearance.
pub fn set_appearance(patch: &serde_json::Value) -> DesktopSettings {
    let Some(f) = settings_file() else {
        return DesktopSettings::default();
    };
    let mut next = read_desktop_settings();
    let entry = next
        .extra
        .entry("appearance".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !entry.is_object() {
        *entry = serde_json::Value::Object(serde_json::Map::new());
    }
    let mut changed = false;
    if let (Some(obj), Some(patch_obj)) = (entry.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            if let Some(s) = v.as_str() {
                if valid_appearance_value(k, s) {
                    obj.insert(k.clone(), serde_json::Value::from(s));
                    changed = true;
                }
            }
        }
    }
    if changed {
        write_json(&f, &next);
    }
    next
}
