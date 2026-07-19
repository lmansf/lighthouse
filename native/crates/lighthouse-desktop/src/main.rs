//! Lighthouse desktop binary — a thin wrapper over the shared shell in `lib.rs`
//! (add-mobile-apps §2). All shell logic (the `run()` builder, the 28 commands,
//! `bootstrap_env`, transport plumbing) lives in the library so the desktop bin
//! and the mobile entry point (`#[tauri::mobile_entry_point] run()`) share one
//! code path, and the crate can also build as `staticlib`/`cdylib` for the
//! iOS/Android targets.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() {
    lighthouse_desktop::run();
}
