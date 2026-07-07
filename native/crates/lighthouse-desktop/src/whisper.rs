//! W3 "Whisper mode" (docs/widget-scope.md §3): summon the search bar by
//! tapping Ctrl+Super+Shift — all three together, no other key — the
//! modifier-only chord Wispr Flow users have in muscle memory. No standard
//! hotkey API can register a modifier-only chord (they all require a real
//! key), so this is per-OS low-level work, strictly OPT-IN from Preferences
//! (a global input listener is not something to install silently).
//!
//! Chord semantics — a TAP, not a hold, identical on every backend: the
//! chord arms when Ctrl, Super and Shift are all down with nothing else
//! pressed during the hold, and fires on the first release. Any non-modifier
//! key while held marks the chord dirty and suppresses the whisper — so
//! typing, the keyed summon shortcut, and OS combos like Ctrl+Win+Shift+B
//! can never double-fire the widget.
//!
//! Backends:
//! - Windows: WH_KEYBOARD_LL hook on its own message-pump thread (the exact
//!   mechanism Wispr itself uses).
//! - macOS: an NSEvent global monitor (FlagsChanged + KeyDown), which only
//!   receives events once the user grants Accessibility permission — the
//!   enable path triggers the system prompt and keeps re-checking briefly.
//! - Linux/X11: passive XInput2 raw key events on the root window (no
//!   grabs, nothing is swallowed). Wayland sessions are refused — the
//!   compositor does not expose global input; the keyed chord remains.

#[cfg(windows)]
mod imp {
    use std::mem::MaybeUninit;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::thread::JoinHandle;

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LCONTROL, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RSHIFT, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG,
        PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const CTRL: u8 = 0b001;
    const SUPER: u8 = 0b010;
    const SHIFT: u8 = 0b100;
    const ALL: u8 = 0b111;

    /// Which of the three chord modifiers are physically down right now.
    static MODS: AtomicU8 = AtomicU8::new(0);
    /// A non-modifier key was pressed while the chord was (partially) held —
    /// the hold belongs to some other shortcut; stay quiet until fully released.
    static DIRTY: AtomicBool = AtomicBool::new(false);
    /// Set once; the hook thread reaches the app through it.
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Serializes enable/disable and owns the pump thread. The u32 is the
    /// pump thread's id, the WM_QUIT mailbox for a clean unhook.
    static PUMP: Mutex<Option<(u32, JoinHandle<()>)>> = Mutex::new(None);
    /// Install outcome for permission_state(): 0 off/never · 1 the last
    /// enable FAILED (hook refused — typically aggressive antivirus) · 2
    /// active. A GUI build has no stderr, so this is how a dead hook becomes
    /// visible in Preferences instead of leaving the toggle ON over nothing.
    static STATE: AtomicU8 = AtomicU8::new(0);

    fn modifier_bit(vk: u32) -> u8 {
        // The LL hook reports side-specific codes for physical keys; the
        // generic codes appear in injected input — treat both as the chord.
        match vk as u16 {
            VK_CONTROL | VK_LCONTROL | VK_RCONTROL => CTRL,
            VK_LWIN | VK_RWIN => SUPER,
            VK_SHIFT | VK_LSHIFT | VK_RSHIFT => SHIFT,
            _ => 0,
        }
    }

    /// LL hooks must return FAST (the OS serializes all keyboard input
    /// through them and evicts hooks that stall) — nothing here but a few
    /// atomics; the actual toggle is posted to the main thread.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            let bit = modifier_bit(info.vkCode);
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    if bit == 0 {
                        if MODS.load(Ordering::Relaxed) != 0 {
                            DIRTY.store(true, Ordering::Relaxed);
                        }
                    } else {
                        MODS.fetch_or(bit, Ordering::Relaxed);
                    }
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    if bit != 0 {
                        let before = MODS.fetch_and(!bit, Ordering::Relaxed);
                        if before == ALL && !DIRTY.load(Ordering::Relaxed) {
                            fire();
                        }
                        if before & !bit == 0 {
                            DIRTY.store(false, Ordering::Relaxed);
                        }
                    }
                }
                _ => {}
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    fn fire() {
        if let Some(app) = APP.get() {
            let inner = app.clone();
            let _ = app.run_on_main_thread(move || crate::toggle_widget(&inner));
        }
    }

    pub fn set_enabled(app: &AppHandle, on: bool) {
        let _ = APP.set(app.clone());
        let mut pump = match PUMP.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if on {
            if pump.is_some() {
                return; // already listening
            }
            let (tx, rx) = mpsc::channel::<u32>();
            let handle = std::thread::Builder::new()
                .name("whisper-hook".into())
                .spawn(move || unsafe {
                    // Force-create this thread's message queue BEFORE
                    // reporting the thread id, so a racing disable's
                    // PostThreadMessage(WM_QUIT) can never miss.
                    let mut msg = MaybeUninit::<MSG>::uninit();
                    PeekMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                    // A real module handle, not NULL: LL hooks are documented
                    // to ignore hMod, but some Windows configurations (and
                    // security tooling that vets hook installs) reject a NULL
                    // one — and this hook silently failing is exactly the
                    // field report "whisper is on but never fires".
                    let hmod = GetModuleHandleW(std::ptr::null());
                    let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0);
                    if hook.is_null() {
                        eprintln!("whisper: keyboard hook failed to install");
                        let _ = tx.send(0);
                        return;
                    }
                    let _ = tx.send(GetCurrentThreadId());
                    while GetMessageW(msg.as_mut_ptr(), std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(msg.as_ptr());
                        DispatchMessageW(msg.as_ptr());
                    }
                    UnhookWindowsHookEx(hook);
                    MODS.store(0, Ordering::Relaxed);
                    DIRTY.store(false, Ordering::Relaxed);
                });
            let installed = match handle {
                Ok(handle) => match rx.recv() {
                    Ok(tid) if tid != 0 => {
                        *pump = Some((tid, handle));
                        true
                    }
                    _ => {
                        let _ = handle.join(); // hook never installed
                        false
                    }
                },
                Err(_) => false,
            };
            STATE.store(if installed { 2 } else { 1 }, Ordering::Relaxed);
        } else {
            if let Some((tid, handle)) = pump.take() {
                unsafe { PostThreadMessageW(tid, WM_QUIT, 0, 0) };
                let _ = handle.join(); // pump exits promptly on WM_QUIT
            }
            STATE.store(0, Ordering::Relaxed);
        }
    }

    /// Windows needs no OS permission for the hook — but the install itself
    /// can be refused (aggressive antivirus). "failed" lets Preferences say
    /// so instead of presenting an ON toggle over a chord that never fires.
    pub fn permission_state() -> &'static str {
        match STATE.load(Ordering::Relaxed) {
            1 => "failed",
            _ => "granted",
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use tauri::AppHandle;

    const CTRL: u8 = 0b001;
    const SUPER: u8 = 0b010; // Command — "super" everywhere else in the app
    const SHIFT: u8 = 0b100;
    const ALL: u8 = 0b111;

    static PREV: AtomicU8 = AtomicU8::new(0);
    static DIRTY: AtomicBool = AtomicBool::new(false);
    /// Whether the user still wants the whisper (survives the permission wait).
    static WANTED: AtomicBool = AtomicBool::new(false);
    /// 2 granted · 1 pending (asked, waiting on Accessibility) · 0 unknown.
    static PERMISSION: AtomicU8 = AtomicU8::new(0);

    /// The installed monitor objects. AppKit hands us Retained<AnyObject>s
    /// only ever created/used/removed on the main thread; the wrapper exists
    /// purely so the static Mutex can hold them. TWO monitors are needed: a
    /// GLOBAL monitor sees events while OTHER apps are focused, and a LOCAL
    /// monitor sees events while LIGHTHOUSE itself is focused — without the
    /// local one, a second chord tap to DISMISS the summoned (focused) widget
    /// would never be seen, so the whisper could open but never re-toggle.
    struct MonitorHandle(Option<Retained<AnyObject>>, Option<Retained<AnyObject>>);
    unsafe impl Send for MonitorHandle {}
    static MONITOR: Mutex<Option<MonitorHandle>> = Mutex::new(None);

    // Accessibility trust — the one macOS gate for global monitors. The
    // prompt option shows the system dialog that deep-links to Privacy &
    // Security → Accessibility.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
    }

    fn accessibility_trusted(prompt: bool) -> bool {
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let dict = CFDictionary::from_CFType_pairs(&[(
                key.as_CFType(),
                CFBoolean::from(prompt).as_CFType(),
            )]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const _)
        }
    }

    fn flags_to_mask(flags: NSEventModifierFlags) -> u8 {
        let mut m = 0;
        if flags.contains(NSEventModifierFlags::Control) {
            m |= CTRL;
        }
        if flags.contains(NSEventModifierFlags::Command) {
            m |= SUPER;
        }
        if flags.contains(NSEventModifierFlags::Shift) {
            m |= SHIFT;
        }
        m
    }

    /// Runs on the main thread (global monitors deliver on the run loop that
    /// installed them). Same tap/dirty state machine as the other backends,
    /// driven from flag SNAPSHOTS instead of per-key events.
    fn handle(app: &AppHandle, event: NonNull<NSEvent>) {
        let event = unsafe { event.as_ref() };
        let ty = unsafe { event.r#type() };
        if ty == NSEventType::FlagsChanged {
            let cur = flags_to_mask(unsafe { event.modifierFlags() });
            let prev = PREV.swap(cur, Ordering::Relaxed);
            let released = prev & !cur;
            if released != 0 && prev == ALL && !DIRTY.load(Ordering::Relaxed) {
                crate::toggle_widget(app);
            }
            if cur == 0 {
                DIRTY.store(false, Ordering::Relaxed);
            }
        } else if PREV.load(Ordering::Relaxed) != 0 {
            // Any real key while modifiers are held dirties the chord.
            DIRTY.store(true, Ordering::Relaxed);
        }
    }

    fn install(app: &AppHandle) {
        let mut guard = match MONITOR.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.is_some() {
            return;
        }
        let mask = NSEventMask::FlagsChanged | NSEventMask::KeyDown;
        // Global monitor: events while another app is focused.
        let g_app = app.clone();
        let g_block = RcBlock::new(move |ev: NonNull<NSEvent>| handle(&g_app, ev));
        let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &g_block);
        // Local monitor: events while Lighthouse is focused (the summoned
        // widget). Its handler must return the event to let it through; we
        // never swallow input — the whisper only observes.
        let l_app = app.clone();
        let l_block = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
            handle(&l_app, ev);
            ev.as_ptr()
        });
        let local = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &l_block)
        };
        if global.is_none() && local.is_none() {
            eprintln!("whisper: NSEvent monitors failed to install");
            return;
        }
        *guard = Some(MonitorHandle(global, local));
        PERMISSION.store(2, Ordering::Relaxed);
    }

    fn uninstall() {
        if let Ok(mut guard) = MONITOR.lock() {
            if let Some(MonitorHandle(g, l)) = guard.take() {
                if let Some(m) = g {
                    unsafe { NSEvent::removeMonitor(&m) };
                }
                if let Some(m) = l {
                    unsafe { NSEvent::removeMonitor(&m) };
                }
            }
        }
        PREV.store(0, Ordering::Relaxed);
        DIRTY.store(false, Ordering::Relaxed);
    }

    fn enable_on_main(app: AppHandle) {
        if !WANTED.load(Ordering::Relaxed) {
            return; // user changed their mind while we waited
        }
        if accessibility_trusted(true) {
            install(&app);
            return;
        }
        // Asked; the system prompt is up (or was declined earlier). Poll
        // briefly so flipping the checkbox in System Settings takes effect
        // without an app restart; give up quietly after ~5 minutes.
        PERMISSION.store(1, Ordering::Relaxed);
        eprintln!("whisper: waiting for Accessibility permission");
        let app2 = app.clone();
        std::thread::Builder::new()
            .name("whisper-ax-wait".into())
            .spawn(move || {
                for _ in 0..60 {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if !WANTED.load(Ordering::Relaxed) {
                        return;
                    }
                    if accessibility_trusted(false) {
                        let inner = app2.clone();
                        let _ = app2.run_on_main_thread(move || {
                            if WANTED.load(Ordering::Relaxed) {
                                install(&inner);
                            }
                        });
                        return;
                    }
                }
            })
            .map(|_| ())
            .unwrap_or(());
    }

    pub fn set_enabled(app: &AppHandle, on: bool) {
        WANTED.store(on, Ordering::Relaxed);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if on {
                enable_on_main(app2);
            } else {
                uninstall();
            }
        });
    }

    pub fn permission_state() -> &'static str {
        match PERMISSION.load(Ordering::Relaxed) {
            2 => "granted",
            1 => "pending",
            _ => "unknown",
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::OnceLock;

    use tauri::AppHandle;
    use x11rb::connection::Connection;
    use x11rb::protocol::xinput::{self, XIEventMask};
    use x11rb::protocol::xproto::ConnectionExt as _;
    use x11rb::protocol::Event;

    const CTRL: u8 = 0b001;
    const SUPER: u8 = 0b010;
    const SHIFT: u8 = 0b100;
    const ALL: u8 = 0b111;

    static MODS: AtomicU8 = AtomicU8::new(0);
    static DIRTY: AtomicBool = AtomicBool::new(false);
    /// The listener is passive and cheap, so it starts once and is GATED:
    /// disabling flips WANTED off and the thread keeps draining events
    /// silently — closing an X connection from another thread is more
    /// fragile than an inert observer.
    static WANTED: AtomicBool = AtomicBool::new(false);
    static STARTED: OnceLock<()> = OnceLock::new();
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn is_x11_session() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_some()
    }

    fn fire() {
        if let Some(app) = APP.get() {
            let inner = app.clone();
            let _ = app.run_on_main_thread(move || crate::toggle_widget(&inner));
        }
    }

    fn run() -> anyhow::Result<()> {
        let (conn, screen_num) = x11rb::connect(None)?;
        let root = conn.setup().roots[screen_num].root;
        // XInput 2.0+ for raw events; passive — nothing is grabbed or eaten.
        xinput::xi_query_version(&conn, 2, 0)?.reply()?;

        // Which keycodes are Ctrl / Super / Shift on this keymap: rows of the
        // modifier mapping (0 = Shift, 2 = Control, 6 = Mod4 — Super on every
        // mainstream layout).
        let mapping = conn.get_modifier_mapping()?.reply()?;
        let per = mapping.keycodes_per_modifier() as usize;
        let row = |i: usize| -> HashSet<u8> {
            mapping.keycodes[i * per..(i + 1) * per]
                .iter()
                .copied()
                .filter(|k| *k != 0)
                .collect()
        };
        let shift = row(0);
        let ctrl = row(2);
        let sup = row(6);
        let bit_of = |kc: u8| -> u8 {
            if ctrl.contains(&kc) {
                CTRL
            } else if sup.contains(&kc) {
                SUPER
            } else if shift.contains(&kc) {
                SHIFT
            } else {
                0
            }
        };

        xinput::xi_select_events(
            &conn,
            root,
            &[xinput::EventMask {
                deviceid: 1, // XIAllMasterDevices
                mask: vec![XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE],
            }],
        )?
        .check()?;

        // Recompute the chord mask from the REAL keyboard state rather than
        // accumulating press/release deltas — a delta model leaves a stuck
        // bit if a release is ever missed (another app's grab, a fast
        // chord), which would later fire the whisper spuriously. QueryKeymap
        // is ground truth: a 32-byte bitmap, bit `kc` set when key `kc` is
        // physically down. Only queried on modifier events (not on typing).
        let true_mods = |conn: &x11rb::rust_connection::RustConnection| -> u8 {
            let km = match conn.query_keymap().map_err(|_| ()).and_then(|c| c.reply().map_err(|_| ())) {
                Ok(km) => km,
                Err(()) => return MODS.load(Ordering::Relaxed), // keep last on a hiccup
            };
            let down = |set: &HashSet<u8>| set.iter().any(|&kc| {
                km.keys.get((kc / 8) as usize).is_some_and(|b| b & (1 << (kc % 8)) != 0)
            });
            (if down(&ctrl) { CTRL } else { 0 })
                | (if down(&sup) { SUPER } else { 0 })
                | (if down(&shift) { SHIFT } else { 0 })
        };

        loop {
            let (detail, press) = match conn.wait_for_event()? {
                Event::XinputRawKeyPress(e) => (e.detail as u8, true),
                Event::XinputRawKeyRelease(e) => (e.detail as u8, false),
                _ => continue,
            };
            if bit_of(detail) == 0 {
                // A non-modifier keypress during a held chord dirties it.
                if press && MODS.load(Ordering::Relaxed) != 0 {
                    DIRTY.store(true, Ordering::Relaxed);
                }
                continue;
            }
            // Modifier event: resync from ground truth, then act on the edge.
            let cur = true_mods(&conn);
            let before = MODS.swap(cur, Ordering::Relaxed);
            if !press
                && before == ALL
                && cur != ALL
                && !DIRTY.load(Ordering::Relaxed)
                && WANTED.load(Ordering::Relaxed)
            {
                fire();
            }
            if cur == 0 {
                DIRTY.store(false, Ordering::Relaxed);
            }
        }
    }

    pub fn set_enabled(app: &AppHandle, on: bool) {
        let _ = APP.set(app.clone());
        WANTED.store(on, Ordering::Relaxed);
        if !on {
            return;
        }
        if !is_x11_session() {
            eprintln!("whisper: unsupported on Wayland — the keyed shortcut remains");
            return;
        }
        STARTED.get_or_init(|| {
            std::thread::Builder::new()
                .name("whisper-x11".into())
                .spawn(|| {
                    if let Err(e) = run() {
                        eprintln!("whisper: X11 listener stopped: {e}");
                    }
                })
                .map(|_| ())
                .unwrap_or(());
        });
    }

    pub fn permission_state() -> &'static str {
        if is_x11_session() {
            "granted"
        } else {
            "unsupported"
        }
    }
}

pub use imp::{permission_state, set_enabled};
