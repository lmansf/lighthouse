//! Desktop widget + explorer windows (docs/widget-scope.md), the summon
//! hotkey, and the background-conserve plumbing — desktop-only surfaces
//! (add-mobile-apps §2: compiled out on iOS/Android, where there is no
//! floating bar, no global hotkey, and no llama supervision to conserve).
//! Bodies are byte-identical to the pre-split `lib.rs`; only the module
//! boundary is new.

use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::supervise::Supervisor;
use crate::{has_bundled_ui, main_window, read_settings, shell_log, write_settings, ServerPort};

/// Desktop widget (docs/widget-scope.md §7): window label, collapsed size,
/// and the pin flag that decides whether losing focus hides the bar.
pub const WIDGET_LABEL: &str = "widget";
pub const WIDGET_WIDTH: f64 = 560.0;
const WIDGET_HEIGHT: f64 = 56.0;

/// W2: the standalone vault-explorer window (widget 📁 button). Unlike main
/// and the widget it is created lazily and REALLY closes — it's a satellite
/// view, not a resident surface.
pub const EXPLORER_LABEL: &str = "explorer";

/// Open (or raise) the vault-explorer window.
pub fn open_explorer(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(EXPLORER_LABEL) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let port = app
        .try_state::<ServerPort>()
        .map(|p| p.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(0);
    let url = if has_bundled_ui(app) {
        tauri::WebviewUrl::App("explorer".into())
    } else if port != 0 {
        match format!("http://127.0.0.1:{port}/explorer").parse() {
            Ok(u) => tauri::WebviewUrl::External(u),
            Err(_) => return,
        }
    } else {
        // No bundled assets and the loopback server isn't up yet (dev/server
        // mode boot). Say so — a silently swallowed click reads as a dead
        // button (this exact silence hid a broken path during live testing).
        eprintln!("explorer: UI not ready yet (no bundled assets, server still starting)");
        return;
    };
    let built = tauri::WebviewWindowBuilder::new(app, EXPLORER_LABEL, url)
        .title("Lighthouse — Vault")
        .inner_size(760.0, 640.0)
        .min_inner_size(480.0, 400.0)
        .center()
        .build();
    match built {
        Err(e) => eprintln!("explorer window failed to build: {e}"),
        Ok(w) => strip_gtk_menubar(&w),
    }
}

/// On GTK the app-wide menu gets attached to EVERY window, so the frameless
/// search bar and the explorer sprout a stray "File Edit" strip. Satellite
/// windows carry no menu — remove it (a no-op elsewhere).
#[allow(unused_variables)]
fn strip_gtk_menubar(w: &tauri::WebviewWindow) {
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = w.remove_menu();
}

/// Pinned = the user's explicit "keep above other windows" toggle: always-on-
/// top AND immune to blur auto-hide. Managed state so the blur handler and
/// the widget_set_pin command agree.
#[derive(Default)]
pub struct WidgetPin(std::sync::atomic::AtomicBool);

/// Resident = widget mode's resting presence: the bar LIVES on the desktop
/// (blur must not dismiss it) but in NORMAL stacking — other windows may
/// cover it, and the summon hotkey raises it back. Distinct from the pin:
/// residency is set by the interface mode, always-on-top only by the user.
#[derive(Default)]
pub struct WidgetResident(std::sync::atomic::AtomicBool);

pub fn set_widget_resident(app: &AppHandle, resident: bool) {
    if let Some(state) = app.try_state::<WidgetResident>() {
        state.0.store(resident, std::sync::atomic::Ordering::Relaxed);
    }
}

pub(crate) fn widget_resident(app: &AppHandle) -> bool {
    app.try_state::<WidgetResident>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Whether the keyed summon hotkey actually registered — false on Wayland,
/// where the X11-only backend can't grab anything. settings_get exposes it so
/// the UI can swap its hotkey promises for the tray fallback instead of
/// advertising a shortcut the shell already knows is dead.
#[derive(Default)]
pub struct HotkeyOk(pub std::sync::atomic::AtomicBool);

/// Hold = the widget is showing an inline answer ("frozen" compact chat).
/// The blur auto-hide respects it like a temporary pin, so users can click
/// into their document while reading; Esc/✕ still dismiss explicitly.
#[derive(Default)]
pub struct WidgetHold(pub std::sync::atomic::AtomicBool);

pub(crate) fn widget_held(app: &AppHandle) -> bool {
    app.try_state::<WidgetHold>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Focus-edge counter that turns hide-on-blur into "hide only if focus
/// STAYS gone". On Windows the top-level window loses native focus the
/// moment WebView2's child control takes it (WM_KILLFOCUS on the parent,
/// and wry moves focus programmatically on every activation), so a literal
/// hide-on-blur dismissed the bar the instant it was summoned. Every focus
/// edge bumps the epoch; a blur only hides when no edge follows within the
/// grace window. The runtime then synthesizes Focused(true) from the
/// webview's own GotFocus, which lands well inside the grace period.
#[derive(Default)]
pub struct WidgetFocusEpoch(pub(crate) std::sync::atomic::AtomicU64);

/// Debounces the main window's "backgrounded" idle timer (background-conserve).
/// Bumped on every main-window focus edge; a blur arms a delayed suspend keyed
/// to the value it saw, so a re-focus (or another blur) before the grace
/// elapses cancels the pending suspend. Same epoch trick as WidgetFocusEpoch.
#[derive(Default)]
pub struct MainIdleEpoch(pub(crate) std::sync::atomic::AtomicU64);

/// How long the main window may sit unfocused before background-conserve
/// suspends the local model servers. Long enough that ordinary alt-tabbing
/// never pays a re-warm; short enough that leaving the app in the background
/// genuinely frees resources. Hiding to the tray suspends immediately instead.
pub(crate) const IDLE_SUSPEND_GRACE_SECS: u64 = 120;

/// Whether background-conserve is on (default true): idle/hidden desktop windows
/// release the llama-server RAM+CPU. Off keeps the old always-resident behavior.
pub(crate) fn conserve_enabled(app: &AppHandle) -> bool {
    read_settings(app)["backgroundConserve"].as_bool() != Some(false)
}

/// Bring the local servers back after a background-conserve suspend and kick a
/// reconcile so they respawn immediately rather than on the next 3 s tick.
/// No-op unless actually suspended, so ordinary focus edges stay cheap.
pub fn resume_servers(app: &AppHandle) {
    if let Some(sup) = app.try_state::<Supervisor>() {
        if sup.is_suspended() {
            sup.resume();
            sup.reconcile(app);
        }
    }
}

pub fn set_widget_pinned(app: &AppHandle, pinned: bool) {
    if let Some(state) = app.try_state::<WidgetPin>() {
        state.0.store(pinned, std::sync::atomic::Ordering::Relaxed);
    }
}

pub(crate) fn widget_pinned(app: &AppHandle) -> bool {
    app.try_state::<WidgetPin>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Create the (hidden) widget window if it doesn't exist yet — idempotent,
/// meaningful only with a bundled UI (the /widget static route). Normally
/// called shortly after boot so the first summon is instant, but every
/// summon path also calls it, so a deferred or skipped boot creation (safe
/// mode) just means the first summon pays the webview spin-up.
/// Note: skip_taskbar is a no-op on macOS and visible_on_all_workspaces is
/// unsupported on Windows — both are best-effort per platform.
pub fn ensure_widget_window(app: &AppHandle) {
    if app.get_webview_window(WIDGET_LABEL).is_some() {
        return;
    }
    if !has_bundled_ui(app) {
        shell_log(app, "widget: creation skipped — bundled-UI marker not found in assets");
        return;
    }
    // NOT always-on-top: the bar rests just above the desktop in normal
    // stacking — other windows may cover it; summoning raises it (and the
    // user's pin opts into true always-on-top). A permanently-topmost bar
    // fought every other window on screen.
    let built =
        tauri::WebviewWindowBuilder::new(app, WIDGET_LABEL, tauri::WebviewUrl::App("widget".into()))
            .title("Lighthouse Search")
            .inner_size(WIDGET_WIDTH, WIDGET_HEIGHT)
            .decorations(false)
            .resizable(false)
            .always_on_top(false)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .build();
    match built {
        Err(e) => {
            eprintln!("widget window failed to build: {e}");
            shell_log(app, &format!("widget: window failed to build: {e}"));
        }
        Ok(w) => {
            shell_log(app, "widget: window created");
            strip_gtk_menubar(&w);
            // Hand-rolled position memory (see the window-state denylist
            // note). A stale off-screen position is healed by show_widget's
            // re-center check.
            if let Some(pos) = read_settings(app)["widgetPos"].as_array() {
                if let (Some(x), Some(y)) = (
                    pos.first().and_then(Value::as_i64),
                    pos.get(1).and_then(Value::as_i64),
                ) {
                    let _ = w.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                }
            }
        }
    }
}

/// Show the floating search bar. Placement rule: if the user has DRAGGED it
/// to a spot on the screen it's appearing on, keep that (per-screen drag
/// memory). Otherwise — first launch, or summoning onto a screen it's never
/// been dragged on — CENTER it on that screen (where the cursor is, else the
/// current/primary monitor). A position off every monitor (unplugged display)
/// still heals via center(). `focus` is false only for the polite widget-mode
/// boot at OS login.
pub fn show_widget(app: &AppHandle, focus: bool) {
    ensure_widget_window(app); // lazy in safe mode / the first seconds of boot
    let Some(w) = app.get_webview_window(WIDGET_LABEL) else {
        shell_log(app, "widget: show requested but the window is missing (see creation lines above)");
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        // A remembered drag position, if any (ensure_widget_window applied it).
        let saved = read_settings(app)["widgetPos"].as_array().and_then(|a| {
            match (
                a.first().and_then(Value::as_i64),
                a.get(1).and_then(Value::as_i64),
            ) {
                (Some(x), Some(y)) => Some((x as i32, y as i32)),
                _ => None,
            }
        });
        // Appear on the cursor's screen, else the one the window is on, else
        // the primary — never nowhere.
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| w.current_monitor().ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        if let Some(m) = monitor {
            let (mx, my) = (m.position().x, m.position().y);
            let (mw, mh) = (m.size().width as i32, m.size().height as i32);
            let saved_here =
                saved.is_some_and(|(x, y)| x >= mx && x < mx + mw && y >= my && y < my + mh);
            if !saved_here {
                // No drag memory for this screen → center the pill on it.
                let width = (WIDGET_WIDTH * m.scale_factor()) as i32;
                let height = (WIDGET_HEIGHT * m.scale_factor()) as i32;
                let x = mx + (mw - width) / 2;
                let y = my + (mh - height) / 2;
                let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    }
    if w.current_monitor().ok().flatten().is_none() {
        let _ = w.center();
    }
    // RAISE, don't just show: the bar lives in normal stacking now, so a
    // summon must bring it over whatever covers it. The momentary
    // always-on-top pulse is the reliable Windows raise (plain focus can be
    // refused when the request comes from a background process, e.g. the
    // whisper hook; dropping TOPMOST keeps the window at the top of the
    // normal band there). set_focus comes LAST because on GTK it maps to
    // gtk_window_present — the actual raise — and some WMs re-lower the
    // window when the ABOVE state is removed.
    let _ = w.set_always_on_top(true);
    let _ = w.show();
    if !widget_pinned(app) {
        let _ = w.set_always_on_top(false);
    }
    if focus {
        let _ = w.set_focus();
        // Windows: set_focus alone can be REFUSED when the summon comes from
        // a background context (global hotkey, whisper hook) — the bar raises
        // but keystrokes and hands-free dictation keep flowing to the
        // previous app. Force the switch the way launchers do; must run on
        // the thread that owns the HWND (the main thread).
        #[cfg(windows)]
        {
            let w = w.clone();
            let _ = app.run_on_main_thread(move || force_keyboard_focus(&w));
        }
    }
}

/// Windows: make a summoned window genuinely take keyboard focus. A plain
/// SetForegroundWindow from a background process is refused by the OS
/// foreground lock. The launcher trick (PowerToys Run, Flow Launcher):
/// briefly attach our input thread to the current foreground window's
/// thread — the switch then counts as legitimate — hand focus over, and
/// detach. The webview receives WM_SETFOCUS, the page fires `focus`, and
/// WidgetBar puts the caret in the (select-all'd) input, so dictation lands
/// in the box with no click. Call on the main thread only.
#[cfg(windows)]
fn force_keyboard_focus(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let fg = GetForegroundWindow();
        if fg == hwnd {
            return; // already foreground — nothing to force
        }
        let our_thread = GetCurrentThreadId();
        let fg_thread = if fg.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, std::ptr::null_mut())
        };
        let attached = fg_thread != 0
            && fg_thread != our_thread
            && AttachThreadInput(our_thread, fg_thread, 1) != 0;
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        SetFocus(hwnd);
        if attached {
            AttachThreadInput(our_thread, fg_thread, 0);
        }
    }
}

/// Dismiss the widget, remembering where the user dragged it (the widget is
/// denylisted from the window-state plugin — its size is contents-driven and
/// it must never restore visible — so position is persisted by hand here).
pub fn hide_widget(app: &AppHandle) {
    let Some(w) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    save_widget_pos(app);
    // An explicit dismiss also releases the inline-answer hold — a stale
    // hold must never make the next summon un-dismissable.
    if let Some(hold) = app.try_state::<WidgetHold>() {
        hold.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    let _ = w.hide();
}

pub(crate) fn save_widget_pos(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WIDGET_LABEL) {
        if let Ok(p) = w.outer_position() {
            write_settings(app, serde_json::json!({ "widgetPos": [p.x, p.y] }));
        }
    }
}

/// Summon (or dismiss) the floating search bar — the hotkey/tray gesture.
/// Summoning means "the bar INSTEAD of the window": a visible main window is
/// tucked into the taskbar first so the pill is unmistakably the surface in
/// charge (and can't sit lost behind or under the full app).
pub fn toggle_widget(app: &AppHandle) {
    let Some(w) = app.get_webview_window(WIDGET_LABEL) else {
        // Lazy boot paths (safe mode) may not have built it yet — summoning
        // is the demand. show_widget creates it on the spot.
        show_widget(app, true);
        return;
    };
    if w.is_visible().unwrap_or(false) {
        // Visible AND focused → the user is looking at it: dismiss.
        // Visible but BURIED/unfocused (normal stacking lets other windows
        // cover the resident bar) → the summon means "bring it to me":
        // raise + focus instead of hiding it out from under them.
        if w.is_focused().unwrap_or(false) {
            hide_widget(app);
        } else {
            show_widget(app, true);
        }
        return;
    }
    if let Some(main) = main_window(app) {
        if main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false) {
            let _ = main.minimize();
        }
    }
    show_widget(app, true);
}

/// "widget" = the experimental desktop-widget presentation: the floating
/// search bar IS the app at launch and the main window stays in the tray.
/// Anything else (including unset — the first-run chooser not yet answered)
/// behaves as the classic window mode.
pub(crate) fn widget_mode(app: &AppHandle) -> bool {
    read_settings(app)["uiMode"].as_str() == Some("widget")
}

/// Whether this process was started by the OS login autostart entry (the
/// registration passes --autostarted). Used to avoid stealing focus at login.
pub(crate) fn launched_by_autostart() -> bool {
    std::env::args().any(|a| a == "--autostarted")
}

/// (Re)register the keyed summon chord from settings — at boot and whenever
/// Preferences records a new one. Drops any previous registration first;
/// HotkeyOk mirrors the outcome for the UI's copy (false on Wayland, or for
/// a chord some other app already owns).
pub fn register_summon_shortcut(app: &AppHandle) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    // Managed policy: widgetHotkeys "off" means the shortcut is never
    // registered — covering boot AND every Preferences re-record path.
    if !lighthouse_core::policy::hotkeys_allowed() {
        return false;
    }
    let gs = app.global_shortcut();
    let _ = gs.unregister_all(); // ours is the only registration in this app
    let accel = read_settings(app)["summonShortcut"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| lighthouse_core::settings::DEFAULT_SUMMON_SHORTCUT.to_string());
    let ok = gs
        .on_shortcut(accel.as_str(), |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_widget(app);
            }
        })
        .is_ok();
    if !ok {
        eprintln!("summon shortcut \"{accel}\" unavailable; use the tray's \"Show search bar\"");
    }
    if let Some(state) = app.try_state::<HotkeyOk>() {
        state.0.store(ok, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

// §40: open_with_os moved to lighthouse-shell (the moved open_node body calls
// it); re-exported here so `super::widget::open_with_os` (tray) and the
// `crate::open_with_os` glob path (supervise, commands) stay valid.
pub use lighthouse_shell::open_with_os;

/// Reveal a path in the OS file manager, *selecting* it inside its containing
/// folder where the platform supports that (Windows Explorer, macOS Finder).
/// Linux has no portable "select the file" verb, so we open the containing
/// folder instead — the closest honest equivalent. Best-effort like
/// `open_with_os`: a missing file manager never crashes the caller.
pub fn reveal_with_os(abs: &Path) {
    let mut command = if cfg!(windows) {
        // Explorer parses its own command line; the reliable form is a single
        // "/select,<path>" argument (splitting it into "/select," + path drops
        // the selection). A non-file path just opens Explorer at a default.
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(format!("/select,{}", abs.display()));
        c
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(abs.as_os_str());
        c
    } else {
        // No portable Linux "reveal + select" — open the containing directory.
        let dir = if abs.is_dir() { abs } else { abs.parent().unwrap_or(abs) };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir.as_os_str());
        c
    };
    let _ = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

pub fn apply_autostart(app: &AppHandle, enable: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let _ = if enable {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
}
