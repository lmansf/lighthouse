//! Tray icon, app menu, and their handlers — desktop-only chrome
//! (add-mobile-apps §2: compiled out on iOS/Android, which have no tray, no
//! window menu bar, and no OS file-picker menu items). Bodies are
//! byte-identical to the pre-split `lib.rs`; only the module boundary is new.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

use super::supervise::{UpdateState, RELEASE_PAGE_URL};
use super::widget::{open_with_os, toggle_widget};
use crate::{commands, main_window, vault_dir_setting, write_settings};

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

pub(crate) fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
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

pub(crate) fn handle_menu(app: &AppHandle, id: &str) {
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
