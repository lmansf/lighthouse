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
use lighthouse_core::updates::version_tuple;
use tauri::{AppHandle, Emitter, Manager};

pub const RELEASE_PAGE_URL: &str = "https://github.com/lmansf/lighthouse/releases/latest";

/// The chat llama-server's actual launch state (G2 GPU status): whether it was
/// spawned with GPU offload, the `-ngl` layer count, and whether a chat child is
/// currently live. Surfaced read-only in the AI-models dialog via `model_status`
/// so the user sees the real acceleration state, not a guess.
#[derive(Clone, Copy, Default)]
pub struct GpuLaunchState {
    pub gpu: bool,
    pub layers: i64,
    pub running: bool,
}

#[derive(Default)]
pub struct Supervisor {
    llm: Mutex<Option<Child>>,
    uninstalling: Mutex<bool>,
    /// When the current llama-server was spawned — feeds the GPU crash guard.
    spawned_at: Mutex<Option<std::time::Instant>>,
    /// The chat llama-server's last known GPU launch state (G2). Set on a
    /// successful spawn, `running` cleared on every teardown path. `None` until
    /// the first chat server starts.
    gpu_state: Mutex<Option<GpuLaunchState>>,
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
    // Pinned base (see `lib.rs::app_data_base`) so supervisor logs sit with the
    // rest of the app-data across the 0.12.8 identifier rename.
    let dir = crate::app_data_base(app)?;
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
        // §22.4: never spawn (and so never health-poll/warm) the chat model in
        // safe mode — the embed server below has always had this gate; the chat
        // server is the heavier of the two and safe mode exists precisely to
        // keep heavyweight subsystems down while diagnosing a bad boot.
        if crate::boot_guard::safe_mode() {
            return;
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
        // Cap model threads at half the cores (2..=6) so llama-server can't peg
        // every core and freeze the UI on CPU-fallback machines; GPU offload
        // (below) is the common path, where -t only bounds prompt processing.
        // The index pool (index.rs) already self-caps the same way.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model)
            .args(["--host", "127.0.0.1", "--port", "8080"])
            .args(["-t", &(cores / 2).clamp(2, 6).to_string()])
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
        // Layer count is overridable (llmGpuLayers) for low-VRAM machines that
        // OOM at full offload; unset/negative ⇒ 999 = offload everything (the
        // fast default). Full offload stays safe on GPU-less machines via the
        // built-in CPU fallback + the quick-crash guard in reconcile().
        let ngl = crate::read_settings(app)["llmGpuLayers"]
            .as_i64()
            .filter(|n| *n >= 0)
            .unwrap_or(999);
        if !gpu_disabled {
            cmd.args(["-ngl", &ngl.to_string()]);
        }
        // Speculative decoding ("draft-then-verify", roadmap P2.1): when the
        // maintainer bundles a small draft model, llama-server drafts tokens
        // with it and the main model verifies a whole batch at once — faster
        // local generation with identical output. None bundled ⇒ normal
        // decoding (the default). Offload the draft to the GPU too when in use.
        if let Some(draft) = lighthouse_core::embed::bundled_draft_model() {
            cmd.arg("--model-draft")
                .arg(&draft)
                .args(["--draft-max", "16", "--draft-min", "4"]);
            if !gpu_disabled {
                cmd.args(["-ngld", &ngl.to_string()]);
            }
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
                // Record the real launch state for the AI-models dialog (G2).
                *self.gpu_state.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(GpuLaunchState { gpu: !gpu_disabled, layers: ngl, running: true });
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
        // The embedding warm-pass runs over the whole corpus on CPU; cap it hard
        // (1..=4 threads) so a background re-embed never saturates the machine.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model)
            .args(["--host", "127.0.0.1"])
            .args(["--port", &lighthouse_core::embed::EMBED_PORT.to_string()])
            .args(["-t", &(cores / 2).clamp(1, 4).to_string()])
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

    /// The chat llama-server's GPU launch state for the AI-models dialog (G2).
    /// `gpu`/`layers` are the durable launch config recorded on the last spawn;
    /// `running` is computed live from whether a chat child is currently held,
    /// so every teardown path reflects immediately without extra bookkeeping.
    /// `None` until the first chat server has been started this session.
    pub fn gpu_status(&self) -> Option<GpuLaunchState> {
        // Read + release the gpu_state lock FIRST (this statement's temporary
        // guard drops at the `;`), THEN take the llm lock. start_local_llm holds
        // llm while it sets gpu_state, so acquiring them in the opposite order
        // here without overlapping avoids a lock-order inversion.
        let mut s = (*self.gpu_state.lock().unwrap_or_else(|p| p.into_inner()))?;
        s.running = self.llm.lock().unwrap_or_else(|p| p.into_inner()).is_some();
        Some(s)
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

/// Updater "Phase B" gate: the minisign public key whose private half signs
/// release artifacts in CI (`tauri signer generate`; see docs/signing.md).
/// Baked at compile time from the LIGHTHOUSE_UPDATER_PUBKEY env (a repo
/// Actions *variable* — the public key is not a secret). When absent the
/// updater is strictly notify-only: click-to-update opens the releases page
/// and the app NEVER downloads-and-executes an artifact it cannot verify
/// (docs/auto-updater-design.md §2 — an unverified auto-apply is an RCE
/// hand-off, so unsigned builds fail closed).
const UPDATER_PUBKEY: Option<&str> = option_env!("LIGHTHOUSE_UPDATER_PUBKEY");

/// The baked-in updater public key, if this build carries one.
pub fn updater_pubkey() -> Option<&'static str> {
    UPDATER_PUBKEY.map(str::trim).filter(|k| !k.is_empty())
}

/// A newer release, when one is known: version plus (when the release carries
/// an installer asset for this platform) what to download for click-to-update,
/// and the detached minisign signature that gates actually running it.
#[derive(Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub asset_url: Option<String>,
    pub asset_name: Option<String>,
    /// `<asset_name>.sig` from the same release (base64 minisign signature,
    /// produced by CI when the signing key is configured). Verification is
    /// mandatory before install — no sig ⇒ notify-only for that release.
    pub sig_url: Option<String>,
    /// How the picked asset installs (`lighthouse_core::updates::pick_update_asset`):
    /// Windows installer / macOS `.app.tar.gz` in-place swap / macOS `.dmg`
    /// fallback / Linux AppImage. `None` when the release carries no installable
    /// asset for this platform (a `.deb`-only Linux release stays notify-only).
    pub kind: Option<lighthouse_core::updates::InstallKind>,
    /// The release's SIGNED manifest — `latest.json` and its `latest.json.sig`,
    /// both from the same release. The artifact `.sig` proves only that the
    /// BYTES are ours, so an OLDER, still validly-signed installer re-published
    /// under a newer tag used to install cleanly (red-team 2026-08 "forced
    /// downgrade"). The manifest is signed with the same key and names the
    /// version AND this platform's asset, so `update_now` authorizes against
    /// IT. Absent ⇒ notify-only (fail closed).
    pub manifest_url: Option<String>,
    pub manifest_sig_url: Option<String>,
}

pub struct UpdateState(pub Mutex<Option<UpdateInfo>>);

impl Default for UpdateState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Coalesces update checks so the app can re-check when it returns to the
/// foreground (an on-focus nudge from the UI) WITHOUT hammering the GitHub API
/// on every focus edge. Holds the instant of the last check from ANY source —
/// the 6 h background loop or a focus nudge — so a nudge right after a scheduled
/// check is a no-op.
#[derive(Default)]
pub struct UpdateCheckClock(Mutex<Option<std::time::Instant>>);

impl UpdateCheckClock {
    /// Record that a check just ran.
    fn mark(&self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
    }
    /// True when no check has run yet, or at least `min` has elapsed since one.
    fn due(&self, min: std::time::Duration) -> bool {
        let last = *self.0.lock().unwrap_or_else(|p| p.into_inner());
        last.map_or(true, |t| t.elapsed() >= min)
    }
}

/// The installer asset for THIS platform + how to install it, chosen by the
/// pure `lighthouse_core::updates::pick_update_asset` verdict over the release's
/// asset names — so the per-platform choice (Windows `.exe` / macOS
/// `.app.tar.gz`-preferred-over-`.dmg` / Linux `.AppImage`, `.deb` never) is a
/// table the engine's tests pin, not `cfg!` logic scattered in the shell.
/// Returns `(name, download_url, kind)`.
fn platform_asset(
    assets: &serde_json::Value,
) -> Option<(String, String, lighthouse_core::updates::InstallKind)> {
    use lighthouse_core::updates::UpdatePlatform;
    let list = assets.as_array()?;
    let names: Vec<String> = list
        .iter()
        .filter_map(|a| a["name"].as_str().map(String::from))
        .collect();
    let platform = if cfg!(windows) {
        UpdatePlatform::Windows
    } else if cfg!(target_os = "macos") {
        UpdatePlatform::Macos
    } else {
        UpdatePlatform::Linux
    };
    let picked = lighthouse_core::updates::pick_update_asset(platform, &names)?;
    // Resolve the download URL for the chosen asset name.
    let url = list.iter().find_map(|a| {
        (a["name"].as_str()? == picked.name)
            .then(|| a["browser_download_url"].as_str().map(String::from))
            .flatten()
    })?;
    Some((picked.name, url, picked.kind))
}

/// The `browser_download_url` of the release asset named `name` (case-
/// insensitive) — the detached `.sig`, and the signed-manifest pair that binds
/// an asset to a version. (`version_tuple` now comes from the engine: the
/// comparison that AUTHORIZES an install has to be tauri-free and unit-tested.)
fn release_asset_url(assets: &serde_json::Value, name: &str) -> Option<String> {
    let want = name.trim().to_ascii_lowercase();
    assets.as_array()?.iter().find_map(|a| {
        (a["name"].as_str()?.to_ascii_lowercase() == want)
            .then(|| a["browser_download_url"].as_str().map(String::from))
            .flatten()
    })
}

/// On-focus update nudge: run a check only if at least `min` has elapsed since
/// the last one (any source), so returning to the foreground can surface a
/// freshly-shipped release without waiting for the next 6 h tick or a restart —
/// while a focus storm can never spam GitHub. Best-effort and non-blocking,
/// exactly like `check_for_updates` (which stamps the shared clock itself).
pub async fn check_for_updates_throttled(app: AppHandle, min: std::time::Duration) {
    let due = app
        .try_state::<UpdateCheckClock>()
        .map(|c| c.due(min))
        .unwrap_or(true);
    if due {
        check_for_updates(app).await;
    }
}

/// Best-effort check for a newer GitHub release. Never blocks startup, never
/// downloads, never fails the app — it only arms the tray notice + an event.
pub async fn check_for_updates(app: AppHandle) {
    // Stamp the shared clock up front so an on-focus nudge that lands right
    // after this scheduled check is correctly throttled out (and two nudges
    // racing collapse to at most one extra request).
    if let Some(clock) = app.try_state::<UpdateCheckClock>() {
        clock.mark();
    }
    let current = env!("CARGO_PKG_VERSION");
    let client = match reqwest::Client::builder()
        .user_agent("lighthouse-app")
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    lighthouse_core::egress::record(
        "https://api.github.com/repos/lmansf/lighthouse/releases/latest",
        lighthouse_core::egress::PURPOSE_UPDATE_CHECK,
    );
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
        // The detached signature for this platform's asset, uploaded by CI
        // beside it when release signing is configured.
        let sig_url = asset
            .as_ref()
            .and_then(|(name, _, _)| release_asset_url(&body["assets"], &format!("{name}.sig")));
        // The release's SIGNED manifest, written by the updater-manifest CI
        // job: it carries the version and, per platform, the asset URL + the
        // signature CI made for those exact bytes. Without it an install cannot
        // bind bytes to a VERSION, so it stays notify-only (red-team 2026-08).
        let manifest_url = release_asset_url(&body["assets"], "latest.json");
        let manifest_sig_url = release_asset_url(&body["assets"], "latest.json.sig");
        // In-app install requires an asset AND a verifiable signature AND the
        // signed manifest AND a baked-in key to verify against — anything less
        // is notify-only.
        let can_install = asset.is_some()
            && sig_url.is_some()
            && manifest_url.is_some()
            && manifest_sig_url.is_some()
            && updater_pubkey().is_some();
        if let Some(state) = app.try_state::<UpdateState>() {
            *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(UpdateInfo {
                version: latest.trim_start_matches('v').to_string(),
                asset_url: asset.as_ref().map(|(_, u, _)| u.clone()),
                asset_name: asset.as_ref().map(|(n, _, _)| n.clone()),
                sig_url,
                kind: asset.as_ref().map(|(_, _, k)| *k),
                manifest_url,
                manifest_sig_url,
            });
        }
        let _ = app.emit(
            "update:state",
            serde_json::json!({
                "phase": "available",
                "version": latest.trim_start_matches('v'), // match update_state's shape
                "url": RELEASE_PAGE_URL,
                "canInstall": can_install,
            }),
        );
        crate::rebuild_tray_menu(&app);
    } else {
        let _ = app.emit("update:state", serde_json::json!({ "phase": "none" }));
    }
}

/// Click-to-update — updater Phase B (download + AUTHORIZE + VERIFY +
/// install-on-consent). Requires a baked-in updater public key, a `.sig` beside
/// the release asset, AND the release's SIGNED manifest (`latest.json` +
/// `latest.json.sig`) — the manifest is what binds bytes to a VERSION, so a
/// genuinely-signed OLDER build re-published under a newer tag is refused
/// (red-team 2026-08 "forced downgrade"). The installer is downloaded,
/// authorized against the manifest, minisign-verified, and only then run
/// (Windows: launch NSIS + exit so it can replace files; macOS: unpack the
/// verified `.app.tar.gz` and swap the running bundle IN PLACE, then relaunch —
/// the `.dmg` is the manual-drag fallback only when a release carries no signed
/// archive; Linux: chmod + open the AppImage). Without a key or signature this
/// is strictly notify-only and opens the releases page — the previous behavior
/// of executing an unverifiable download is deliberately removed
/// (docs/auto-updater-design.md §2).
pub async fn update_now(app: AppHandle) -> serde_json::Value {
    let info = app
        .try_state::<UpdateState>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
    let Some(info) = info else {
        return serde_json::json!({ "ok": false, "reason": "no update known" });
    };
    let (
        Some(pubkey),
        Some(url),
        Some(name),
        Some(sig_url),
        Some(manifest_url),
        Some(manifest_sig_url),
    ) = (
        updater_pubkey(),
        info.asset_url.clone(),
        info.asset_name.clone(),
        info.sig_url.clone(),
        info.manifest_url.clone(),
        info.manifest_sig_url.clone(),
    ) else {
        // Notify-only: no key baked into this build, or the release carries no
        // verifiable signature for this platform's asset, or no SIGNED manifest
        // to bind that asset to a version — fail closed, the user clicks
        // through to the releases page.
        crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
        return serde_json::json!({ "ok": true, "action": "page" });
    };

    // Pinned base (see `lib.rs::app_data_base`) so update staging stays with the
    // rest of the app-data across the 0.12.8 identifier rename.
    let dir = crate::app_data_base(&app)
        .unwrap_or_else(std::env::temp_dir)
        .join("updates");
    let _ = fs::create_dir_all(&dir);
    // §56 #2: the asset name is a REMOTE string off the release manifest and it
    // reaches the filesystem BEFORE the signature gate below can run, so it
    // never picks the path — an absolute name or a `..` component would be an
    // arbitrary-file create+truncate (and delete, on the failure arms) outside
    // anything the pinned key protects. Refusal degrades to notify-only, like
    // every other failure arm here. (Derivation + tests live in the tauri-free
    // engine: lighthouse_core::updates::staging_path.)
    let Some(dest) = lighthouse_core::updates::staging_path(&dir, &name) else {
        eprintln!("update REJECTED — unsafe asset name in the release manifest: {name}");
        crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
        return serde_json::json!({ "ok": false, "reason": "unsafe asset name", "action": "page" });
    };

    let download = async {
        use std::io::Write as _;
        let client = reqwest::Client::builder()
            .user_agent("lighthouse-app")
            .timeout(std::time::Duration::from_secs(600))
            .build()?;
        // Stream to disk: installers carry the bundled models now (hundreds
        // of MB) — buffering the whole body would spike memory for nothing.
        lighthouse_core::egress::record(&url, lighthouse_core::egress::PURPOSE_UPDATE_DOWNLOAD);
        let mut res = client.get(&url).send().await?.error_for_status()?;
        let mut file = fs::File::create(&dest)?;
        while let Some(chunk) = res.chunk().await? {
            file.write_all(&chunk)?;
        }
        file.flush()?;
        lighthouse_core::egress::record(&sig_url, lighthouse_core::egress::PURPOSE_UPDATE_DOWNLOAD);
        let sig = client
            .get(&sig_url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        // The release's SIGNED manifest + its signature — what binds these
        // bytes to a VERSION (see the authorization below).
        lighthouse_core::egress::record(
            &manifest_url,
            lighthouse_core::egress::PURPOSE_UPDATE_DOWNLOAD,
        );
        let manifest = client
            .get(&manifest_url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        lighthouse_core::egress::record(
            &manifest_sig_url,
            lighthouse_core::egress::PURPOSE_UPDATE_DOWNLOAD,
        );
        let manifest_sig = client
            .get(&manifest_sig_url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        Ok::<_, anyhow::Error>((sig, manifest, manifest_sig))
    };
    let (sig, manifest, manifest_sig) = match download.await {
        Ok(parts) => parts,
        Err(e) => {
            eprintln!("update download failed: {e}");
            let _ = fs::remove_file(&dest);
            crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
            return serde_json::json!({ "ok": false, "reason": "download failed", "action": "page" });
        }
    };

    // WHY (red-team 2026-08 "forced downgrade"): a signature binds BYTES to the
    // key, not bytes to a VERSION — so an OLDER, still validly-signed installer
    // re-published under a newer tag installed cleanly here, re-arming every fix
    // since while the banner read the higher version. The check-time comparison
    // ran against the attacker-chosen TAG and is not an authorization.
    // Authorize against the release's SIGNED manifest, which names the version
    // AND this asset, and re-assert "strictly newer than the build that is
    // running" HERE, at install.
    let floor = lighthouse_core::updates::read_update_floor(&dir);
    let authorized = match lighthouse_core::updates::authorize_update(
        &manifest,
        &manifest_sig,
        pubkey,
        env!("CARGO_PKG_VERSION"),
        floor.as_deref(),
        &name,
    ) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("update REJECTED — {e}");
            let _ = fs::remove_file(&dest);
            crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
            return serde_json::json!({ "ok": false, "reason": "update not authorized", "action": "page" });
        }
    };

    // Verify BEFORE anything can execute the artifact. Failure deletes the
    // download and falls back to the releases page — never a silent retry.
    let verify = || -> anyhow::Result<()> {
        let data = fs::read(&dest)?;
        lighthouse_core::updates::verify_update_signature(&data, &sig, pubkey)?;
        // …and against the signature the MANIFEST attests for this asset: the
        // leg that binds these exact bytes to `authorized.version`.
        lighthouse_core::updates::verify_update_signature(&data, &authorized.signature, pubkey)
    };
    if let Err(e) = verify() {
        eprintln!("update REJECTED — signature verification failed: {e}");
        let _ = fs::remove_file(&dest);
        crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
        return serde_json::json!({ "ok": false, "reason": "signature verification failed", "action": "page" });
    }
    eprintln!(
        "update artifact signature verified ({name}, {} → {})",
        env!("CARGO_PKG_VERSION"),
        authorized.version
    );
    // Raise the monotonic floor before the hand-off (this process may not come
    // back): from here on this install refuses anything OLDER than what it just
    // authorized, so a superseded release cannot be re-offered under a new tag.
    // Retrying the same version is still allowed (the floor is a `>=` gate).
    lighthouse_core::updates::record_update_floor(&dir, &authorized.version);

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)); // AppImage
    }
    if cfg!(windows) {
        // The installer overwrites llm\/embed\ inside the install dir,
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
    // Install per the picked asset's kind. macOS is the one true in-place path:
    // unpack the (already signature-verified) `.app.tar.gz` and swap the running
    // bundle, then relaunch — no dmg drag, and the app-data/vault dirs (resolved
    // under `app_data_base`, never the bundle) are untouched. Everything else
    // keeps the existing OS hand-off; a macOS `.dmg` (unsigned release, no
    // `.app.tar.gz`) opens for a manual drag as before.
    #[cfg(target_os = "macos")]
    {
        if matches!(
            info.kind,
            Some(lighthouse_core::updates::InstallKind::MacAppArchive)
        ) {
            match install_macos_app_archive(&dest) {
                Ok(bundle) => {
                    crate::open_with_os(&bundle); // relaunch the freshly-swapped .app
                    app.exit(0);
                    return serde_json::json!({ "ok": true, "action": "installed" });
                }
                Err(e) => {
                    eprintln!("in-place app replace failed — falling back to the releases page: {e}");
                    crate::open_with_os(std::path::Path::new(RELEASE_PAGE_URL));
                    return serde_json::json!({ "ok": false, "reason": "in-place replace failed", "action": "page" });
                }
            }
        }
        crate::open_with_os(&dest); // MacDmg: open the verified dmg (manual drag)
        serde_json::json!({ "ok": true, "action": "installing" })
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Per-platform honesty (docs/auto-updater-design.md §0): Windows launches
        // the NSIS installer with its NORMAL UI — an update is a visible, consented
        // install, never a silent `/S` background swap. Linux just launches the
        // freshly-downloaded, verified AppImage. A `.deb`-only Linux release never
        // reaches here at all: pick_update_asset returns None for it, so the caller
        // took the notify-only branch above (a `.deb` needs dpkg/root and touches
        // the system package DB — in-app apply would misrepresent what it changed).
        crate::open_with_os(&dest);
        if cfg!(windows) {
            // Give the installer a beat to start, then get out of its way.
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            app.exit(0);
        }
        serde_json::json!({ "ok": true, "action": "installing" })
    }
}

/// Replace the running `.app` bundle in place with the one inside a
/// signature-VERIFIED `.app.tar.gz`, returning the bundle path to relaunch.
/// Fails closed — an unwritable install location (e.g. `/Applications` without
/// admin), an extraction failure, or no `.app` in the archive leaves the current
/// bundle untouched so the caller falls back to the releases page; the app is
/// never left half-swapped. Staging is on the target's own volume, so the swap
/// is a rename, and it touches ONLY the bundle — the app-data/vault dirs live
/// elsewhere (`lib.rs::app_data_base`).
#[cfg(target_os = "macos")]
fn install_macos_app_archive(archive: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    use std::process::Command;
    let exe = std::env::current_exe().map_err(|e| anyhow::anyhow!("current_exe: {e}"))?;
    // …/Lighthouse.app/Contents/MacOS/Lighthouse → the enclosing `*.app` dir.
    let app_dir = exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or_else(|| anyhow::anyhow!("not running from a .app bundle"))?
        .to_path_buf();
    let parent = app_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!(".app has no parent directory"))?
        .to_path_buf();
    // Fail closed if the install location isn't writable, rather than prompt for
    // admin mid-update: the caller degrades to notify-only.
    let probe = parent.join(".lighthouse-update-probe");
    fs::write(&probe, b"x").map_err(|e| anyhow::anyhow!("install location not writable: {e}"))?;
    let _ = fs::remove_file(&probe);
    // Stage on the SAME volume as the target so the swap is a cheap rename.
    let stage = parent.join(".lighthouse-update-staged");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| anyhow::anyhow!("staging dir: {e}"))?;
    let extracted = Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&stage)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !extracted {
        let _ = fs::remove_dir_all(&stage);
        return Err(anyhow::anyhow!("tar extraction failed"));
    }
    let new_app = fs::read_dir(&stage)
        .map_err(|e| anyhow::anyhow!("read staged dir: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or_else(|| anyhow::anyhow!("no .app inside the updater archive"))?;
    // Swap: move the current bundle aside, move the new one in. On any failure
    // restore the old bundle so the app is never left missing.
    let backup = app_dir.with_extension("app.old");
    let _ = fs::remove_dir_all(&backup);
    fs::rename(&app_dir, &backup).map_err(|e| anyhow::anyhow!("move current app aside: {e}"))?;
    if let Err(e) = fs::rename(&new_app, &app_dir) {
        let _ = fs::rename(&backup, &app_dir); // restore
        let _ = fs::remove_dir_all(&stage);
        return Err(anyhow::anyhow!("install new app: {e}"));
    }
    let _ = fs::remove_dir_all(&backup);
    let _ = fs::remove_dir_all(&stage);
    Ok(app_dir)
}
