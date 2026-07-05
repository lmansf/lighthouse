//! W3 "Whisper mode" (docs/widget-scope.md §3): summon the search bar by
//! tapping Ctrl+Super+Shift — all three together, no other key — the
//! modifier-only chord Wispr Flow users have in muscle memory. No standard
//! hotkey API can register a modifier-only chord (they all require a real
//! key), so this is per-OS low-level work. Windows ships first, via a
//! WH_KEYBOARD_LL hook on its own message-pump thread — the same mechanism
//! Wispr itself uses. Strictly OPT-IN from Preferences: installing a global
//! keyboard hook is not something to do silently. macOS (NSEvent
//! flagsChanged + Accessibility consent) and X11 are the next rungs; Wayland
//! keeps the keyed chord only.
//!
//! Chord semantics — a TAP, not a hold: the chord arms when Ctrl, Super and
//! Shift are all down with nothing else pressed during the hold, and fires
//! on the first release. Any non-modifier key while held marks the chord
//! dirty and suppresses the whisper — so typing, the keyed
//! Ctrl+Super+Shift+Space hotkey, and OS combos like Ctrl+Win+Shift+B can
//! never double-fire the widget.

#[cfg(windows)]
mod imp {
    use std::mem::MaybeUninit;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::thread::JoinHandle;

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
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
                    let hook =
                        SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
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
            if let Ok(handle) = handle {
                match rx.recv() {
                    Ok(tid) if tid != 0 => *pump = Some((tid, handle)),
                    _ => {
                        let _ = handle.join(); // hook never installed
                    }
                }
            }
        } else if let Some((tid, handle)) = pump.take() {
            unsafe { PostThreadMessageW(tid, WM_QUIT, 0, 0) };
            let _ = handle.join(); // pump exits promptly on WM_QUIT
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    /// Whisper mode has no backend on this OS yet (macOS/X11 are the next
    /// rungs of the W3 ladder); the keyed hotkey remains the summon path.
    pub fn set_enabled(_app: &AppHandle, on: bool) {
        if on {
            eprintln!("whisper mode is not supported on this OS yet");
        }
    }
}

pub use imp::set_enabled;
