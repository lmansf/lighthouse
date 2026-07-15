//! Exhaustive desktop-settings round-trip — the PR #141 regression class (a
//! settings field silently dropped, mis-renamed on the wire, or a writer call
//! site missed) must fail CI, not surface as a field report.
//!
//! Two compile-time tripwires:
//!   1. `every_settings_field_round_trips` destructures `DesktopSettings` with
//!      NO `..` — adding a struct field refuses to compile until this test
//!      covers it (and the wire-key list below is extended).
//!   2. `write_desktop_settings` takes positional `Option` params — adding one
//!      breaks the call in `writer_persists_every_toggle...` (and every shell
//!      call site) at compile time, which is exactly how #141 should have died
//!      in CI instead of in the desktop-release build.

mod common;

use lighthouse_core::settings::{
    read_desktop_settings, write_desktop_settings, DesktopSettings,
};

#[test]
fn every_settings_field_round_trips() {
    let mut extra = serde_json::Map::new();
    // A shell-owned key the struct doesn't model (see the flatten field).
    extra.insert("widgetPos".into(), serde_json::json!([12, 34]));
    let full = DesktopSettings {
        vault_dir: Some("/somewhere/vault".into()),
        run_on_startup: Some(false),
        startup_asked: Some(true),
        ui_mode: Some("widget".into()),
        whisper_mode: Some(true),
        summon_shortcut: Some("ctrl+alt+KeyP".into()),
        semantic_search: Some(false),
        background_conserve: Some(false),
        ocr_enabled: Some(false),
        audit_enabled: Some(true),
        draft_answers: Some(false),
        briefing_notify: Some(false),
        briefing_note_hour: Some(7),
        tour_shown: Some(true),
        extra,
    };

    let json = serde_json::to_string(&full).expect("serialize");
    let back: DesktopSettings = serde_json::from_str(&json).expect("deserialize");

    // NO `..` here — this is the exhaustiveness tripwire (see module docs).
    let DesktopSettings {
        vault_dir,
        run_on_startup,
        startup_asked,
        ui_mode,
        whisper_mode,
        summon_shortcut,
        semantic_search,
        background_conserve,
        ocr_enabled,
        audit_enabled,
        draft_answers,
        briefing_notify,
        briefing_note_hour,
        tour_shown,
        extra,
    } = back;

    assert_eq!(vault_dir.as_deref(), Some("/somewhere/vault"));
    assert_eq!(run_on_startup, Some(false));
    assert_eq!(startup_asked, Some(true));
    assert_eq!(ui_mode.as_deref(), Some("widget"));
    assert_eq!(whisper_mode, Some(true));
    assert_eq!(summon_shortcut.as_deref(), Some("ctrl+alt+KeyP"));
    assert_eq!(semantic_search, Some(false));
    assert_eq!(background_conserve, Some(false));
    assert_eq!(ocr_enabled, Some(false));
    assert_eq!(audit_enabled, Some(true));
    assert_eq!(draft_answers, Some(false));
    assert_eq!(briefing_notify, Some(false));
    assert_eq!(briefing_note_hour, Some(7));
    assert_eq!(tour_shown, Some(true));
    assert_eq!(extra.get("widgetPos"), Some(&serde_json::json!([12, 34])));

    // Wire keys are camelCase (serde rename drift check — the TS twin and the
    // shell's raw-merge writer both address the file by these exact keys).
    for key in [
        "vaultDir",
        "runOnStartup",
        "startupAsked",
        "uiMode",
        "whisperMode",
        "summonShortcut",
        "semanticSearch",
        "backgroundConserve",
        "ocrEnabled",
        "auditEnabled",
        "draftAnswers",
        "briefingNotify",
        "briefingNoteHour",
        "tourShown",
        "widgetPos",
    ] {
        assert!(
            json.contains(&format!("\"{key}\"")),
            "wire key {key} missing from serialized settings: {json}"
        );
    }
}

#[test]
fn writer_persists_every_toggle_and_preserves_shell_keys() {
    let vault = tempfile::tempdir().expect("tempdir");
    let _guard = common::lock_env(vault.path());
    let file = vault.path().join("settings-under-test.json");
    // Pre-seed the two things the typed writer must never clobber: the
    // shell-owned vaultDir and an unmodeled key (widgetPos → `extra`).
    std::fs::write(
        &file,
        r#"{"vaultDir":"/somewhere/vault","widgetPos":[7,9]}"#,
    )
    .expect("seed settings file");
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &file);

    // Every writer param non-default. Positional on purpose — see module docs.
    write_desktop_settings(
        Some(false),                    // run_on_startup
        Some(true),                     // startup_asked
        Some("widget".into()),          // ui_mode
        Some(true),                     // whisper_mode
        Some("ctrl+alt+KeyP".into()),   // summon_shortcut
        Some(false),                    // semantic_search
        Some(false),                    // background_conserve
        Some(false),                    // ocr_enabled
        Some(true),                     // audit_enabled
        Some(false),                    // draft_answers
        Some(false),                    // briefing_notify
        Some(7),                        // briefing_note_hour
        Some(true),                     // tour_shown
    );
    let s = read_desktop_settings();
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");

    assert_eq!(s.run_on_startup, Some(false));
    assert_eq!(s.startup_asked, Some(true));
    assert_eq!(s.ui_mode.as_deref(), Some("widget"));
    assert_eq!(s.whisper_mode, Some(true));
    assert_eq!(s.summon_shortcut.as_deref(), Some("ctrl+alt+KeyP"));
    assert_eq!(s.semantic_search, Some(false));
    assert_eq!(s.background_conserve, Some(false));
    assert_eq!(s.ocr_enabled, Some(false));
    assert_eq!(s.audit_enabled, Some(true));
    assert_eq!(s.draft_answers, Some(false));
    assert_eq!(s.briefing_notify, Some(false));
    assert_eq!(s.briefing_note_hour, Some(7));
    assert_eq!(s.tour_shown, Some(true));
    assert_eq!(
        s.vault_dir.as_deref(),
        Some("/somewhere/vault"),
        "shell-owned vaultDir must survive the typed writer"
    );
    assert_eq!(
        s.extra.get("widgetPos"),
        Some(&serde_json::json!([7, 9])),
        "unmodeled keys must survive the read-modify-write (flatten)"
    );
}
