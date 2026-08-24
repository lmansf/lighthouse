//! Tray icon, app menu, and their handlers — desktop-only chrome
//! (add-mobile-apps §2: compiled out on iOS/Android, which have no tray, no
//! window menu bar, and no OS file-picker menu items). Bodies are
//! byte-identical to the pre-split `lib.rs`; only the module boundary is new.

use std::path::Path;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

use super::supervise::{UpdateState, RELEASE_PAGE_URL};
use super::widget::{open_with_os, toggle_widget};
use crate::{commands, main_window};

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
            // 0.15.0: one door. Copy-in vs link-in-place, and the vault
            // folder itself, all described a persistent corpus; a file now
            // joins the conversation you are in.
            &MenuItem::with_id(app, "add-files", "Attach files…", true, Some("CmdOrCtrl+O"))?,
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

/// Nudge the UI to re-read the current conversation's attachments. The event
/// name is unchanged so an older webview still listens; never reload the
/// webview here — a full reload killed in-flight streamed answers, chat
/// attachments, and scroll position just to refresh a list.
fn refresh_ui(app: &AppHandle) {
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
        // 0.15.0: ONE file door. The picker's paths go to the app window,
        // which attaches them to the current conversation — the same seam a
        // native drag-drop uses. Copying into a vault folder, linking in
        // place, choosing the vault, and opening it all went with the vault.
        "add-files" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title("Attach files to this conversation")
                .pick_files(move |paths| {
                    let picked: Vec<String> = paths
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|f| f.into_path().ok())
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();
                    if !picked.is_empty() {
                        let _ = handle.emit("lighthouse:os-drop-paths", picked);
                    }
                    refresh_ui(&handle);
                });
        }
        _ => {}
    }
}
