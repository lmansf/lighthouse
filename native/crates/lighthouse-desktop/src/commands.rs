//! IPC command surface (Phase 4): the same operations the 13 HTTP routes
//! expose, carried over Tauri's invoke/Channel transport instead of a local
//! TCP port. The webview is the only caller and commands run in-process, so
//! the loopback/Origin/token auth layer has no equivalent here — there is no
//! port to defend.
//!
//! §40 crate split: tauri-free command bodies live in lighthouse-shell
//! (`lighthouse_shell::commands`) so the Linux dev container can `cargo check`
//! them; the `#[tauri::command]` fns here either delegate one-to-one or keep
//! their body because it genuinely needs tauri (windows, dialogs, channels,
//! app state). See docs/crate-split.md for the cut line.

use futures::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use lighthouse_core::contracts::{ChatChunk, ChatTurn, CostMeta};
use lighthouse_core::{local_model, profile, settings, vault};
use lighthouse_shell::commands::{err_string, percent_decode};

// Re-exports so the wrapper's internal callers (lib.rs's mobile boot probe
// and the private_model_availability command below) keep their pre-split
// `commands::` paths. The observer exists only on mobile targets (both shell
// variants are `not(desktop)`-gated, exactly as pre-split), so its re-export
// carries the same gate as its one call site — ungated, it fails E0432 on
// every desktop build.
pub(crate) use lighthouse_shell::commands::private_model_availability_impl;
#[cfg(not(desktop))]
pub(crate) use lighthouse_shell::commands::start_content_size_observer;

#[tauri::command]
pub async fn rag_list() -> Value {
    lighthouse_shell::commands::rag_list().await
}

#[tauri::command]
pub async fn rag_op(app: AppHandle, body: Value) -> Result<Value, String> {
    use tauri::Emitter;
    // The one window signal the moved body needs: vault-changed broadcasts,
    // supplied here as a callback (docs/crate-split.md, the vault-changed seam).
    lighthouse_shell::commands::rag_op(body, &|| {
        let _ = app.emit("vault-changed", ());
    })
    .await
}

/// Streamed chat over an IPC channel: one `ChatChunk` per message, the final
/// one carrying references — the NDJSON protocol, minus the wire.
#[tauri::command]
pub async fn chat_ask(
    question: String,
    included_file_ids: Vec<String>,
    history: Vec<Value>,
    attachment_file_ids: Vec<String>,
    // The investigation this ask runs inside (openspec: add-investigations).
    // `Option` so an older caller that omits it still invokes cleanly; absent
    // = the global context. Resolved below, beside model_config().
    investigation_id: Option<String>,
    // Answer cache controls (openspec: add-answer-cache). `Option` so an older
    // caller that omits them still invokes cleanly; absent means false — the
    // privacy-safe default (memory-only cache, no disk mirror).
    bypass_cache: Option<bool>,
    persist_allowed: Option<bool>,
    // Two-phase plan approval (openspec: add-beam-loop §4), mirroring the
    // optional cache controls above. Phase 1: `plan_only` runs step-1 planning
    // and returns a PLAN chunk, then STOPS (executes nothing, egresses only the
    // plan-generation call). Phase 2: `approved_plan` is the approved SQL echoed
    // back on re-issue — executed as step 1 without re-planning (the guard still
    // runs). Absent = an ordinary ask, so an older caller invokes unchanged.
    plan_only: Option<bool>,
    approved_plan: Option<String>,
    on_chunk: Channel<ChatChunk>,
) -> Result<(), String> {
    // 0.14.1 field report: iOS tears the private-model loopback listener down
    // with app suspension, so the first ask after resume hit a dead port
    // (connection refused) and fell back to passages. Re-ensuring per ask is a
    // lock + state check when the bridge is healthy, and re-binds + re-points
    // LIGHTHOUSE_LOCAL_LLM_URL (fresh ephemeral port) + the backend verdict
    // when it died — so an ask never races a dead bridge. Desktop's
    // llama-server has its own supervisor and never needs this.
    #[cfg(not(desktop))]
    let _ = private_model_availability_impl();
    let history: Vec<ChatTurn> = {
        let turns: Vec<ChatTurn> = history
            .iter()
            .filter_map(|t| {
                let role = t["role"].as_str()?;
                let content = t["content"].as_str()?;
                (role == "user" || role == "assistant").then(|| ChatTurn {
                    role: role.to_string(),
                    content: content.to_string(),
                })
            })
            .collect();
        let skip = turns.len().saturating_sub(8);
        turns.into_iter().skip(skip).collect()
    };
    // Investigation scope + provider policy resolve HERE — the same
    // chokepoint where the profile's model config is consulted (and beneath
    // which the managed policy's llm-time belt sits), so a local-only
    // investigation swaps cfg before any transport exists and scope arrives
    // as ordinary attachments (openspec: add-investigations). The third
    // element is the investigation's conversationRefs — retrieval's recall
    // preference (§3); empty when no investigation rides the ask. PARITY:
    // routes.rs chat_post.
    let (attachment_file_ids, cfg, preferred_conversation_ids) =
        lighthouse_core::investigations::resolve_ask_context(
            investigation_id.as_deref(),
            attachment_file_ids,
            profile::model_config(),
        );
    // Mark a chat in flight so background-conserve suspension (hide-to-tray /
    // idle) can't kill the local chat server out from under this stream — the
    // teardown waits until the guard drops at the end of the ask. Desktop-only:
    // mobile has no supervised local servers to conserve.
    #[cfg(desktop)]
    let _chat_guard = crate::supervise::ChatGuard::new();
    // The whole ask path — single-shot RAG or multi-document synthesis, with
    // pre-answer progress chunks (docs/multi-doc-synthesis.md) — lives in the
    // engine pipeline, shared with the axum route (retrieval-query blending
    // included).
    // Audit log (add-audit-log): capture the question + egress baseline before
    // the answer, record once the final chunk's references are known. Covers
    // the widget AND the main window (both invoke this command).
    let audit = lighthouse_core::audit::AnswerAudit::start(&question);
    let provider = cfg
        .provider_id
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let mut chunks = lighthouse_core::synth::answer_pipeline(
        question,
        included_file_ids,
        attachment_file_ids,
        history,
        cfg,
        lighthouse_core::answer_cache::CacheCtl {
            bypass_cache: bypass_cache.unwrap_or(false),
            persist_allowed: persist_allowed.unwrap_or(false),
        },
        lighthouse_core::beam::PlanCtl {
            plan_only: plan_only.unwrap_or(false),
            approved_plan,
        },
        preferred_conversation_ids,
    );
    let mut final_files: Vec<String> = Vec::new();
    let mut artifacts: Vec<String> = Vec::new();
    // The NEW cost this ask incurred (openspec: add-beam-loop §3.2), read from
    // the final chunk's meter; a cache replay computes nothing (0 new).
    let mut answer_cost: Option<CostMeta> = None;
    while let Some(c) = chunks.next().await {
        if c.done {
            if let Some(refs) = &c.references {
                final_files = refs.iter().map(|r| r.file_id.clone()).collect();
            }
            if let Some(a) = &c.analytics {
                artifacts.extend(a.file_ids.iter().cloned());
            }
            if let Some(meta) = &c.meta {
                answer_cost = lighthouse_core::audit::ask_new_cost(meta);
            }
        }
        let _ = on_chunk.send(c);
    }
    audit.finish(&provider, final_files, artifacts, answer_cost);
    Ok(())
}

#[tauri::command]
pub fn profile_get() -> Value {
    lighthouse_shell::commands::profile_get()
}

#[tauri::command]
pub async fn profile_op(body: Value) -> Result<Value, String> {
    lighthouse_shell::commands::profile_op(body).await
}

/// Best-effort tail of the desktop shell.log (the app-data `shell.log` the
/// shell writes via `shell_log`). Returns "" on ANY error, and caps the excerpt
/// to the last ~100 lines / ~16 KB so a bug report stays small. This is the only
/// diagnostics attached to a report, and only when the user opts in.
fn shell_log_excerpt(app: &AppHandle) -> String {
    // Pinned base (see `lib.rs::app_data_base`) so this reads the same shell.log
    // that `shell_log` writes across the 0.12.8 identifier rename.
    let Some(dir) = crate::app_data_base(app) else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("shell.log")) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(100);
    let mut excerpt = lines[start..].join("\n");
    const MAX_BYTES: usize = 16 * 1024;
    if excerpt.len() > MAX_BYTES {
        // Keep the newest bytes; advance the cut to a char boundary.
        let mut cut = excerpt.len() - MAX_BYTES;
        while cut < excerpt.len() && !excerpt.is_char_boundary(cut) {
            cut += 1;
        }
        excerpt = excerpt[cut..].to_string();
    }
    excerpt
}

/// Diagnostics for the "Send feedback" dialog: app version, OS, and — only when
/// the user opts in — a shell.log excerpt. Read-only; the app transmits none of
/// it. The dialog composes a mailto:/GitHub-issue the user sends themselves.
#[tauri::command]
pub async fn diagnostics(app: AppHandle) -> Result<Value, String> {
    Ok(json!({
        "version": lighthouse_core::config::app_version(),
        "os": std::env::consts::OS,
        "log": shell_log_excerpt(&app),
    }))
}

#[tauri::command]
pub async fn connect_op(body: Value) -> Result<Value, String> {
    lighthouse_shell::commands::connect_op(body).await
}

// The model commands are async so they run on the Tauri async runtime, NOT the
// main thread. That (a) gives `start_download()` an ambient Tokio runtime to
// spawn onto, and (b) contains any future panic in this path to the task —
// sync commands run on the main thread, where a panic exits the whole app
// (which is exactly how the Install click used to crash the desktop build).
#[tauri::command]
pub async fn model_status(app: AppHandle) -> Value {
    // `mut` feeds the desktop-only GPU merge below; on mobile it's unused.
    #[cfg_attr(not(desktop), allow(unused_mut))]
    let mut v = serde_json::to_value(local_model::model_status()).unwrap_or_else(|_| json!({}));
    // Merge the shell's REAL llama-server GPU launch state (G2) so the AI-models
    // dialog shows "GPU acceleration: on (N layers)" / "off — CPU" instead of a
    // guess. Absent until a chat server has run this session (gpu_status None) —
    // the UI treats missing fields as "unknown → render nothing". Desktop-only:
    // mobile has no llama supervision, so the fields stay absent there.
    #[cfg(desktop)]
    if let (Some(obj), Some(g)) = (
        v.as_object_mut(),
        app.try_state::<crate::supervise::Supervisor>()
            .and_then(|s| s.gpu_status()),
    ) {
        obj.insert("gpuOn".into(), json!(g.gpu));
        obj.insert("gpuLayers".into(), json!(g.layers));
        obj.insert("gpuRunning".into(), json!(g.running));
    }
    #[cfg(not(desktop))]
    let _ = &app;
    v
}

#[tauri::command]
pub async fn model_download(app: AppHandle) -> Value {
    let v = serde_json::to_value(local_model::start_download()).unwrap_or_else(|_| json!({}));
    // §22.4 eager warm: don't leave a freshly downloaded model cold until the
    // next reconcile tick discovers it — watch this download and start the
    // chat server (whose existing spawn path health-polls and then warms) the
    // moment the file lands. One watcher at a time; start_local_llm itself
    // enforces the safe-mode gate, and a suspended (hidden/passive) app defers
    // to reconcile's normal resume behavior instead of warming from the
    // background. Desktop-only: mobile has no llama supervision to warm.
    #[cfg(not(desktop))]
    let _ = &app;
    #[cfg(desktop)]
    {
    static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        tauri::async_runtime::spawn(async move {
            // Bound ≈ the slowest plausible multi-GB fetch; the 1 s poll
            // matches the UI's own download-progress poll.
            for _ in 0..(3 * 60 * 60) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                match local_model::model_status().status.as_str() {
                    "downloading" => continue,
                    "ready" => {
                        if let Some(sup) = app.try_state::<crate::supervise::Supervisor>() {
                            if !sup.is_suspended() {
                                sup.start_local_llm(&app);
                            }
                        }
                        break;
                    }
                    _ => break, // error / uninstalled / absent — nothing to warm
                }
            }
            WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }
    }
    v
}

#[tauri::command]
pub async fn model_uninstall() -> Value {
    lighthouse_shell::commands::model_uninstall().await
}

#[tauri::command]
pub fn open_node(node_id: String) -> Result<Value, String> {
    lighthouse_shell::commands::open_node(node_id)
}

/// Reveal a vault node in the OS file manager, selecting it inside its folder.
/// A blank node id (or none) opens the vault directory itself, so the same
/// route backs both the row action and the toolbar's "Open vault folder".
/// Works for folders too (a folder reveals/opens in place).
#[tauri::command]
pub fn reveal_node(app: AppHandle, node_id: Option<String>) -> Result<Value, String> {
    // Mobile has no OS file manager to reveal into (§3.3 exposes the vault via
    // the Files app / SAF instead). Honest error until then.
    #[cfg(not(desktop))]
    {
        let _ = (app, node_id);
        return Err("revealing files in the OS is not available on this platform yet".into());
    }
    #[cfg(desktop)]
    match node_id.filter(|s| !s.trim().is_empty()) {
        None => {
            crate::open_with_os(&crate::vault_dir_setting(&app));
            Ok(json!({ "ok": true }))
        }
        Some(id) => {
            let abs = vault::resolve_node_path(&id)
                .map_err(|e| err_string(e, "could not reveal file"))?;
            if std::fs::metadata(&abs).is_err() {
                return Err("file no longer exists".into());
            }
            crate::reveal_with_os(&abs);
            Ok(json!({ "ok": true }))
        }
    }
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Value {
    let s = settings::read_desktop_settings();
    // Hotkey + whisper are desktop machinery; the mobile shell reports them as
    // dead/unsupported so the UI swaps its copy instead of promising a chord.
    #[cfg(desktop)]
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    #[cfg(not(desktop))]
    let hotkey_ok = {
        let _ = &app;
        false
    };
    #[cfg(desktop)]
    let whisper_permission = crate::whisper::permission_state();
    #[cfg(not(desktop))]
    let whisper_permission = "unsupported";
    json!({
        "desktop": true,
        // Form factor (§1): "desktop" | "ios" | "android". The UI's platform
        // gates (mode chooser, startup prompt, model roster) key off THIS, not
        // the compat `desktop` flag above.
        "platform": crate::platform_kind(),
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode, // null until the first-run chooser is answered
        "whisperMode": s.whisper_mode == Some(true),
        // "granted" | "pending" (macOS Accessibility) | "unsupported" | "unknown"
        "whisperPermission": whisper_permission,
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        // False on Wayland — the UI swaps hotkey copy for the tray fallback.
        "summonHotkeyOk": hotkey_ok,
        "semanticSearch": s.semantic_search != Some(false), // default on (B2)
        "backgroundConserve": s.background_conserve != Some(false), // default on
        "ocrEnabled": s.ocr_enabled != Some(false), // default on (add-ocr-perception)
        "auditEnabled": s.audit_enabled == Some(true), // opt-in, default off (add-audit-log)
        "draftAnswers": s.draft_answers != Some(false), // default on (G2)
        "briefingNotify": s.briefing_notify != Some(false), // default on (G5)
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9), // default 9am (G5)
        "tourShown": s.tour_shown == Some(true), // first-run tour, once per install
        // Resizable explorer width per window mode (openspec §1), clamped at
        // read; null when unset. Mirrors app/api/settings/route.ts GET.
        "explorerWidth": {
            "window": s.explorer_width("window"),
            "widget": s.explorer_width("widget"),
        },
        // Appearance customization (openspec §3), validated. Mirrors route.ts GET.
        "appearance": s.appearance(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn settings_set(
    app: AppHandle,
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
    // Resizable explorer width (openspec §1): {mode,width} for one window mode.
    // It rides its OWN narrow merge-setter (set_explorer_width) — NOT a new
    // positional param on write_desktop_settings (which would clobber the
    // sibling mode and trip the settings_test writer tripwire). None = untouched.
    explorer_width: Option<Value>,
    // Appearance customization (openspec §3): a validated patch through its own
    // narrow merge-setter (set_appearance), like explorer_width. None = untouched.
    appearance: Option<Value>,
) -> Value {
    // A new summon shortcut must PARSE before anything persists — saving an
    // unregistrable string would strand the user with no hotkey at all.
    // Empty string = reset to the default chord. (Desktop-only: mobile has no
    // global-shortcut backend; the value persists inert there.)
    #[cfg(desktop)]
    if let Some(accel) = summon_shortcut.as_deref().map(str::trim) {
        if !accel.is_empty()
            && accel
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .is_err()
        {
            let s = settings::read_desktop_settings();
            return json!({
                "ok": false,
                "reason": "that key combination can't be registered",
                "summonShortcut": s
                    .summon_shortcut
                    .as_deref()
                    .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
            });
        }
    }
    #[cfg(desktop)]
    let switched_mode = ui_mode.clone();
    #[cfg(desktop)]
    let shortcut_changed = summon_shortcut.is_some();
    // Remember the working chord so a new one that PARSES but fails to
    // register (another app already owns it) can be rolled back instead of
    // stranding the user hotkey-less with a broken value persisted.
    #[cfg(desktop)]
    let prev_shortcut = settings::read_desktop_settings().summon_shortcut;
    let s = settings::write_desktop_settings(
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
        beam_max_steps,
    );
    // Resizable explorer width (openspec §1): applied through its own narrow
    // merge-setter (set_explorer_width) so a "window" width never clobbers a
    // "widget" one — NOT the positional writer above. None = untouched; the
    // engine clamps + validates the mode.
    if let Some(ew) = explorer_width.as_ref() {
        if let (Some(mode), Some(width)) = (ew["mode"].as_str(), ew["width"].as_f64()) {
            settings::set_explorer_width(mode, width);
        }
    }
    // Appearance customization (openspec §3): the engine validates against the
    // whitelist; anything else is dropped.
    if let Some(ap) = appearance.as_ref() {
        if ap.is_object() {
            settings::set_appearance(ap);
        }
    }
    #[cfg(desktop)]
    if shortcut_changed && !crate::register_summon_shortcut(&app) {
        // The new chord didn't register — restore the previous one so the
        // summon hotkey keeps working, and report the failure to the UI.
        // Pass "" (not None) when the previous value was the default, so the
        // writer actually overwrites the bad chord instead of leaving it.
        settings::write_desktop_settings(
            None,
            None,
            None,
            None,
            Some(prev_shortcut.clone().unwrap_or_default()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        crate::register_summon_shortcut(&app);
        return json!({
            "ok": false,
            "reason": "another app already uses that shortcut — kept the previous one",
            "summonShortcut": prev_shortcut
                .as_deref()
                .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
            "summonHotkeyOk": true,
        });
    }
    // Autostart is CONSENT-FIRST (mirrors the boot gate in desktop::setup): only
    // touch the OS registration once the startup prompt has been answered.
    // Unrelated writes — e.g. the first-run uiMode chooser — must not enroll.
    #[cfg(desktop)]
    if s.startup_asked == Some(true) {
        crate::apply_autostart(&app, s.run_on_startup != Some(false));
    }
    // Switching interface mode at runtime applies the mode's RESIDENCY
    // immediately, like a boot would, and swaps the visible SURFACE whole:
    // widget mode tucks the main window away and summons the bar (the bar
    // REPLACES the window — leaving both up made the switch read as broken);
    // window mode dismisses the bar and brings the window back. The user's
    // pin (always-on-top) is independent of the mode and untouched here.
    // Window work is deferred to the main thread: show_widget may lazily
    // CREATE the widget window, and building a webview from a sync command
    // handler deadlocks the IPC thread against the main loop.
    #[cfg(desktop)]
    if let Some(mode) = switched_mode.as_deref() {
        let resident = mode == "widget";
        crate::set_widget_resident(&app, resident);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if resident {
                if let Some(main) = app2.get_webview_window("main") {
                    let _ = main.hide();
                }
                crate::show_widget(&app2, true);
            } else {
                crate::hide_widget(&app2);
                if let Some(main) = app2.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        });
    }
    // Whisper mode (W3) starts/stops its keyboard hook live — no relaunch.
    // Managed policy widgetHotkeys "off": turning it ON is refused here (the
    // hook must never install); turning it OFF is always honored.
    #[cfg(desktop)]
    if let Some(on) = whisper_mode {
        if !on || lighthouse_core::policy::hotkeys_allowed() {
            crate::whisper::set_enabled(&app, on);
        }
    }
    // Semantic search (B2) applies live too: the supervisor's 3 s reconcile
    // starts or stops the embedding server to match the new setting, and its
    // health poll kicks the vector warm pass once the server is up.
    // (Desktop-only: mobile has no supervised embedding server.)
    #[cfg(desktop)]
    if semantic_search.is_some() {
        app.state::<crate::supervise::Supervisor>().reconcile(&app);
    }
    #[cfg(desktop)]
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    #[cfg(not(desktop))]
    let hotkey_ok = {
        let _ = &app;
        false
    };
    #[cfg(desktop)]
    let whisper_permission = crate::whisper::permission_state();
    #[cfg(not(desktop))]
    let whisper_permission = "unsupported";
    // Re-read so the response reflects any explorer-width merge above (which the
    // positional writer's returned `s` doesn't know about); the boolean fields
    // are unaffected either way.
    let widths = settings::read_desktop_settings();
    json!({
        "ok": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode,
        "whisperMode": s.whisper_mode == Some(true),
        "whisperPermission": whisper_permission,
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        "summonHotkeyOk": hotkey_ok,
        "semanticSearch": s.semantic_search != Some(false),
        "backgroundConserve": s.background_conserve != Some(false),
        "draftAnswers": s.draft_answers != Some(false),
        "briefingNotify": s.briefing_notify != Some(false),
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9),
        "explorerWidth": {
            "window": widths.explorer_width("window"),
            "widget": widths.explorer_width("widget"),
        },
        "appearance": widths.appearance(),
    })
}

#[tauri::command]
pub async fn add_paths(paths: Vec<String>, link: bool) -> Value {
    lighthouse_shell::commands::add_paths(paths, link).await
}

/// Native link-file picker (replaces the Electron preload's `linkDialog`).
#[tauri::command]
pub async fn pick_link_paths(app: AppHandle, directory: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
    let title = if directory {
        "Link a folder in place (not copied)"
    } else {
        "Link files in place (not copied)"
    };
    let dialog = app.dialog().file().set_title(title);
    if directory {
        // The dialog plugin's folder picker is desktop-only (no
        // Android/iOS folder-pick API); folder-LINKING is a desktop flow
        // anyway — mobile ingestion is copy-in via the share sheet /
        // document picker (§3.3). Answer "nothing picked" there.
        #[cfg(desktop)]
        dialog.pick_folder(move |p| {
            let out = p
                .and_then(|f| f.into_path().ok())
                .map(|p| vec![p.to_string_lossy().to_string()])
                .unwrap_or_default();
            let _ = tx.send(out);
        });
        #[cfg(not(desktop))]
        {
            let _ = dialog;
            let _ = tx.send(Vec::new());
        }
    } else {
        dialog.pick_files(move |ps| {
            let out = ps
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = tx.send(out);
        });
    }
    rx.await.unwrap_or_default()
}

/// One uploaded file as a raw-bytes IPC request (filename/dir in headers) —
/// replaces the HTTP multipart route with the same caps and semantics.
#[tauri::command]
pub fn upload_file(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file bytes".into());
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "exceeds {}MB limit",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    // Header values arrive percent-encoded (filenames are arbitrary UTF-8;
    // HTTP header values are not).
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| percent_decode(s))
            .filter(|s| !s.is_empty())
    };
    let name = header("x-file-name").ok_or("x-file-name header required")?;
    let dir = header("x-dest-dir");
    vault::add_file(&name, bytes, dir.as_deref())
        .map(|new_id| json!({ "newId": new_id }))
        .map_err(|e| err_string(e, "upload failed"))
}

/// Current update-notification state (splash/tray parity with the Electron
/// preload's read-only update bridge).
#[tauri::command]
pub fn update_state(app: AppHandle) -> Value {
    // Mobile updates are store-mediated (App Store / Play) — the shell never
    // checks or installs, so the banner permanently reads "no update here".
    #[cfg(not(desktop))]
    {
        let _ = &app;
        return json!({ "phase": "none" });
    }
    #[cfg(desktop)]
    {
        let newer = app
            .try_state::<crate::supervise::UpdateState>()
            .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
        match newer {
            Some(info) => json!({
                "phase": "available",
                "version": info.version,
                "url": crate::supervise::RELEASE_PAGE_URL,
                // In-app install = asset + detached signature + a baked-in key to
                // verify with (updater Phase B); otherwise the button says
                // "Get it" and opens the releases page.
                "canInstall": info.asset_url.is_some()
                    && info.sig_url.is_some()
                    && crate::supervise::updater_pubkey().is_some(),
            }),
            None => json!({ "phase": "none" }),
        }
    }
}

/// Click-to-update from the sidebar banner: download this platform's
/// installer and hand off to it (see supervise::update_now for the
/// per-platform behavior and fallbacks).
#[tauri::command]
pub async fn update_now(app: AppHandle) -> Value {
    #[cfg(not(desktop))]
    {
        let _ = &app;
        return json!({ "ok": false, "error": "updates arrive through the app store on this platform" });
    }
    #[cfg(desktop)]
    {
        crate::supervise::update_now(app).await
    }
}

#[tauri::command]
pub fn watch_generation() -> u64 {
    lighthouse_shell::commands::watch_generation()
}

#[tauri::command]
pub fn diag_report(payload: String) {
    lighthouse_shell::commands::diag_report(payload)
}

/// CI boot smoke (LIGHTHOUSE_SMOKE=1, release-smoke.yml): the in-webview
/// probe reports its verdict here and the process exits with it — 0 for a
/// grounded answer, 2 for a failed assertion. Inert outside smoke mode (the
/// driver JS that invokes it is only ever injected when the env var is set).
#[tauri::command]
pub fn smoke_report(app: tauri::AppHandle, payload: String) {
    eprintln!("SMOKE {payload}");
    let ok = payload.starts_with("OK");
    app.exit(if ok { 0 } else { 2 });
}

// --- Desktop widget (docs/widget-scope.md §7, W1 frozen contract). All are
// plain app commands so the widget webview needs no extra ACL grants; window
// mutations happen Rust-side, which also keeps the pin state authoritative
// for the blur-hide decision in main.rs. ---

/// Hide the widget (Esc, the ✕ button, or after a result action).
/// The widget commands stay REGISTERED on mobile — the shared UI may still
/// invoke them — but their bodies are desktop-only no-ops there (no floating
/// bar exists to act on).
#[tauri::command]
pub fn widget_hide(app: AppHandle) {
    #[cfg(desktop)]
    crate::hide_widget(&app);
    #[cfg(not(desktop))]
    let _ = &app;
}

/// Summon the widget from the UI (the first-run mode chooser and Preferences
/// use it to demo widget mode the moment it's picked). Async + main-thread
/// hop for the same reason as open_explorer: show_widget lazily CREATES the
/// widget window when boot deferred it, and a sync command doing that
/// deadlocks the IPC handler against the main loop.
#[tauri::command]
pub async fn widget_show(app: AppHandle) {
    #[cfg(not(desktop))]
    let _ = &app;
    #[cfg(desktop)]
    {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::show_widget(&inner, true);
        // This command IS the user's explicit "turn widget mode on" gesture
        // (mode chooser, Preferences demo). A bar that silently fails to
        // appear reads as a dead toggle (0.6.3 field report) — diagnose
        // loudly here, never on routine summons.
        if inner.get_webview_window(crate::WIDGET_LABEL).is_none() {
            crate::shell_log(&inner, "widget_show: bar unavailable after an explicit enable");
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            inner
                .dialog()
                .message(
                    "The floating search bar couldn't start on this machine.\n\nA diagnostic was written to shell.log in Lighthouse's app-data folder — please share that file so this can be fixed.",
                )
                .title("Lighthouse — widget mode")
                .kind(MessageDialogKind::Warning)
                .show(|_| {});
        }
    });
    }
}

/// Pin = the user's "keep above other windows" toggle: always-on-top AND no
/// blur auto-hide. The bar is otherwise a normal-stacking window (created
/// non-topmost; widget-mode residency only prevents auto-hide), so this is
/// the one switch that visibly changes stacking — pinned floats over
/// everything, unpinned lets other windows cover it until the next summon.
#[tauri::command]
pub fn widget_set_pin(app: AppHandle, pinned: bool) {
    #[cfg(not(desktop))]
    let _ = (&app, pinned);
    #[cfg(desktop)]
    {
        crate::set_widget_pinned(&app, pinned);
        if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
            let _ = w.set_always_on_top(pinned);
            // A pinned bar should survive workspace switches where the OS
            // supports it (macOS/Linux; a no-op on Windows).
            let _ = w.set_visible_on_all_workspaces(pinned);
        }
    }
}

/// Grow/shrink the widget window as the results dropdown or the inline
/// answer panel renders. Height is clamped shell-side so a misbehaving page
/// can't fill the screen (520 leaves room for a compact streamed answer).
#[tauri::command]
pub fn widget_resize(app: AppHandle, height: f64) {
    #[cfg(not(desktop))]
    let _ = (&app, height);
    #[cfg(desktop)]
    {
        const MIN: f64 = 56.0;
        const MAX: f64 = 520.0;
        if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
            let clamped = height.clamp(MIN, MAX);
            let _ = w.set_size(tauri::LogicalSize::new(crate::WIDGET_WIDTH, clamped));
        }
    }
}

/// Hold = an inline answer is on screen. Blur must not dismiss the bar while
/// the user reads a "frozen" compact answer (clicking away to their document
/// is the POINT); Esc/✕ still hide explicitly. Orthogonal to the user's pin.
#[tauri::command]
pub fn widget_hold(app: AppHandle, hold: bool) {
    #[cfg(not(desktop))]
    let _ = (&app, hold);
    #[cfg(desktop)]
    if let Some(state) = app.try_state::<crate::WidgetHold>() {
        state.0.store(hold, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Raise the main window; with a seed question, hand it to the chat panel
/// ("Ask Lighthouse →" from the widget). The transport re-broadcasts the
/// event as a DOM CustomEvent the ChatPanel listens for.
#[tauri::command]
pub fn show_main(app: AppHandle, seed_question: Option<String>) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        // Minimize/unminimize and llama supervision are desktop concepts; on
        // mobile the main webview is the only surface and is already up.
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
            // Resume the local servers if background-conserve had suspended them.
            crate::resume_servers(&app);
        }
        let _ = w.set_focus();
    }
    if let Some(q) = seed_question.filter(|q| !q.trim().is_empty()) {
        let _ = app.emit_to("main", "ask-question", json!({ "question": q }));
    }
}

/// Open the vault directory in the OS file manager (File menu; also kept for
/// anything that wants the literal folder rather than the explorer window).
#[tauri::command]
pub fn open_vault_dir(app: AppHandle) {
    #[cfg(desktop)]
    crate::open_with_os(&crate::vault_dir_setting(&app));
    #[cfg(not(desktop))]
    let _ = &app;
}

/// Open (or raise) the standalone vault-explorer window — the widget's 📁
/// button (W2). Same FileExplorer as the main sidebar, in its own window.
///
/// ASYNC + main-thread hop, deliberately: a SYNC command that builds a
/// webview window deadlocks the IPC handler against the main loop (the
/// handler blocks a thread the window creation needs). Field symptom: the
/// 📁 click produced a stillborn white window on Windows and no window at
/// all on Linux. Async commands release the IPC thread, and the explicit
/// run_on_main_thread makes the builder run where GTK/AppKit require it.
#[tauri::command]
pub async fn open_explorer(app: AppHandle) {
    #[cfg(desktop)]
    {
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || crate::open_explorer(&inner));
    }
    #[cfg(not(desktop))]
    let _ = &app;
}

/// Whether a private, on-device model backend is usable on THIS device, and
/// which tier serves it — `{ available, tier, reason }`. The mobile roster
/// (`src/stores/useOnDeviceModel.ts`) probes this once to light the "private"
/// provider up with honest per-tier copy. Registered on EVERY target (like
/// `model_status`); desktop answers the llama-server tier without any shim.
#[tauri::command]
pub async fn private_model_availability() -> Value {
    private_model_availability_impl()
}

/// §31: the OS "Reduce Transparency" accessibility setting. WKWebView exposes
/// no `prefers-reduced-transparency` media query, so the shell answers
/// natively and the UI stamps `data-reduce-transparency` on the document root
/// (globals.css turns that into solid chrome surfaces). macOS asks
/// NSWorkspace, iOS asks UIAccessibility; Windows/Linux have no equivalent
/// queryable toggle — answer false there and the in-app glass slider rules.
/// Re-queried by the UI on every return to foreground, so mid-session flips
/// land without a relaunch.
#[tauri::command]
pub fn reduce_transparency() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        // Read-only accessibility query on the shared workspace (the same
        // objc2 unsafe idiom as whisper.rs's NSEvent monitors).
        unsafe { NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency() }
    }
    #[cfg(target_os = "ios")]
    {
        // UIKit C symbol — present in every iOS process; no header dance.
        extern "C" {
            fn UIAccessibilityIsReduceTransparencyEnabled() -> bool;
        }
        unsafe { UIAccessibilityIsReduceTransparencyEnabled() }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}
