//! lighthouse-shell (§40): the Tauri-free half of the app shell — command
//! bodies and boot logic that need only lighthouse-core, split out so the
//! Linux dev container `cargo check`s ALL of it (the wrapper crate
//! lighthouse-desktop keeps only the tauri layer + desktop-only modules and
//! remains CI-verified). See docs/crate-split.md for the cut line.

pub mod boot_guard;
pub mod commands;

/// Launch the platform's default opener for a path, detached. Desktop-only:
/// the mobile shells have no spawnable `open`/`xdg-open` equivalent (§3 will
/// route "open" gestures through the OS share/viewer intents instead).
#[cfg(desktop)]
pub fn open_with_os(abs: &std::path::Path) {
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
