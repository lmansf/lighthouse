//! Desktop-only shell surfaces (add-mobile-apps §2): tray + menus, the
//! floating widget + summon shortcuts, whisper mode, autostart,
//! single-instance, window-state, the boot guard, llama supervision, and the
//! notify-only updater loop. The whole module is `#[cfg(desktop)]` — on the
//! iOS/Android targets none of this exists and the portable spine in `lib.rs`
//! is the entire shell. Bodies are byte-identical to the pre-split `lib.rs`;
//! only the module boundaries are new.

pub mod boot_guard;
pub mod supervise;
pub mod tray;
pub mod whisper;
pub mod widget;

use tauri::tray::TrayIconBuilder;
use tauri::Manager;

use supervise::{Supervisor, UpdateState};
use widget::{
    conserve_enabled, ensure_widget_window, hide_widget, launched_by_autostart,
    register_summon_shortcut, resume_servers, set_widget_resident, show_widget, widget_held,
    widget_mode, widget_pinned, widget_resident, HotkeyOk, MainIdleEpoch, WidgetFocusEpoch,
    WidgetHold, WidgetPin, WidgetResident, IDLE_SUSPEND_GRACE_SECS, WIDGET_LABEL,
};

use crate::{has_bundled_ui, main_window, read_settings, shell_log};

/// Desktop-only builder wiring: the desktop plugins (single-instance,
/// autostart, window-state, global-shortcut), the widget/supervision managed
/// state, and the menu + window event handlers.
pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A login autostart firing while we're already running should stay
            // silent; a user double-clicking the app icon expects their mode's
            // primary surface to appear.
            if args.iter().any(|a| a == "--autostarted") {
                return;
            }
            // Fall back to main when no widget window exists (dev/server mode).
            if widget_mode(app) && app.get_webview_window(WIDGET_LABEL).is_some() {
                show_widget(app, true);
            } else if let Some(win) = main_window(app) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Lets the running app tell a login launch from a user launch.
            Some(vec!["--autostarted"]),
        ))
        // Remember window size/position/maximized across restarts — a basic
        // desktop convention the shell was missing (every launch reopened at
        // the built-in 1280x820 in an OS-chosen spot). VISIBLE is excluded:
        // the plugin re-shows any window whose state saved visible, which
        // would override the uiMode launch decision in setup(). The widget is
        // denylisted outright — its height is contents-driven and it must
        // always start hidden; its position is persisted in settings instead.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::VISIBLE),
                )
                .with_denylist(&[WIDGET_LABEL])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Supervisor::default())
        .manage(UpdateState::default())
        .manage(WidgetPin::default())
        .manage(WidgetResident::default())
        .manage(WidgetHold::default())
        .manage(WidgetFocusEpoch::default())
        .manage(MainIdleEpoch::default())
        .manage(HotkeyOk::default())
        .on_menu_event(|app, event| tray::handle_menu(app, event.id().as_ref()))
        .on_window_event(on_window_event)
}

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        // Closing hides to tray instead of quitting (persistent app);
        // for the widget, "close" and "dismiss" are the same gesture
        // (routed through hide_widget so its position is remembered).
        // The explorer is the exception: a lazily-created satellite
        // window that genuinely closes (recreated on next 📁).
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if window.label() == widget::EXPLORER_LABEL {
                return;
            }
            api.prevent_close();
            if window.label() == WIDGET_LABEL {
                hide_widget(window.app_handle());
            } else {
                let _ = window.hide();
                // Hidden to the tray = clearly not in use: suspend the
                // local model servers now (desktop mode + conserve on),
                // freeing their RAM/CPU immediately rather than after
                // the unfocus grace. resume on next focus/show.
                let app = window.app_handle();
                if conserve_enabled(app) && !widget_mode(app) {
                    if let Some(sup) = app.try_state::<Supervisor>() {
                        sup.suspend();
                    }
                }
            }
        }
        // Spotlight-style dismissal: an UNPINNED search bar hides
        // when it loses focus; the 📌 pin keeps it up. Deferred via
        // the focus epoch: Windows fires a spurious window-level blur
        // while handing focus to the WebView2 child (see
        // WidgetFocusEpoch), so hide only if no focus edge follows.
        tauri::WindowEvent::Focused(focused) if window.label() == WIDGET_LABEL => {
            let app = window.app_handle().clone();
            let Some(epoch) = app.try_state::<WidgetFocusEpoch>() else {
                return;
            };
            let seen = epoch.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if !focused && !widget_pinned(&app) && !widget_held(&app) && !widget_resident(&app)
            {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let unchanged = app
                        .state::<WidgetFocusEpoch>()
                        .0
                        .load(std::sync::atomic::Ordering::Relaxed)
                        == seen;
                    if unchanged
                        && !widget_pinned(&app)
                        && !widget_held(&app)
                        && !widget_resident(&app)
                    {
                        hide_widget(&app);
                    }
                });
            }
        }
        // Background-conserve: the main window going idle (unfocused
        // past the grace) suspends the local model servers to free
        // their RAM/CPU; focusing it brings them back. Desktop mode
        // only — widget mode keeps the model warm for instant summon.
        // Epoch-debounced so ordinary alt-tabbing never suspends (and
        // so never pays a re-warm on return).
        tauri::WindowEvent::Focused(focused) if window.label() == "main" => {
            let app = window.app_handle().clone();
            if !conserve_enabled(&app) || widget_mode(&app) {
                return;
            }
            let Some(epoch) = app.try_state::<MainIdleEpoch>() else {
                return;
            };
            let seen =
                epoch.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if *focused {
                resume_servers(&app);
            } else {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(
                        IDLE_SUSPEND_GRACE_SECS,
                    ))
                    .await;
                    // Suspend only if no focus edge has landed since
                    // (epoch unchanged) and the window isn't focused now.
                    let unchanged = app
                        .state::<MainIdleEpoch>()
                        .0
                        .load(std::sync::atomic::Ordering::Relaxed)
                        == seen;
                    let refocused = app
                        .get_webview_window("main")
                        .and_then(|w| w.is_focused().ok())
                        .unwrap_or(false);
                    if unchanged && !refocused {
                        if let Some(sup) = app.try_state::<Supervisor>() {
                            sup.suspend();
                        }
                    }
                });
            }
        }
        _ => {}
    }
}

/// The desktop half of `run()`'s setup: autostart consent, app menu + tray,
/// the widget boot surface, the launch presentation, the safe-mode dialog,
/// the boot-guard ready timer, hotkey + whisper registration, and the
/// supervision + update loops. Called from the portable setup after
/// `bootstrap_env`; `smoke` mirrors LIGHTHOUSE_SMOKE=1 (release-smoke.yml),
/// under which the two background egress/spawn sources stay off.
pub fn setup(app: &tauri::App, smoke: bool) -> tauri::Result<()> {
    let handle = app.handle().clone();

    // Launch at login is CONSENT-FIRST: only touch the OS autostart
    // registration once the user has answered the startup prompt
    // (startupAsked). Earlier builds registered autostart on first boot
    // before ever asking — undo that premature registration here so
    // unasked users are not silently enrolled.
    {
        let s = read_settings(&handle);
        let asked = s["startupAsked"].as_bool() == Some(true);
        if asked {
            widget::apply_autostart(&handle, s["runOnStartup"].as_bool() != Some(false));
        } else {
            widget::apply_autostart(&handle, false);
        }
    }

    // App menu + tray.
    if let Ok(menu) = tray::build_app_menu(&handle) {
        let _ = app.set_menu(menu);
    }
    let mut tray_builder = TrayIconBuilder::with_id("main-tray").tooltip("Lighthouse");
    // macOS menubar: use the monochrome Beam mark as a *template*
    // image (black + alpha only — AppKit re-tints it, so the glyph
    // stays legible on light and dark menubars alike). The
    // full-color app icon would render as a dark smudge there.
    // `icon_as_template` is a macOS-only attribute in tauri 2
    // (`TrayIconBuilder::icon_as_template(mut self, is_template:
    // bool) -> Self`); other platforms keep the bundled window icon.
    #[cfg(target_os = "macos")]
    {
        match tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-template.png")) {
            Ok(template) => tray_builder = tray_builder.icon(template).icon_as_template(true),
            Err(e) => {
                // Only reachable if the compiled-in PNG is broken —
                // fall back to the window icon over an empty tray.
                shell_log(&handle, &format!("tray: template icon failed to decode: {e}"));
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray_builder = tray_builder.icon(icon);
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon().cloned() {
            tray_builder = tray_builder.icon(icon);
        }
    }
    let tray = tray_builder
        // Platform convention: LEFT click raises the app; the menu is
        // for right-click only. (Without this, Windows opened the menu
        // AND raised the window on the same left click.)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(win) = main_window(tray.app_handle()) {
                    let _ = win.show();
                    let _ = win.set_focus();
                    // Bringing the app back from the tray resumes the
                    // local servers even if programmatic focus doesn't
                    // emit Focused(true) on this platform.
                    resume_servers(tray.app_handle());
                }
            }
        })
        .build(app)?;
    let _ = tray; // menu attached below (needs managed UpdateState)
    tray::rebuild_tray_menu(&handle);

    // --- Desktop widget (docs/widget-scope.md §7 W1): in widget mode
    // it IS the launch surface, so it's created now. In window mode
    // its creation is DEFERRED a few seconds — a second webview at
    // t=0 doubles the first-launch process storm (WebView2 spawns a
    // family of processes per webview, all under antivirus scrutiny
    // on an unsigned first run) — and skipped entirely in safe mode;
    // every summon path also creates it on demand via ensure_widget_window.
    if widget_mode(&handle) {
        ensure_widget_window(&handle);
    } else if !boot_guard::safe_mode() {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            ensure_widget_window(&handle);
        });
    }

    // Launch presentation. The main window is configured hidden and
    // ONE surface is raised here by the user's uiMode: the classic
    // window (default, and always the fallback when no widget window
    // exists — e.g. dev server mode), or the experimental desktop
    // widget, pinned so it survives losing focus. Login autostarts
    // never steal focus.
    {
        let focus = !launched_by_autostart();
        let want_widget = widget_mode(&handle);
        shell_log(
            &handle,
            &format!(
                "boot v{} safe_mode={} sticky={} widget_mode={} bundled_ui={} widget_window={}",
                env!("CARGO_PKG_VERSION"),
                boot_guard::safe_mode(),
                boot_guard::sticky(),
                want_widget,
                has_bundled_ui(&handle),
                handle.get_webview_window(WIDGET_LABEL).is_some(),
            ),
        );
        if want_widget && handle.get_webview_window(WIDGET_LABEL).is_some() {
            // Resident, NOT pinned: the bar is the app's resting
            // presence (blur keeps it around) but stacks normally —
            // other windows may cover it; the hotkey raises it.
            set_widget_resident(&handle, true);
            show_widget(&handle, focus);
        } else if let Some(win) = main_window(&handle) {
            if want_widget {
                // Widget mode is ON but the bar couldn't be created:
                // fall back visibly instead of silently (0.6.3 field
                // report — the silence made this undiagnosable).
                shell_log(&handle, "boot: widget mode is on but the bar is unavailable — falling back to the window");
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                handle
                    .dialog()
                    .message(
                        "Widget mode couldn't start on this launch, so the main window opened instead.\n\nA diagnostic was written to shell.log in Lighthouse's app-data folder — please share that file if this keeps happening.",
                    )
                    .title("Lighthouse — widget mode")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
            let _ = win.show();
            if focus {
                let _ = win.set_focus();
            }
        }
    }

    // Safe mode was invisible: a launch that dies young (a machine
    // freeze — or, far more commonly since 0.6.x, an installer's
    // hard-kill mid-update) flips the next boot into safe mode and a
    // sticky lock keeps EVERY boot of this version there, with
    // reduced rendering and background features off, and nothing on
    // screen ever says so. Say so, and offer the way out.
    if boot_guard::safe_mode() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let h = handle.clone();
        handle
            .dialog()
            .message(
                "Lighthouse started in safe mode because a previous launch was interrupted before it finished starting (an update or forced shutdown can look like this).\n\nSafe mode uses basic graphics and skips background features until it's turned off.\n\nLeave safe mode? This applies on the next launch.",
            )
            .title("Lighthouse — safe mode")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Leave safe mode".into(),
                "Stay in safe mode".into(),
            ))
            .show(move |leave| {
                if leave {
                    boot_guard::clear_safe_mode();
                    shell_log(&h, "safe-mode: user chose to leave — normal boot next launch");
                } else {
                    shell_log(&h, "safe-mode: user chose to stay");
                }
            });
    }

    // The launch is declared healthy 20 s in — a machine-freezing
    // boot never gets there, and the NEXT launch then comes up in
    // safe mode (see boot_guard.rs). Clean exits also mark ready.
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        boot_guard::mark_ready();
    });

    // Tier-1 summon hotkey — the user's keyed chord from settings
    // (recordable in Preferences; the modifier-only tap lives in
    // whisper.rs). Registered here rather than via the plugin builder
    // so a failure — expected on Wayland, where the X11-only backend
    // can't register anything — degrades to the tray's "Show search
    // bar" item instead of failing the launch.
    register_summon_shortcut(&handle);

    // W3 Whisper mode: the opt-in modifier-only tap chord. Only ever
    // active when the user enabled it in Preferences (whisper.rs).
    // Safe mode leaves the keyboard hook out — a global input hook is
    // precisely what to rule out while diagnosing a frozen machine.
    // Managed policy widgetHotkeys "off": the hook is NEVER installed
    // (not installed-then-disabled), regardless of the user setting.
    if !boot_guard::safe_mode()
        && lighthouse_core::policy::hotkeys_allowed()
        && read_settings(&handle)["whisperMode"].as_bool() == Some(true)
    {
        whisper::set_enabled(&handle, true);
        // A login-time install can fail transiently (security tooling
        // scrutinizes hooks hardest in a boot's first seconds, login
        // autostarts especially). One quiet retry half a minute in
        // rescues that case; a still-failed hook is surfaced in
        // Preferences via whisperPermission = "failed" instead of
        // leaving the toggle ON over a chord that never fires.
        let handle2 = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if whisper::permission_state() == "failed"
                && read_settings(&handle2)["whisperMode"].as_bool() == Some(true)
            {
                whisper::set_enabled(&handle2, true);
            }
        });
    }

    // llama-server supervision: start now if a model is installed, and
    // reconcile every 3 s (downloads landing, uninstall handshake).
    if !smoke {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                handle.state::<Supervisor>().reconcile(&handle);
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
        });
    }

    // Notify-only update check, parallel and best-effort: once at
    // boot, then every 6 h. The app is tray-resident for days at a
    // time, so a boot-only check never noticed releases that shipped
    // mid-run — the banner/tray notice simply never appeared until
    // the next manual restart.
    if !smoke {
        let handle = handle.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                supervise::check_for_updates(handle.clone()).await;
                tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
            }
        });
    }

    Ok(())
}

/// Desktop arms of the run-event loop: remember the widget position and shut
/// the supervised servers down on exit; macOS Dock-click reopen. The portable
/// side (index flush) lives in `run()` itself.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    match event {
        tauri::RunEvent::Exit => {
            widget::save_widget_pos(app); // quitting with the bar up still remembers its spot
            boot_guard::mark_ready(); // an orderly exit is a healthy launch
            app.state::<Supervisor>().shutdown();
        }
        // macOS: clicking the Dock icon while the window is hidden to
        // the tray must bring it back — without this the app looked
        // permanently gone (the Dock was the one place users tried).
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(win) = main_window(app) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        _ => {}
    }
}
