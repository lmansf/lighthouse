//! Child-process supervision + update notification (port of the
//! electron/main.js responsibilities that live beside the window).
//!
//! - llama-server lifecycle: start when a usable model exists, honor the
//!   uninstall marker handshake (stop the server so its mmap releases the
//!   weights, delete them, clear the marker), kill on quit.
//! - Notify-only update check against GitHub releases — the same Phase A
//!   posture as the Electron updater (no auto-download while builds are
//!   unsigned; flip to tauri-plugin-updater once signing keys exist).

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use lighthouse_core::config::resources_dir;
use lighthouse_core::local_model::{find_installed_model, model_gguf_files, uninstall_marker_path};
use tauri::{AppHandle, Emitter, Manager};

pub const RELEASE_PAGE_URL: &str = "https://github.com/lmansf/lighthouse/releases/latest";

#[derive(Default)]
pub struct Supervisor {
    llm: Mutex<Option<Child>>,
    uninstalling: Mutex<bool>,
    /// When the current llama-server was spawned — feeds the GPU crash guard.
    spawned_at: Mutex<Option<std::time::Instant>>,
    /// Consecutive fast exits (died < 20 s after spawn). Two in a row with GPU
    /// offload enabled reads as "the Vulkan driver can't do this" — we persist
    /// llmDisableGpu and relaunch CPU-only rather than crash-looping.
    quick_crashes: Mutex<u32>,
}

fn llm_root() -> PathBuf {
    resources_dir().join("llm")
}

fn log_file(app: &AppHandle, name: &str) -> Option<fs::File> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
        .ok()
}

impl Supervisor {
    /// Launch the bundled local inference server against the installed model,
    /// if there is one. No-op when either half is missing.
    pub fn start_local_llm(&self, app: &AppHandle) {
        let mut guard = self.llm.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return; // already running
        }
        let bin = llm_root().join(if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        });
        let Some(model) = find_installed_model() else {
            return;
        };
        if !bin.exists() {
            return;
        }
        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model)
            .args(["--host", "127.0.0.1", "--port", "8080"])
            // Force the legacy C++ chat-template path. Recent llama-server builds
            // default to Jinja and, for `/v1/chat/completions`, try to auto-
            // generate a tool-call parser by probing the model's embedded
            // template — which fails on some templates with
            // "Unable to generate parser for this template", 400-ing EVERY chat
            // request (the app then falls back to raw passages). We don't use
            // tool-calls; the legacy path auto-detects Mistral's [INST] format
            // and formats correctly. Any build new enough to hit that error
            // supports this flag, so it's safe.
            .arg("--no-jinja")
            // Context window: the server default (4096) silently context-shifts
            // once system prompt + history + retrieved chunks outgrow it —
            // dropping the oldest turns mid-conversation degrades answers with
            // no visible sign. 6144 covers long chats while keeping the KV
            // cache (~0.75 GB fp16) affordable on 8 GB machines.
            .args(["-c", "6144"])
            .current_dir(llm_root())
            .stdin(Stdio::null());
        // GPU offload: the bundled build carries dynamic backends (Vulkan on
        // Windows/Linux, Metal on macOS) with a built-in CPU fallback when no
        // usable device/driver exists, so asking for full offload is safe on
        // GPU-less machines. The one pathological case — a Vulkan driver that
        // crashes the process — is handled by the quick-crash guard in
        // reconcile(), which persists llmDisableGpu and relaunches CPU-only.
        let gpu_disabled =
            crate::read_settings(app)["llmDisableGpu"].as_bool() == Some(true);
        if !gpu_disabled {
            cmd.args(["-ngl", "999"]);
        }
        // Log to a file instead of a console window.
        match (
            log_file(app, "local-model.log"),
            log_file(app, "local-model.log"),
        ) {
            (Some(out), Some(err)) => {
                cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
            }
            _ => {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.spawn() {
            Ok(child) => {
                *guard = Some(child);
                *self.spawned_at.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(std::time::Instant::now());
                // Warm the model in the background: wait until /health says the
                // weights are loaded, then run a 1-token completion that pages
                // the mmap'd GGUF in off disk and pre-fills the system prompt's
                // KV cache (llm::warm_local_model). With cache_prompt on every
                // real request, the user's FIRST question then pays only for
                // its own retrieved context instead of a full cold start.
                tauri::async_runtime::spawn(async {
                    let client = reqwest::Client::new();
                    for _ in 0..120 {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        match client.get("http://127.0.0.1:8080/health").send().await {
                            Ok(r) if r.status().is_success() => {
                                lighthouse_core::llm::warm_local_model().await;
                                return;
                            }
                            _ => {}
                        }
                    }
                });
            }
            Err(e) => eprintln!("local model failed to start: {e}"),
        }
    }

    /// Keep the local model server in sync with what's on disk (3 s tick).
    /// Start llama-server when a model appears (a download just finished) and
    /// drive the uninstall handshake to completion.
    pub fn reconcile(&self, app: &AppHandle) {
        if uninstall_marker_path().exists() {
            let mut guard = self.llm.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(child) = guard.as_mut() {
                // Reap if it already exited; otherwise ask it to stop so the
                // memory-mapped weights unlock before deletion.
                match child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        drop(guard);
                        self.finish_uninstall();
                    }
                    _ => {
                        let mut uninstalling =
                            self.uninstalling.lock().unwrap_or_else(|p| p.into_inner());
                        if !*uninstalling {
                            *uninstalling = true;
                            let _ = child.kill();
                        }
                        // wait for exit on a later tick
                    }
                }
            } else {
                drop(guard);
                self.finish_uninstall(); // nothing holding the file
            }
            return;
        }
        {
            let mut guard = self.llm.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(child) = guard.as_mut() {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    *guard = None; // crashed/exited — allow a restart below
                    drop(guard);
                    // GPU crash guard: a server that dies twice within 20 s of
                    // spawning while offload is on almost certainly hit a bad
                    // Vulkan driver. Persist llmDisableGpu so every future
                    // launch (this boot and the next) runs CPU-only instead of
                    // crash-looping. Delete the key from the settings file to
                    // re-try GPU after a driver update.
                    let lived = self
                        .spawned_at
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .take()
                        .map(|t| t.elapsed());
                    let mut quick =
                        self.quick_crashes.lock().unwrap_or_else(|p| p.into_inner());
                    if lived.is_some_and(|d| d < std::time::Duration::from_secs(20)) {
                        *quick += 1;
                    } else {
                        *quick = 0;
                    }
                    let gpu_enabled =
                        crate::read_settings(app)["llmDisableGpu"].as_bool() != Some(true);
                    if *quick >= 2 && gpu_enabled {
                        *quick = 0;
                        eprintln!(
                            "local model: crashed twice right after start with GPU offload — disabling GPU offload (llmDisableGpu)"
                        );
                        crate::write_settings(app, serde_json::json!({ "llmDisableGpu": true }));
                    }
                }
            }
        }
        self.start_local_llm(app);
    }

    /// Delete the weights, then clear the marker only once they're gone (a
    /// still-locked file retries next tick rather than silently staying).
    fn finish_uninstall(&self) {
        let mut remaining = false;
        for f in model_gguf_files() {
            if fs::remove_file(&f).is_err() && f.exists() {
                eprintln!("uninstall: could not remove {}", f.display());
                remaining = true;
            }
        }
        if !remaining {
            let _ = fs::remove_file(uninstall_marker_path());
        }
        *self.uninstalling.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }

    pub fn shutdown(&self) {
        if let Some(mut child) = self.llm.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Latest-release info surfaced to the tray + splash ("notify-only Phase A").
#[derive(Default)]
/// A newer release, when one is known: version plus (when the release carries
/// an installer asset for this platform) what to download for click-to-update.
#[derive(Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub asset_url: Option<String>,
    pub asset_name: Option<String>,
}

pub struct UpdateState(pub Mutex<Option<UpdateInfo>>);

impl Default for UpdateState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// The installer asset for THIS platform from a GitHub release's asset list
/// (the names the desktop-release pipeline publishes: Lighthouse-Setup.exe /
/// Lighthouse.dmg / *.AppImage / *.deb).
fn platform_asset(assets: &serde_json::Value) -> Option<(String, String)> {
    let list = assets.as_array()?;
    let pick = |pred: &dyn Fn(&str) -> bool| {
        list.iter().find_map(|a| {
            let name = a["name"].as_str()?;
            let url = a["browser_download_url"].as_str()?;
            pred(&name.to_ascii_lowercase()).then(|| (name.to_string(), url.to_string()))
        })
    };
    if cfg!(windows) {
        pick(&|n| n.ends_with(".exe"))
    } else if cfg!(target_os = "macos") {
        pick(&|n| n.ends_with(".dmg"))
    } else {
        // AppImage can at least be downloaded and run; .deb needs dpkg — the
        // releases page stays the Linux fallback when neither is present.
        pick(&|n| n.ends_with(".appimage"))
    }
}

fn version_tuple(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

/// Best-effort check for a newer GitHub release. Never blocks startup, never
/// downloads, never fails the app — it only arms the tray notice + an event.
pub async fn check_for_updates(app: AppHandle) {
    let current = env!("CARGO_PKG_VERSION");
    let client = match reqwest::Client::builder()
        .user_agent("lighthouse-app")
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let Ok(res) = client
        .get("https://api.github.com/repos/lmansf/lighthouse/releases/latest")
        .send()
        .await
    else {
        let _ = app.emit("update:state", serde_json::json!({ "phase": "none" }));
        return;
    };
    let Ok(body) = res.json::<serde_json::Value>().await else {
        return;
    };
    let latest = body["tag_name"].as_str().unwrap_or_default();
    let newer = matches!(
        (version_tuple(latest), version_tuple(current)),
        (Some(l), Some(c)) if l > c
    );
    if newer {
        let asset = platform_asset(&body["assets"]);
        if let Some(state) = app.try_state::<UpdateState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(UpdateInfo {
                version: latest.trim_start_matches('v').to_string(),
                asset_url: asset.as_ref().map(|(_, u)| u.clone()),
                asset_name: asset.as_ref().map(|(n, _)| n.clone()),
            });
        }
        let _ = app.emit(
            "update:state",
            serde_json::json!({
                "phase": "available",
                "version": latest,
                "url": RELEASE_PAGE_URL,
                "canInstall": asset.is_some(),
            }),
        );
        crate::rebuild_tray_menu(&app);
    } else {
        let _ = app.emit("update:state", serde_json::json!({ "phase": "none" }));
    }
}

/// Click-to-update. Windows: download the installer beside our app data and
/// launch it, then exit so it can replace files (NSIS drives the rest).
/// macOS: download + open the dmg (drag-to-Applications stays manual —
/// unsigned builds can't self-replace). Linux/no-asset: the releases page.
pub async fn update_now(app: AppHandle) -> serde_json::Value {
    let info = app
        .try_state::<UpdateState>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
    let Some(info) = info else {
        return serde_json::json!({ "ok": false, "reason": "no update known" });
    };
    let (Some(url), Some(name)) = (info.asset_url.clone(), info.asset_name.clone()) else {
        crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
        return serde_json::json!({ "ok": true, "action": "page" });
    };

    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("updates");
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join(&name);

    let download = async {
        let client = reqwest::Client::builder()
            .user_agent("lighthouse-app")
            .timeout(std::time::Duration::from_secs(600))
            .build()?;
        let bytes = client.get(&url).send().await?.error_for_status()?.bytes().await?;
        fs::write(&dest, &bytes)?;
        Ok::<_, anyhow::Error>(())
    };
    if let Err(e) = download.await {
        eprintln!("update download failed: {e}");
        crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
        return serde_json::json!({ "ok": false, "reason": "download failed", "action": "page" });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)); // AppImage
    }
    crate::open_with_os(&dest);
    if cfg!(windows) {
        // Give the installer a beat to start, then get out of its way.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        app.exit(0);
    }
    serde_json::json!({ "ok": true, "action": "installing" })
}
