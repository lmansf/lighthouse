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
    read_desktop_settings, set_explorer_width, set_openai_auth_method, write_desktop_settings,
    DesktopSettings, EXPLORER_WIDTH_MAX, EXPLORER_WIDTH_MIN,
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
        openai_auth_method: Some("signin".into()),
        beam_max_steps: Some(6),
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
        openai_auth_method,
        beam_max_steps,
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
    assert_eq!(openai_auth_method.as_deref(), Some("signin"));
    assert_eq!(beam_max_steps, Some(6));
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
        "openaiAuthMethod",
        "beamMaxSteps",
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
    // Pre-seed what the typed writer must never clobber: the shell-owned
    // vaultDir, an unmodeled key (widgetPos → `extra`), and the sign-in
    // auth-method choice, which only its narrow setter writes (0.12.1 §3).
    std::fs::write(
        &file,
        r#"{"vaultDir":"/somewhere/vault","widgetPos":[7,9],"openaiAuthMethod":"signin"}"#,
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
        Some(8),                        // beam_max_steps
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
    assert_eq!(s.beam_max_steps, Some(8));
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
    assert_eq!(
        s.openai_auth_method.as_deref(),
        Some("signin"),
        "the sign-in auth method must survive the positional writer untouched"
    );
}

// Provider sign-in (0.12.1 §3): the auth-method choice has its own narrow
// setter (never a positional param — see settings.rs) with a two-value
// domain. It must round-trip, refuse anything else, and preserve every
// other key exactly like the main writer.
#[test]
fn openai_auth_method_narrow_setter_round_trips_and_validates() {
    let vault = tempfile::tempdir().expect("tempdir");
    let _guard = common::lock_env(vault.path());
    let file = vault.path().join("settings-signin-test.json");
    std::fs::write(&file, r#"{"vaultDir":"/somewhere/vault","widgetPos":[7,9]}"#)
        .expect("seed settings file");
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &file);

    // Default: absent ⇒ the key path ("key" is implied, nothing stored).
    assert_eq!(read_desktop_settings().openai_auth_method, None);

    // "signin" persists…
    set_openai_auth_method("signin");
    assert_eq!(
        read_desktop_settings().openai_auth_method.as_deref(),
        Some("signin")
    );
    // …an out-of-domain value is ignored (the stored choice stands)…
    set_openai_auth_method("carrier-pigeon");
    assert_eq!(
        read_desktop_settings().openai_auth_method.as_deref(),
        Some("signin")
    );
    // …and "key" restores the default explicitly.
    set_openai_auth_method("key");
    let s = read_desktop_settings();
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");
    assert_eq!(s.openai_auth_method.as_deref(), Some("key"));
    // The narrow setter preserves shell-owned and unmodeled keys.
    assert_eq!(s.vault_dir.as_deref(), Some("/somewhere/vault"));
    assert_eq!(s.extra.get("widgetPos"), Some(&serde_json::json!([7, 9])));
}

// Resizable explorer width (openspec: add-usability-field-patch §1): a per-
// window-mode value hand-persisted through the `extra` map (the widgetPos
// precedent) with its own narrow read-modify-write setter. It must round-trip
// per mode WITHOUT clobbering the sibling mode, clamp to the bounds at write
// AND read, ignore an unknown mode or a non-finite width, and preserve every
// shell-owned key — like the auth-method setter above.
#[test]
fn explorer_width_persists_per_mode_and_clamps() {
    let vault = tempfile::tempdir().expect("tempdir");
    let _guard = common::lock_env(vault.path());
    let file = vault.path().join("settings-explorer-width-test.json");
    std::fs::write(&file, r#"{"vaultDir":"/somewhere/vault","widgetPos":[7,9]}"#)
        .expect("seed settings file");
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &file);

    // Unset ⇒ None for both modes.
    assert_eq!(read_desktop_settings().explorer_width("window"), None);
    assert_eq!(read_desktop_settings().explorer_width("widget"), None);

    // An in-range width round-trips for its mode and does NOT bleed into the
    // sibling mode.
    set_explorer_width("window", 360.0);
    assert_eq!(read_desktop_settings().explorer_width("window"), Some(360.0));
    assert_eq!(read_desktop_settings().explorer_width("widget"), None);

    // The sibling mode persists independently — a merge, not a clobber.
    set_explorer_width("widget", 280.0);
    let s = read_desktop_settings();
    assert_eq!(s.explorer_width("widget"), Some(280.0));
    assert_eq!(s.explorer_width("window"), Some(360.0));

    // Clamp at write: above MAX and below MIN both saturate to the bounds.
    set_explorer_width("window", 100_000.0);
    assert_eq!(
        read_desktop_settings().explorer_width("window"),
        Some(EXPLORER_WIDTH_MAX)
    );
    set_explorer_width("window", 1.0);
    assert_eq!(
        read_desktop_settings().explorer_width("window"),
        Some(EXPLORER_WIDTH_MIN)
    );

    // An unknown mode or a non-finite width leaves the file untouched.
    set_explorer_width("sidebar", 300.0);
    set_explorer_width("window", f64::NAN);
    let s = read_desktop_settings();
    assert_eq!(s.explorer_width("window"), Some(EXPLORER_WIDTH_MIN)); // unchanged
    assert_eq!(s.explorer_width("widget"), Some(280.0)); // unchanged
    assert_eq!(
        s.extra.get("explorerWidth").and_then(|v| v.get("sidebar")),
        None
    );
    // The narrow read-modify-write preserved shell-owned and unmodeled keys.
    assert_eq!(s.vault_dir.as_deref(), Some("/somewhere/vault"));
    assert_eq!(s.extra.get("widgetPos"), Some(&serde_json::json!([7, 9])));

    // Clamp at READ too: a hand-written out-of-range file is bounded on the way
    // out (the external-write path the shell might take, widgetPos-style).
    std::fs::write(&file, r#"{"explorerWidth":{"window":9999,"widget":1}}"#)
        .expect("rewrite settings file");
    let s = read_desktop_settings();
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");
    assert_eq!(s.explorer_width("window"), Some(EXPLORER_WIDTH_MAX));
    assert_eq!(s.explorer_width("widget"), Some(EXPLORER_WIDTH_MIN));
}
