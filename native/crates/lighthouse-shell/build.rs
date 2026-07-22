//! Mirror tauri-build's `desktop`/`mobile` cfg aliases. tauri-build emits
//! them for the APP crate only and cfgs never cross crate boundaries, so
//! bodies moved here would otherwise compile their `#[cfg(desktop)]` forks
//! OUT on every target — a silent behavior change. Re-derive from the same
//! rule tauri-build uses: mobile = ios | android, desktop = everything else.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(desktop)");
    println!("cargo::rustc-check-cfg=cfg(mobile)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "ios" || os == "android" {
        println!("cargo::rustc-cfg=mobile");
    } else {
        println!("cargo::rustc-cfg=desktop");
    }
}
