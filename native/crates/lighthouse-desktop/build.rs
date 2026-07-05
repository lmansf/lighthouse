fn main() {
    // `frontendDist` must exist at compile time (assets embed into the
    // binary). The real UI comes from `node scripts/build-ui-static.mjs`;
    // without it, seed the placeholder splash so plain `cargo build` works —
    // the shell then boots in embedded-server mode instead of IPC mode.
    let ui_dist = std::path::Path::new("ui-dist");
    if !ui_dist.join("index.html").exists() {
        let _ = std::fs::create_dir_all(ui_dist);
        let _ = std::fs::copy("placeholder/index.html", ui_dist.join("index.html"));
    }
    tauri_build::build()
}
