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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    /// Second llama-server instance serving the bundled embedding model (B2
    /// hybrid search) — CPU-only, port 8091, no uninstall handshake (the
    /// weights are installer-owned). See start_embed_llm.
    embed: Mutex<Option<Child>>,
    embed_spawned_at: Mutex<Option<std::time::Instant>>,
    /// Consecutive fast exits of the embed server. Three in a row (port taken,
    /// unusable weights, too-old bundled build) means "not on this machine/
    /// boot" — stop respawning instead of crash-looping; retrieval simply
    /// stays lexical.
    embed_quick_exits: Mutex<u32>,
    /// Set by `halt()` when an installer handoff is in progress: reconcile
    /// must not respawn children whose DLLs the installer is about to replace.
    halted: AtomicBool,
    /// Set while the app is backgrounded (hidden to the tray, or sat unfocused
    /// past the idle grace) with `backgroundConserve` on: reconcile tears the
    /// children down and refuses to respawn until `resume()`. This frees the
    /// llama-server RAM + CPU that were the bulk of "the app slows my machine
    /// even when it isn't the active window". Reversible, unlike `halted`.
    suspended: AtomicBool,
}

/// In-flight `chat_ask` streams. `suspend()` and a suspended `reconcile()` must
/// never kill the chat server out from under a live answer, so teardown of the
/// chat child is deferred while this is > 0 (the next reconcile tick reaps it
/// once the stream ends). Embedding calls are short, so the embed child is
/// never guarded this way.
static ACTIVE_CHATS: AtomicUsize = AtomicUsize::new(0);

/// RAII counter for one in-flight chat stream — held for the whole lifetime of
/// a `chat_ask`, decremented on Drop (so an early return or panic still frees
/// the guard and lets a pending suspend reap the chat child).
pub struct ChatGuard;

impl ChatGuard {
    pub fn new() -> Self {
        ACTIVE_CHATS.fetch_add(1, Ordering::SeqCst);
        ChatGuard
    }
}

impl Default for ChatGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ChatGuard {
    fn drop(&mut self) {
        ACTIVE_CHATS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Windows: every supervised child joins a job object configured to kill its
/// members when the job's last handle closes. The handle is deliberately
/// leaked, so the OS closes it exactly when THIS process dies — clean quit,
/// crash, or the installer's hard TerminateProcess — and the children die
/// with it. Without this, an installer that kills the running app leaves
/// llama-server orphans holding llm\*.dll loaded (a loaded DLL is an
/// unwritable file), and extraction fails with "Error opening file for
/// writing" (0.6.x field reports). Best-effort: on any API failure the
/// children simply stay unassigned and the installer-side taskkill hook
/// remains the backstop.
#[cfg(windows)]
fn assign_to_death_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job); // a job we can't configure would be a no-op
            return 0;
        }
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
fn assign_to_death_job(_child: &Child) {}

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
                assign_to_death_job(&child); // dies with the shell, no matter how the shell dies
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

    /// Launch the embedding llama-server (B2 hybrid search) when semantic
    /// search is on, the bundled model + binary exist, and this isn't a
    /// safe-mode boot. CPU-only on purpose: the model is ~137 MB and fast on
    /// CPU, embedding must never contend with the chat model for VRAM, and
    /// the Vulkan crash class that safe mode exists for can't reach it.
    fn start_embed_llm(&self, app: &AppHandle) {
        let mut guard = self.embed.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_some() {
            return; // already running
        }
        if crate::boot_guard::safe_mode() {
            return;
        }
        if *self
            .embed_quick_exits
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            >= 3
        {
            return; // gave up this boot — see the field comment
        }
        let enabled = crate::read_settings(app)["semanticSearch"].as_bool() != Some(false);
        if !enabled {
            return;
        }
        let Some(model) = lighthouse_core::embed::bundled_embed_model() else {
            return; // dev run / stripped install — hybrid search silently off
        };
        let bin = llm_root().join(if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        });
        if !bin.exists() {
            return;
        }
        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model)
            .args(["--host", "127.0.0.1"])
            .args(["--port", &lighthouse_core::embed::EMBED_PORT.to_string()])
            // Embeddings endpoint + sequence pooling. nomic-embed's GGUF
            // carries pooling metadata, but stating it keeps us independent of
            // build defaults.
            .args(["--embedding", "--pooling", "mean"])
            // Chunks are capped well under this before embedding (embed.rs);
            // 2048 keeps the context buffers tiny.
            .args(["-c", "2048"])
            // CPU-only (see doc comment above).
            .args(["-ngl", "0"])
            .current_dir(llm_root())
            .stdin(Stdio::null());
        match (
            log_file(app, "local-embed.log"),
            log_file(app, "local-embed.log"),
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
                assign_to_death_job(&child); // dies with the shell, no matter how the shell dies
                *guard = Some(child);
                *self
                    .embed_spawned_at
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
                // Once healthy, kick the vector warm pass so a fresh install
                // embeds its corpus in the background instead of at first ask.
                tauri::async_runtime::spawn(async {
                    let client = reqwest::Client::new();
                    let url = format!(
                        "http://127.0.0.1:{}/health",
                        lighthouse_core::embed::EMBED_PORT
                    );
                    for _ in 0..60 {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        match client.get(&url).send().await {
                            Ok(r) if r.status().is_success() => {
                                lighthouse_core::embed::nudge_warm();
                                return;
                            }
                            _ => {}
                        }
                    }
                });
            }
            Err(e) => eprintln!("embedding server failed to start: {e}"),
        }
    }

    /// Keep the embedding server in sync with the toggle (and count crashes).
    fn reconcile_embed(&self, app: &AppHandle) {
        let enabled = crate::read_settings(app)["semanticSearch"].as_bool() != Some(false);
        {
            let mut guard = self.embed.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(child) = guard.as_mut() {
                if !enabled {
                    // Toggled off: stop the server (retrieval already went
                    // lexical the moment the setting was written).
                    let _ = child.kill();
                    let _ = child.wait();
                    *guard = None;
                    return;
                }
                if matches!(child.try_wait(), Ok(Some(_))) {
                    *guard = None; // exited — maybe respawn below
                    let lived = self
                        .embed_spawned_at
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .take()
                        .map(|t| t.elapsed());
                    let mut quick = self
                        .embed_quick_exits
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if lived.is_some_and(|d| d < std::time::Duration::from_secs(20)) {
                        *quick += 1;
                        if *quick == 3 {
                            eprintln!(
                                "embedding server exited quickly {quick} times — giving up until next launch (hybrid search stays off, retrieval is lexical)"
                            );
                        }
                    } else {
                        *quick = 0;
                    }
                }
            }
        }
        self.start_embed_llm(app);
    }

    /// Keep the local model server in sync with what's on disk (3 s tick).
    /// Start llama-server when a model appears (a download just finished) and
    /// drive the uninstall handshake to completion.
    pub fn reconcile(&self, app: &AppHandle) {
        if self.halted.load(Ordering::SeqCst) {
            return; // installer handoff in progress — nothing may respawn
        }
        if self.suspended.load(Ordering::SeqCst) {
            // Backgrounded: keep both children down (reaping the chat child once
            // any in-flight answer finishes) rather than respawning them, so a
            // tray-resident app doesn't hold the model's RAM/CPU. resume()
            // clears the flag and the next tick brings them back.
            self.idle_teardown();
            return;
        }
        // The embedding server is independent of the chat model's install/
        // uninstall lifecycle below — reconcile it first, unconditionally.
        self.reconcile_embed(app);
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
        if let Some(mut child) = self.embed.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Stop every supervised child AND refuse to respawn any (reconcile
    /// no-ops from here on). Called right before handing off to an installer:
    /// the children keep DLLs inside the install dir loaded, and on Windows a
    /// loaded DLL is an unwritable file — the 3 s reconcile tick must not
    /// resurrect one between our shutdown and the app's exit.
    pub fn halt(&self) {
        self.halted.store(true, Ordering::SeqCst);
        self.shutdown();
    }

    /// Background the local servers: stop them and refuse to respawn until
    /// `resume()`. The embed child dies immediately; the chat child is spared
    /// while an answer is still streaming (`ACTIVE_CHATS`) and reaped on a later
    /// reconcile tick once idle. Called when the app is hidden to the tray, or
    /// has sat unfocused past the idle grace, with `backgroundConserve` on.
    /// Idempotent and reversible — unlike `halt()`.
    pub fn suspend(&self) {
        self.suspended.store(true, Ordering::SeqCst);
        self.idle_teardown();
    }

    /// Foreground again: allow respawns. The caller should run one `reconcile()`
    /// immediately afterwards so the servers come back (and re-warm) without
    /// waiting for the next 3 s tick. No-op if not suspended.
    pub fn resume(&self) {
        self.suspended.store(false, Ordering::SeqCst);
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::SeqCst)
    }

    /// Kill the embed child now, and the chat child too if no answer is
    /// streaming. A chat streaming at suspend time keeps its server until the
    /// stream ends, when the next suspended `reconcile()` tick reaps it here.
    fn idle_teardown(&self) {
        if let Some(mut child) = self.embed.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if ACTIVE_CHATS.load(Ordering::SeqCst) == 0 {
            if let Some(mut child) = self.llm.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = child.kill();
                let _ = child.wait();
            }
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
                "version": latest.trim_start_matches('v'), // match update_state's shape
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
        use std::io::Write as _;
        let client = reqwest::Client::builder()
            .user_agent("lighthouse-app")
            .timeout(std::time::Duration::from_secs(600))
            .build()?;
        // Stream to disk: installers carry the bundled models now (hundreds
        // of MB) — buffering the whole body would spike memory for nothing.
        let mut res = client.get(&url).send().await?.error_for_status()?;
        let mut file = fs::File::create(&dest)?;
        while let Some(chunk) = res.chunk().await? {
            file.write_all(&chunk)?;
        }
        file.flush()?;
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
    if cfg!(windows) {
        // The installer overwrites llm\/embed\/tts\ inside the install dir,
        // and our llama-server children keep those DLLs loaded — on Windows a
        // loaded DLL is an unwritable file ("Error opening file for writing",
        // the 0.6.x update failure). Stop the children AND the reconcile tick
        // that would respawn them BEFORE launching the installer; the app
        // exits below either way. (The installer's PREINSTALL hook also
        // taskkills strays left behind by crashed sessions.)
        if let Some(sup) = app.try_state::<Supervisor>() {
            sup.halt();
        }
    }
    crate::open_with_os(&dest);
    if cfg!(windows) {
        // Give the installer a beat to start, then get out of its way.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        app.exit(0);
    }
    serde_json::json!({ "ok": true, "action": "installing" })
}
