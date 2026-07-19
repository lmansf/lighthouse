//! Lighthouse desktop shell (Tauri 2) — Phase 3 of docs/rewrite-scope.md.
//!
//! Replaces electron/main.js: window + tray (close hides, quit from tray),
//! native Add/Link/Choose-vault dialogs, launch-at-login, single instance,
//! llama-server supervision with the uninstall marker handshake, and a
//! notify-only update check. The engine runs IN-PROCESS: with a bundled UI
//! (`scripts/build-ui-static.mjs` → `ui-dist/` + `.lighthouse-ui` marker) all
//! data flows over Tauri IPC and no TCP port exists (Phase 4); without one, an
//! embedded loopback server + the same per-launch token serve the Next UI
//! exactly like the Electron shell did (LIGHTHOUSE_SERVE=1 forces this).

mod boot_guard;
mod commands;
mod supervise;
mod whisper;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use supervise::{Supervisor, UpdateState, RELEASE_PAGE_URL};

/// Desktop widget (docs/widget-scope.md §7): window label, collapsed size,
/// and the pin flag that decides whether losing focus hides the bar.
pub const WIDGET_LABEL: &str = "widget";
pub const WIDGET_WIDTH: f64 = 560.0;
const WIDGET_HEIGHT: f64 = 56.0;

/// W2: the standalone vault-explorer window (widget 📁 button). Unlike main
/// and the widget it is created lazily and REALLY closes — it's a satellite
/// view, not a resident surface.
pub const EXPLORER_LABEL: &str = "explorer";

/// Port of the embedded loopback server, when one is running (no bundled UI
/// or LIGHTHOUSE_SERVE=1). Lazily-created windows need it to build their URL;
/// 0 = no server, use the bundled-asset route.
#[derive(Default)]
pub struct ServerPort(std::sync::atomic::AtomicU16);

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

fn widget_resident(app: &AppHandle) -> bool {
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

fn widget_held(app: &AppHandle) -> bool {
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
pub struct WidgetFocusEpoch(std::sync::atomic::AtomicU64);

/// Debounces the main window's "backgrounded" idle timer (background-conserve).
/// Bumped on every main-window focus edge; a blur arms a delayed suspend keyed
/// to the value it saw, so a re-focus (or another blur) before the grace
/// elapses cancels the pending suspend. Same epoch trick as WidgetFocusEpoch.
#[derive(Default)]
pub struct MainIdleEpoch(std::sync::atomic::AtomicU64);

/// How long the main window may sit unfocused before background-conserve
/// suspends the local model servers. Long enough that ordinary alt-tabbing
/// never pays a re-warm; short enough that leaving the app in the background
/// genuinely frees resources. Hiding to the tray suspends immediately instead.
const IDLE_SUSPEND_GRACE_SECS: u64 = 120;

/// Whether background-conserve is on (default true): idle/hidden desktop windows
/// release the llama-server RAM+CPU. Off keeps the old always-resident behavior.
fn conserve_enabled(app: &AppHandle) -> bool {
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

fn widget_pinned(app: &AppHandle) -> bool {
    app.try_state::<WidgetPin>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Append a timestamped line to app-data/shell.log — the debugging lifeline
/// for GUI builds, where stderr goes nowhere (0.6.3 field report: widget mode
/// silently absent on one Windows machine, zero clues). Rotates once past
/// ~256 KB (shell.log → shell.log.1) so it can run forever. Best-effort.
pub fn shell_log(app: &AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("shell.log");
    if fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("shell.log.1"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = writeln!(f, "[{}] {}", lighthouse_core::config::now_ms(), msg);
    }
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

fn save_widget_pos(app: &AppHandle) {
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
fn widget_mode(app: &AppHandle) -> bool {
    read_settings(app)["uiMode"].as_str() == Some("widget")
}

/// Whether this process was started by the OS login autostart entry (the
/// registration passes --autostarted). Used to avoid stealing focus at login.
fn launched_by_autostart() -> bool {
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

/// Launch the platform's default opener for a path, detached.
pub fn open_with_os(abs: &Path) {
    let (cmd, arg) = if cfg!(windows) {
        ("explorer.exe", abs.as_os_str().to_owned())
    } else if cfg!(target_os = "macos") {
        ("open", abs.as_os_str().to_owned())
    } else {
        ("xdg-open", abs.as_os_str().to_owned())
    };
    let _ = std::process::Command::new(cmd)
        .arg(arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

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

/// The in-webview end-to-end probe for LIGHTHOUSE_SMOKE=1 (see the driver in
/// setup): list the vault, include the harness-seeded fixture, ask one
/// question through the intercepted window.fetch (the exact path a user's ask
/// takes in IPC mode), and assert the NDJSON stream ends in a done chunk that
/// cites the fixture and quotes its content. Retries the first fetch while
/// the transport is still installing. Verdict goes to the `smoke_report`
/// command, which turns it into the process exit code.
const SMOKE_DRIVER_JS: &str = r#"
(function () {
  var inv = function (p) { window.__TAURI_INTERNALS__.invoke('smoke_report', { payload: p }); };
  var tries = 0;
  var step = 'list';
  function start() {
    step = 'list';
    fetch('/api/rag').then(function (r) { return r.json(); }).then(function (j) {
      var nodes = j.nodes || [];
      var f = null;
      for (var i = 0; i < nodes.length; i++) {
        if (String(nodes[i].id).indexOf('smoke-fixture') >= 0) { f = nodes[i]; break; }
      }
      if (!f) { throw new Error('fixture not in vault list (nodes=' + nodes.length + ')'); }
      step = 'include';
      return fetch('/api/rag', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'include', nodeId: f.id, included: true })
      }).then(function () { return f; });
    }).then(function (f) {
      step = 'ask';
      return fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What is the Q3 revenue target?', includedFileIds: [f.id], history: [] })
      }).then(function (r) { return r.text(); });
    }).then(function (t) {
      step = 'assert';
      var lines = t.trim().split('\n');
      var last = JSON.parse(lines[lines.length - 1]);
      var answer = '';
      for (var i = 0; i < lines.length - 1; i++) {
        try { answer += (JSON.parse(lines[i]).delta || ''); } catch (e) {}
      }
      if (!last.done) { throw new Error('final chunk not done'); }
      var refs = last.references || [];
      if (!refs.length) { throw new Error('no references on final chunk'); }
      var cited = false;
      for (var i = 0; i < refs.length; i++) {
        if (String(refs[i].fileId).indexOf('smoke-fixture') >= 0) { cited = true; break; }
      }
      if (!cited) { throw new Error('references do not cite the fixture: ' + JSON.stringify(refs).slice(0, 200)); }
      if (answer.indexOf('42 million') < 0) { throw new Error('answer does not quote fixture content: ' + answer.slice(0, 160)); }
      inv('OK grounded answer: ' + refs.length + ' reference(s), ' + lines.length + ' stream lines');
    }).catch(function (e) {
      if (step === 'list' && ++tries < 30) { setTimeout(start, 1000); return; }
      inv('FAIL at ' + step + ': ' + String((e && e.message) || e));
    });
  }
  start();
})();
"#;

/// CI boot-smoke isolation (release-smoke.yml): when set, all install-scope
/// state (settings, models, connectors, profile, app state) lives under this
/// directory instead of the OS app-data dir, so a smoke run can never touch —
/// or be influenced by — a real install on the same machine.
fn smoke_state_dir() -> Option<PathBuf> {
    std::env::var("LIGHTHOUSE_SMOKE_STATE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn settings_file(app: &AppHandle) -> PathBuf {
    smoke_state_dir()
        .unwrap_or_else(|| {
            app.path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
        })
        .join("lighthouse-settings.json")
}

fn read_settings(app: &AppHandle) -> Value {
    fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// G5: fire the briefing-note OS notification, gated. Off when `briefingNotify`
/// is false (the note is still written), and — the "never wake from hidden"
/// rule — suppressed while the app is suspended (hidden to tray or idle-
/// suspended under background-conserve). The note write itself is unaffected.
fn maybe_notify(app: &AppHandle, n: usize) {
    use tauri_plugin_notification::NotificationExt;
    if read_settings(app)["briefingNotify"].as_bool() == Some(false) {
        return;
    }
    if app.try_state::<Supervisor>().map(|s| s.is_suspended()).unwrap_or(false) {
        return;
    }
    let body = format!("{n} pinned question{} changed.", if n == 1 { "" } else { "s" });
    let _ = app
        .notification()
        .builder()
        .title("Lighthouse Briefing updated")
        .body(body)
        .show();
}

fn write_settings(app: &AppHandle, patch: Value) {
    let mut s = read_settings(app);
    if let (Some(obj), Some(p)) = (s.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    let f = settings_file(app);
    if let Some(dir) = f.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Same atomic temp+rename writer the core uses — this file has TWO
    // writers (core's settings_set and this raw merge), and a plain
    // fs::write could tear or interleave with the other side's rename.
    lighthouse_core::config::write_json(&f, &s);
}

/// The local vault directory (persisted; defaults under the user's Documents).
/// Managed policy: a stored vaultDir that violates `vaultRoots` (a policy
/// that arrived AFTER the vault was chosen) is not applied — the app falls
/// back to an allowed location instead of silently indexing a forbidden
/// path at boot. Non-destructive: the old folder's files are untouched.
pub fn vault_dir_setting(app: &AppHandle) -> PathBuf {
    let from_settings = read_settings(app)["vaultDir"]
        .as_str()
        .map(PathBuf::from)
        .filter(|d| lighthouse_core::policy::vault_path_allowed(d));
    let dir = from_settings.unwrap_or_else(|| {
        let default = app
            .path()
            .document_dir()
            .unwrap_or_else(|_| {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir())
            })
            .join("Lighthouse Vault");
        if lighthouse_core::policy::vault_path_allowed(&default) {
            default
        } else {
            // Even the OS default is outside the allowlist: root the vault
            // under the first allowed prefix.
            lighthouse_core::policy::first_vault_root()
                .map(|r| r.join("Lighthouse Vault"))
                .unwrap_or(default)
        }
    });
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Wire the engine's environment before any core call (the core reads env per
/// call, so a later "Choose vault folder…" can re-point VAULT_DIR live).
fn bootstrap_env(app: &AppHandle) {
    std::env::set_var("LIGHTHOUSE_DESKTOP", "1");
    std::env::set_var("VAULT_DIR", vault_dir_setting(app));
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", settings_file(app));
    if let Some(data) = smoke_state_dir().or_else(|| app.path().app_data_dir().ok()) {
        let models = data.join("models");
        let connectors = data.join("connectors");
        let _ = fs::create_dir_all(&models);
        let _ = fs::create_dir_all(&connectors);
        std::env::set_var("LIGHTHOUSE_MODELS_DIR", &models);
        std::env::set_var("LIGHTHOUSE_CONNECTORS_DIR", &connectors);

        // The signed-in profile lives in this private data dir so it survives
        // vault moves / re-points (which otherwise stranded it and forced a
        // sign-in on every launch). One-time migration: if there's no profile
        // here yet but an earlier build left one inside the vault, carry it
        // over so returning users stay signed in.
        let _ = fs::create_dir_all(&data);
        let profile = data.join("profile.json");
        if !profile.exists() {
            let legacy = vault_dir_setting(app)
                .join(".rag-vault")
                .join("profile.json");
            if legacy.exists() {
                let _ = fs::copy(&legacy, &profile);
            }
        }
        std::env::set_var("LIGHTHOUSE_PROFILE_FILE", &profile);

        // Always-unlocked build: the licensing / accounts / registration system
        // is gone. Earlier builds migrated license, identity, and contact state
        // INTO this app-state dir (and kept trial/usage bookkeeping here); flip
        // that migrate-in to a best-effort CLEAN-UP so a machine upgrading to
        // this build doesn't leave stale unlock/telemetry files behind. Errors
        // are ignored (a missing file is the normal case). profile.json and
        // secrets.json are deliberately NOT removed — they hold the signed-in
        // profile and the sealed API keys the app still needs.
        for name in [
            "license.json",
            "identity.json",
            "contact.json",
            "launch.json",
            "usage.json",
            "usage-snapshot.json",
            "experiments.json",
            "activation.json",
        ] {
            let _ = fs::remove_file(data.join(name));
        }
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", &data);
    }
    // Bundled offline assets (llama-server). Packaged builds have
    // them under the resource dir; dev runs fall back to the repo's resources/.
    let resource_root = app
        .path()
        .resource_dir()
        .ok()
        .filter(|d| d.join("llm").exists());
    let dev_root = std::env::current_dir()
        .ok()
        .map(|d| d.join("../../../resources"))
        .filter(|d| d.exists());
    if let Some(root) = resource_root.or(dev_root) {
        std::env::set_var("LIGHTHOUSE_RESOURCES_PATH", root);
    }
}

/// Whether a real UI bundle is compiled in (Phase 4 IPC mode) — the static
/// build drops a `lighthouse-ui.json` marker beside its assets.
fn has_bundled_ui(app: &AppHandle) -> bool {
    app.asset_resolver()
        .get("/lighthouse-ui.json".into())
        .is_some()
        || app
            .asset_resolver()
            .get("lighthouse-ui.json".into())
            .is_some()
}

/// Embedded loopback API server (server-UI mode and web parity). Returns the
/// bound port once the server is accepting.
async fn start_embedded_server() -> anyhow::Result<u16> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    std::env::set_var("LIGHTHOUSE_API_TOKEN", &token);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, lighthouse_server::app()).await {
            eprintln!("embedded server exited: {e}");
        }
    });
    Ok(port)
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// (Re)build the tray menu, surfacing an update notice when one is known.
pub fn rebuild_tray_menu(app: &AppHandle) {
    let update_available = app
        .try_state::<UpdateState>()
        .map(|s| s.0.lock().map(|g| g.is_some()).unwrap_or(false))
        .unwrap_or(false);
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let show = MenuItem::with_id(app, "show", "Show Lighthouse", true, None::<&str>)?;
        let widget = MenuItem::with_id(app, "widget", "Show search bar", true, None::<&str>)?;
        let add = MenuItem::with_id(app, "add-files", "Add files…", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::new(app)?;
        menu.append(&show)?;
        menu.append(&widget)?;
        menu.append(&add)?;
        if update_available {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&MenuItem::with_id(
                app,
                "update-open",
                "Update available — download…",
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&quit)?;
        Ok(menu)
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "add-files", "Add files…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "add-folder", "Add folder…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "link-files",
                "Link files… (no copy)",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "link-folder",
                "Link folder… (no copy)",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "choose-vault",
                "Choose vault folder…",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, "open-vault", "Open vault folder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&file, &edit])
}

/// Copy a directory into the vault (dotfiles skipped), like the Electron
/// "Add folder…" flow.
fn copy_dir_into(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for e in fs::read_dir(src)?.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let s = e.path();
        let d = dest.join(&name);
        if e.file_type()?.is_dir() {
            copy_dir_into(&s, &d)?;
        } else if e.file_type()?.is_file() {
            fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut dest = dir.join(name);
    let mut i = 1u32;
    while dest.exists() {
        dest = dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    dest
}

fn refresh_ui(app: &AppHandle) {
    lighthouse_core::vault::invalidate_walk_cache();
    // The UI listens for this (see tauriTransport) and re-reads the vault tree.
    // Never reload the webview here — a full reload killed in-flight streamed
    // answers, chat attachments, and scroll position just to refresh a list.
    let _ = app.emit("vault-changed", ());
}

fn handle_menu(app: &AppHandle, id: &str) {
    use tauri_plugin_dialog::DialogExt;
    match id {
        "show" => {
            if let Some(win) = main_window(app) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        "widget" => toggle_widget(app),
        "quit" => {
            app.exit(0);
        }
        "update-open" => open_with_os(Path::new(RELEASE_PAGE_URL)),
        "add-files" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title("Add files to your vault")
                .pick_files(move |paths| {
                    let vault = vault_dir_setting(&handle);
                    for p in paths
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|f| f.into_path().ok())
                    {
                        let name = p.file_name().map(|s| s.to_string_lossy().to_string());
                        if let Some(name) = name {
                            let _ = fs::copy(&p, unique_dest(&vault, &name));
                        }
                    }
                    refresh_ui(&handle);
                });
        }
        "add-folder" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title("Add a folder to your vault (copies it in)")
                .pick_folder(move |path| {
                    if let Some(src) = path.and_then(|f| f.into_path().ok()) {
                        let vault = vault_dir_setting(&handle);
                        if let Some(name) = src.file_name().map(|s| s.to_string_lossy().to_string())
                        {
                            let dest = unique_dest(&vault, &name);
                            let _ = copy_dir_into(&src, &dest);
                        }
                    }
                    refresh_ui(&handle);
                });
        }
        "link-files" | "link-folder" => {
            let directory = id == "link-folder";
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let paths = commands::pick_link_paths(handle.clone(), directory).await;
                for p in paths {
                    if let Err(e) = lighthouse_core::sources::add_reference(&p).await {
                        eprintln!("could not link {p}: {e}");
                    }
                }
                refresh_ui(&handle);
            });
        }
        "choose-vault" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title("Choose your vault folder")
                .pick_folder(move |path| {
                    if let Some(dir) = path.and_then(|f| f.into_path().ok()) {
                        // Managed policy: reject-and-keep — an out-of-root
                        // pick is refused, nothing is written, and the
                        // previous vault stays active.
                        if !lighthouse_core::policy::vault_path_allowed(&dir) {
                            let _ = handle.dialog()
                                .message(
                                    "That folder is outside the locations your \
                                     organization allows for vaults.",
                                )
                                .title("Managed by your organization")
                                .blocking_show();
                            return;
                        }
                        write_settings(
                            &handle,
                            serde_json::json!({ "vaultDir": dir.to_string_lossy() }),
                        );
                        std::env::set_var("VAULT_DIR", &dir);
                        lighthouse_core::index::invalidate_all();
                        refresh_ui(&handle);
                        // Index the new vault in the background right away.
                        lighthouse_core::vault::warm_index_async();
                    }
                });
        }
        "open-vault" => open_with_os(&vault_dir_setting(app)),
        _ => {}
    }
}

/// Shared shell entry point (add-mobile-apps §2). The desktop bin (`main.rs`)
/// calls this directly; on the mobile targets Tauri's generated native entry
/// point invokes it through `#[tauri::mobile_entry_point]`. All shell logic
/// lives here so desktop and mobile share exactly one code path.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before the builder: safe mode's webview flags only count if
    // they're in the environment before any webview process is spawned.
    let _safe = boot_guard::begin(env!("CARGO_PKG_VERSION"));
    tauri::Builder::default()
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Remember window size/position/maximized across restarts — a basic
        // desktop convention the shell was missing (every launch reopened at
        // the built-in 1280x820 in an OS-chosen spot). VISIBLE is excluded:
        // the plugin re-shows any window whose state saved visible, which
        // would override the uiMode launch decision below. The widget is
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
        .plugin(tauri_plugin_notification::init()) // G5 briefing-note alerts
        .manage(Supervisor::default())
        .manage(UpdateState::default())
        .manage(WidgetPin::default())
        .manage(WidgetResident::default())
        .manage(WidgetHold::default())
        .manage(WidgetFocusEpoch::default())
        .manage(MainIdleEpoch::default())
        .manage(HotkeyOk::default())
        .manage(ServerPort::default())
        .invoke_handler(tauri::generate_handler![
            commands::rag_list,
            commands::rag_op,
            commands::chat_ask,
            commands::profile_get,
            commands::profile_op,
            commands::connect_op,
            commands::model_status,
            commands::model_download,
            commands::model_uninstall,
            commands::open_node,
            commands::reveal_node,
            commands::settings_get,
            commands::settings_set,
            commands::diagnostics,
            commands::add_paths,
            commands::pick_link_paths,
            commands::upload_file,
            commands::update_state,
            commands::update_now,
            commands::watch_generation,
            commands::diag_report,
            commands::smoke_report,
            commands::widget_hide,
            commands::widget_show,
            commands::widget_set_pin,
            commands::widget_hold,
            commands::widget_resize,
            commands::show_main,
            commands::open_vault_dir,
            commands::open_explorer,
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            match event {
                // Closing hides to tray instead of quitting (persistent app);
                // for the widget, "close" and "dismiss" are the same gesture
                // (routed through hide_widget so its position is remembered).
                // The explorer is the exception: a lazily-created satellite
                // window that genuinely closes (recreated on next 📁).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == EXPLORER_LABEL {
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
        })
        .setup(|app| {
            let handle = app.handle().clone();
            bootstrap_env(&handle);

            // Launch at login is CONSENT-FIRST: only touch the OS autostart
            // registration once the user has answered the startup prompt
            // (startupAsked). Earlier builds registered autostart on first boot
            // before ever asking — undo that premature registration here so
            // unasked users are not silently enrolled.
            {
                let s = read_settings(&handle);
                let asked = s["startupAsked"].as_bool() == Some(true);
                if asked {
                    apply_autostart(&handle, s["runOnStartup"].as_bool() != Some(false));
                } else {
                    apply_autostart(&handle, false);
                }
            }

            // App menu + tray.
            if let Ok(menu) = build_app_menu(&handle) {
                let _ = app.set_menu(menu);
            }
            let mut tray = TrayIconBuilder::with_id("main-tray").tooltip("Lighthouse");
            // macOS menubar: use the monochrome Beam mark as a *template*
            // image (black + alpha only — AppKit re-tints it, so the glyph
            // stays legible on light and dark menubars alike). The
            // full-color app icon would render as a dark smudge there.
            // `icon_as_template` is a macOS-only attribute in tauri 2
            // (`TrayIconBuilder::icon_as_template(mut self, is_template:
            // bool) -> Self`); other platforms keep the bundled window icon.
            #[cfg(target_os = "macos")]
            {
                match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))
                {
                    Ok(template) => tray = tray.icon(template).icon_as_template(true),
                    Err(e) => {
                        // Only reachable if the compiled-in PNG is broken —
                        // fall back to the window icon over an empty tray.
                        shell_log(&handle, &format!("tray: template icon failed to decode: {e}"));
                        if let Some(icon) = app.default_window_icon().cloned() {
                            tray = tray.icon(icon);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray = tray.icon(icon);
                }
            }
            let tray = tray
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
            rebuild_tray_menu(&handle);

            // --- Pinned-question rechecks (openspec: add-pinned-questions):
            // sample the watcher generation every 30 s; when it advanced,
            // wait for a full 60 s window with no further changes (bulk file
            // operations collapse into one pass), then re-run every pin's
            // stored SQL — deterministic, guarded, no model — and emit ONE
            // `pins-changed` event with the changed set. Emission failures
            // go to shell.log and the next generation change retries.
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last_seen = lighthouse_core::watch::generation();
                    // Alerts that couldn't be delivered yet (emit failure) —
                    // carried into the next pass so they're never lost: the
                    // digests persist BEFORE the emit, so without this buffer
                    // a failed emit would silently swallow the change.
                    let mut pending: Vec<lighthouse_core::pins::ChangedPin> = Vec::new();
                    // G5 briefing note: pins changed since the LAST note, keyed by
                    // id so a pin that changes twice before a note reads
                    // before=oldest, now=newest. Independent of `pending` (which
                    // clears on each emit); this clears only when a note is written.
                    let mut note_changes: std::collections::HashMap<
                        String,
                        lighthouse_core::pins::ChangedPin,
                    > = std::collections::HashMap::new();
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        let g = lighthouse_core::watch::generation();
                        if g == last_seen {
                            continue;
                        }
                        // Quiet debounce: keep waiting while changes keep landing.
                        let mut quiet = g;
                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                            let now = lighthouse_core::watch::generation();
                            if now == quiet {
                                break;
                            }
                            quiet = now;
                        }
                        last_seen = quiet;
                        if pending.is_empty() && lighthouse_core::pins::list().is_empty() {
                            continue;
                        }
                        let changed = lighthouse_core::pins::recheck_all().await;
                        // Accumulate for the briefing note (keep earliest `before`,
                        // update `after`) BEFORE `changed` is moved into `pending`.
                        for c in &changed {
                            note_changes
                                .entry(c.id.clone())
                                .and_modify(|e| e.after = c.after.clone())
                                .or_insert_with(|| c.clone());
                        }
                        // Newest state wins per pin id; undelivered older
                        // alerts for other pins ride along.
                        let fresh: std::collections::HashSet<String> =
                            changed.iter().map(|c| c.id.clone()).collect();
                        pending.retain(|p| !fresh.contains(&p.id));
                        pending.extend(changed);
                        // Fire the change toast when there's something fresh — but
                        // do NOT early-continue on an empty `pending`, or a note
                        // that has come due this pass (from changes accumulated on
                        // an EARLIER pass) would be skipped whenever the current
                        // pass produced no fresh pin change — e.g. the watcher
                        // generation bumped on an unrelated vault edit.
                        if !pending.is_empty() {
                            match handle
                                .emit("pins-changed", serde_json::json!({ "changed": pending }))
                            {
                                Ok(()) => pending.clear(),
                                Err(e) => {
                                    shell_log(
                                        &handle,
                                        &format!("pins: emit failed (will retry next pass): {e}"),
                                    );
                                }
                            }
                        }
                        // G5: at most once per user-set daily hour, refresh the
                        // briefing note from everything changed since the last
                        // note, then notify (gated). The note is written even
                        // when the notification is suppressed. Only stamp the daily
                        // gate + clear the accumulator once the write SUCCEEDS, so a
                        // failed write retries next pass instead of silently
                        // recording the day's note as done and dropping the changes.
                        let hour = read_settings(&handle)["briefingNoteHour"]
                            .as_u64()
                            .unwrap_or(9) as u32;
                        let now = lighthouse_core::config::now_ms();
                        if !note_changes.is_empty()
                            && lighthouse_core::briefings::note_due(
                                lighthouse_core::briefings::last_note_ms(),
                                now,
                                hour,
                            )
                        {
                            let mut changed_vec: Vec<_> = note_changes.values().cloned().collect();
                            changed_vec.sort_by(|a, b| a.id.cmp(&b.id)); // deterministic order
                            let md = lighthouse_core::briefings::compose_briefing_note(
                                &changed_vec,
                                now,
                            );
                            match lighthouse_core::vault::refresh_artifact(
                                "Lighthouse Notes",
                                "Lighthouse Briefing",
                                "md",
                                md.as_bytes(),
                            ) {
                                Ok(_) => {
                                    lighthouse_core::briefings::mark_note_run(now);
                                    let _ = handle.emit("vault-changed", ());
                                    maybe_notify(&handle, changed_vec.len());
                                    note_changes.clear();
                                }
                                Err(e) => shell_log(
                                    &handle,
                                    &format!("briefing note write failed (will retry): {e}"),
                                ),
                            }
                        }
                    }
                });
            }

            // --- Desktop widget (docs/widget-scope.md §7 W1): in widget mode
            // it IS the launch surface, so it's created now. In window mode
            // its creation is DEFERRED a few seconds — a second webview at
            // t=0 doubles the first-launch process storm (WebView2 spawns a
            // family of processes per webview, all under antivirus scrutiny
            // on an unsigned first run) — and skipped entirely in safe mode;
            // every summon path creates it on demand via ensure_widget_window.
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

            // Phase 5 watcher: event-driven tree/index freshness + a pushed
            // "vault-generation" event replacing the UI's 4 s poll.
            lighthouse_core::watch::start();

            // Pre-warm the retrieval index off the interactive path (bounded
            // threads inside): the first question after a launch — or after
            // linking a big folder — used to pay the whole corpus build.
            // Skipped in safe mode: a minimal boot does nothing optional.
            if !boot_guard::safe_mode() {
                tauri::async_runtime::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    lighthouse_core::vault::warm_index_async();
                });
            }
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last = lighthouse_core::watch::generation();
                    loop {
                        // While background-conserve has us suspended the UI is
                        // hidden, so park this 2 Hz poll: sleep long and skip
                        // the emit. `last` isn't advanced, so the first tick
                        // after resume fires one event if anything changed and
                        // the (now-visible) UI refreshes once.
                        let suspended = handle
                            .try_state::<Supervisor>()
                            .map(|s| s.is_suspended())
                            .unwrap_or(false);
                        tokio::time::sleep(std::time::Duration::from_millis(
                            if suspended { 2000 } else { 500 },
                        ))
                        .await;
                        if suspended {
                            continue;
                        }
                        let now = lighthouse_core::watch::generation();
                        if now != last {
                            last = now;
                            let _ = handle.emit("vault-generation", now);
                        }
                    }
                });
            }

            // CI boot smoke (LIGHTHOUSE_SMOKE=1, release-smoke.yml): prove the
            // shipped binary boots and answers one grounded ask with ZERO
            // network — so the model supervisor and the update check (the two
            // legitimate background egress/spawn sources) stay off for the
            // run, and the verdict is the process exit code.
            let smoke = std::env::var("LIGHTHOUSE_SMOKE")
                .map(|v| v == "1")
                .unwrap_or(false);

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

            // Boot diagnostics (LIGHTHOUSE_DIAG=1): capture early JS errors,
            // then report the webview's state + a live fetch probe into the
            // shell log — how headless CI smoke-tests prove the UI→IPC→engine
            // pipeline without a display.
            if std::env::var("LIGHTHOUSE_DIAG").map(|v| v == "1").unwrap_or(false) {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    if let Some(win) = main_window(&handle) {
                        let _ = win.eval(
                            "window.__LH_ERRORS=window.__LH_ERRORS||[];window.onerror=function(m,s,l){window.__LH_ERRORS.push(String(m)+' @'+s+':'+l)};window.addEventListener('unhandledrejection',function(e){window.__LH_ERRORS.push('rej: '+((e.reason&&e.reason.message)||String(e.reason)))});",
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    if let Some(win) = main_window(&handle) {
                        let _ = win.eval(
                            "window.__TAURI_INTERNALS__.invoke('diag_report',{payload:JSON.stringify({ready:document.readyState,title:document.title,scripts:document.scripts.length,bodyLen:(document.body&&document.body.innerHTML.length)||0,tauri:!!window.__TAURI_INTERNALS__,fetchHead:String(window.fetch).slice(0,80),errors:window.__LH_ERRORS||['collector-not-installed']})});",
                        );
                        let _ = win.eval(
                            "fetch('/api/rag').then(function(r){return r.json()}).then(function(j){window.__TAURI_INTERNALS__.invoke('diag_report',{payload:'fetch-ok nodes='+(j.nodes?j.nodes.length:'?')+' desktop='+j.desktop})}).catch(function(e){window.__TAURI_INTERNALS__.invoke('diag_report',{payload:'fetch-fail '+String(e)})});",
                        );
                    }
                });
            }

            // CI boot smoke driver: once the webview has booted, drive one
            // real ask through the UI transport (window.fetch →
            // tauriTransport → IPC → engine) against the harness-seeded
            // vault, then exit with the verdict — 0 grounded answer with
            // references, 2 assertion failed, 3 never reported (webview or
            // transport never came up). This is the same binary a user
            // installs and the same pipeline a real ask takes; on Linux
            // runners it runs under Xvfb.
            if smoke {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    match main_window(&handle) {
                        Some(win) => {
                            let _ = win.eval(SMOKE_DRIVER_JS);
                        }
                        None => {
                            eprintln!("SMOKE FAIL: no main window");
                            handle.exit(3);
                            return;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                    eprintln!("SMOKE FAIL: timed out waiting for smoke_report");
                    handle.exit(3);
                });
            }

            // UI transport: bundled static UI ⇒ pure IPC, no TCP port at all.
            // No bundle (or LIGHTHOUSE_SERVE=1) ⇒ embedded loopback server.
            let ipc_ui = has_bundled_ui(&handle);
            let force_serve = std::env::var("LIGHTHOUSE_SERVE").map(|v| v == "1").unwrap_or(false);
            if !ipc_ui || force_serve {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    match start_embedded_server().await {
                        Ok(port) => {
                            eprintln!("embedded API on http://127.0.0.1:{port}");
                            if let Some(s) = handle.try_state::<ServerPort>() {
                                s.0.store(port, std::sync::atomic::Ordering::Relaxed);
                            }
                            if !ipc_ui {
                                if let Some(win) = main_window(&handle) {
                                    let url = format!("http://127.0.0.1:{port}")
                                        .parse()
                                        .expect("loopback url");
                                    let _ = win.navigate(url);
                                }
                                if let Some(w) = handle.get_webview_window(WIDGET_LABEL) {
                                    let url = format!("http://127.0.0.1:{port}/widget")
                                        .parse()
                                        .expect("loopback url");
                                    let _ = w.navigate(url);
                                }
                            }
                        }
                        Err(e) => eprintln!("embedded server failed to start: {e}"),
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lighthouse")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => {
                    save_widget_pos(app); // quitting with the bar up still remembers its spot
                    lighthouse_core::index::flush_now(); // don't lose the warm cache
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
        });
}
