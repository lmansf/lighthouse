//! Optional, on-demand download of the private local model (port of
//! `src/server/localModel.ts`). The ~4.2 GB GGUF is fetched once from Hugging
//! Face into the user's data dir; the desktop shell watches the directory and
//! runs `llama-server` against it. Uninstall is a marker-file handshake with
//! the shell (which owns the process whose mmap locks the weights).
//!
//! Downloads are RESUMABLE: the stream lands in a `<model>.part` file which is
//! KEPT when the transfer is interrupted, fails, or is paused (a DELETE /
//! `model_uninstall` while a download is in flight = pause). The next install
//! sends `Range: bytes=<size>-` and appends the remainder (HTTP 206); servers
//! that ignore Range (HTTP 200) restart from zero. Integrity stays strict —
//! there is no upstream digest, so the checks are: a `.part` prefix must carry
//! the GGUF magic to be resumed at all, and the completed file must match the
//! advertised byte count and the magic exactly, or it is deleted rather than
//! ever renamed into place as a "ready" model.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use futures::StreamExt;
use serde::Serialize;

use crate::config::resources_dir;

fn model_url() -> String {
    std::env::var("LIGHTHOUSE_LOCAL_MODEL_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            "https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf".to_string()
        })
}

fn model_file() -> String {
    std::env::var("LIGHTHOUSE_LOCAL_MODEL_FILE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf".to_string())
}

/// A real model is hundreds of MB; guards against counting a stub as ready.
const MIN_BYTES: u64 = 100_000_000;

/// Marker file the desktop shell watches to perform an uninstall.
const UNINSTALL_MARKER: &str = ".uninstall";

/// Where NEW downloads are written (LIGHTHOUSE_MODELS_DIR in the packaged app;
/// `resources/llm` in dev).
pub fn models_dir() -> PathBuf {
    let dir = std::env::var("LIGHTHOUSE_MODELS_DIR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resources_dir().join("llm"));
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Every directory a usable model might sit in. Must match the shell's
/// `findModel()` so the picker's "installed" state agrees with what runs.
fn search_dirs() -> Vec<PathBuf> {
    let download = models_dir();
    let bundled = resources_dir().join("llm");
    if download == bundled {
        vec![download]
    } else {
        vec![download, bundled]
    }
}

/// True if the file starts with the GGUF magic — a real model file.
fn is_gguf_file(path: &Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)
        .map(|_| &magic == b"GGUF")
        .unwrap_or(false)
}

/// Absolute path to a present, USABLE `.gguf` in any search dir, or None.
fn installed_model() -> Option<PathBuf> {
    for dir in search_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if !name.ends_with(".gguf") {
                continue;
            }
            let p = e.path();
            if fs::metadata(&p)
                .map(|m| m.len() > MIN_BYTES)
                .unwrap_or(false)
                && is_gguf_file(&p)
            {
                return Some(p);
            }
        }
    }
    None
}

/// True if ANY `.gguf` exists — a real model OR a stale/corrupt leftover — so
/// uninstall can always clear one.
fn has_model_file() -> bool {
    search_dirs().iter().any(|dir| {
        fs::read_dir(dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .ends_with(".gguf")
                })
            })
            .unwrap_or(false)
    })
}

fn uninstall_pending() -> bool {
    models_dir().join(UNINSTALL_MARKER).exists()
}

/// Runtime signal: is an on-device PRIVATE-model backend wired on THIS build
/// right now? Desktop ignores it (llama-server is always its backend); a mobile
/// shell sets it true once its plugin confirms a usable backend for THIS device
/// — Apple Foundation Models reports `.available`, or a bundled small-model GGUF
/// is present and loadable (add-mobile-local-inference; docs/ios-private-model.md).
/// Default false so a mobile build FAILS CLOSED — the private model stays hidden
/// (exactly the pre-reversal behavior) until the plugin proves a backend.
static ON_DEVICE_BACKEND: AtomicBool = AtomicBool::new(false);

/// The shell reports whether an on-device private-model backend is available for
/// this device (called from the iOS plugin's availability probe at boot and on
/// Apple-Intelligence state changes; a desktop build never needs it). Cheap and
/// thread-safe. KEEP IN SYNC with src/server/localModel.ts::setOnDeviceBackend.
pub fn set_on_device_backend(available: bool) {
    ON_DEVICE_BACKEND.store(available, Ordering::Relaxed);
}

/// Whether the shell has reported an on-device backend (default false).
pub fn on_device_backend() -> bool {
    ON_DEVICE_BACKEND.load(Ordering::Relaxed)
}

/// §32 §7 ADVERTISE: the context window the local endpoint's /health body
/// advertised (`contextSize`), in tokens. 0 = nothing advertised — the §1
/// resolution then falls to the on-device flag's 4096 default or llama-6144.
/// Written by `llm::local_health`'s probe; read by the tier resolution.
static ADVERTISED_CTX: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn set_advertised_ctx(tokens: Option<u32>) {
    ADVERTISED_CTX.store(tokens.unwrap_or(0), Ordering::Relaxed);
}

pub fn advertised_ctx() -> Option<u32> {
    match ADVERTISED_CTX.load(Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// §32 §7 OBSERVE: local diagnostics counters for the bridge's terminal
/// markers — shell.log only (the shell captures engine stderr), NO telemetry.
/// After §1-§6 the overflow counter should read 0 in acceptance.
static FM_OVERFLOWS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static FM_GUARDRAILS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn note_fm_marker(kind: &str) {
    let (counter, label) = match kind {
        "FM_OVERFLOW" => (&FM_OVERFLOWS, "overflow"),
        _ => (&FM_GUARDRAILS, "guardrail"),
    };
    let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
    eprintln!("[lighthouse] on-device {label} marker #{n} (local diagnostics only)");
}

pub fn fm_overflow_count() -> u64 {
    FM_OVERFLOWS.load(Ordering::Relaxed)
}

/// §3 / add-mobile-local-inference verdict (pure, host-testable): can a PRIVATE,
/// on-device model answer on this form factor? The desktop shell always can — it
/// owns llama-server and the weights. A mobile shell can ONLY when its plugin has
/// reported a usable on-device backend (`on_device_backend`: Apple Foundation
/// Models available, or a bundled GGUF present) — otherwise phone-class hardware
/// gets the first-class "unsupported" status, never a broken private option.
/// Anything unrecognized fails closed. KEEP IN SYNC with
/// src/server/localModel.ts::localModelAvailable.
pub fn local_model_available(platform_kind: &str, on_device_backend: bool) -> bool {
    match platform_kind {
        "desktop" => true,
        "ios" | "android" => on_device_backend,
        _ => false,
    }
}

/// The no-backend specialization of `local_model_available` — true only where the
/// private model runs WITHOUT a reported on-device backend, i.e. the desktop
/// shell. Kept so pre-reversal call sites and the desktop pin read unchanged.
/// KEEP IN SYNC with src/server/localModel.ts::localModelSupported.
pub fn local_model_supported(platform_kind: &str) -> bool {
    local_model_available(platform_kind, false)
}

/// The verdict applied to THIS build (config::platform_kind + the runtime
/// on-device-backend signal) — the guard every engine entry point below uses,
/// shared with synth's warm-wait short-circuit. Desktop is always true; a mobile
/// shell tracks its plugin's reported availability.
pub(crate) fn supported_here() -> bool {
    local_model_available(crate::config::platform_kind(), on_device_backend())
}

/// The honest mobile answer for every model op: status "unsupported", with any
/// stray on-disk bytes (a leftover `.gguf` synced/copied from a desktop data
/// dir, or an orphaned `.part`) surfaced via `removable` + `total` so the
/// existing uninstall affordance can offer to free them ("frees N GB").
fn unsupported_status() -> Progress {
    let partial_bytes = partial_size();
    let stray: u64 = model_gguf_files()
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum::<u64>()
        + partial_bytes.unwrap_or(0);
    Progress {
        status: "unsupported".to_string(),
        received: 0,
        total: stray,
        error: None,
        removable: Some(stray > 0),
        partial_bytes,
    }
}

// --- shell-facing helpers (the desktop shell owns llama-server and the
// uninstall handshake; these expose the same discovery the picker uses so the
// two always agree) ---

/// First installed, usable `.gguf` (size + magic checked), or None.
pub fn find_installed_model() -> Option<PathBuf> {
    installed_model()
}

/// Every `.gguf` in the search dirs — usable or leftover — for uninstall.
pub fn model_gguf_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in search_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            if e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".gguf")
            {
                files.push(e.path());
            }
        }
    }
    files
}

/// The marker file the shell watches to perform an uninstall.
pub fn uninstall_marker_path() -> PathBuf {
    models_dir().join(UNINSTALL_MARKER)
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub status: String, // ready | absent | downloading | uninstalling | error | unsupported (§3: mobile)
    pub received: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removable: Option<bool>,
    /// Bytes of a kept-for-resume `.part` on disk (status "absent"/"error"
    /// after an interrupted, failed, or paused download) — lets the UI offer
    /// "Resume download" instead of a from-scratch "Install".
    #[serde(skip_serializing_if = "Option::is_none", rename = "partialBytes")]
    pub partial_bytes: Option<u64>,
}

impl Progress {
    fn simple(status: &str) -> Self {
        Progress {
            status: status.to_string(),
            received: 0,
            total: 0,
            error: None,
            removable: None,
            partial_bytes: None,
        }
    }
}

// One download at a time, tracked in module state so GET /api/model can report
// progress while POST /api/model runs it in the background.
static PROGRESS: Mutex<Option<Progress>> = Mutex::new(None);
// Pause/resume seams: `request_uninstall()` during a download flags a pause —
// the streaming loop notices at the next chunk and stops WITHOUT deleting the
// `.part` (it survives for a Range resume). GENERATION fences a paused task's
// writes and state reports off a NEWER download that superseded it (pause →
// quick resume), so the two can never interleave on the `.part` or PROGRESS.
static PAUSE: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Sentinel error: the in-flight download was paused (or superseded) — the
/// `.part` is kept and the task must not report an "error" state.
#[derive(Debug)]
struct DownloadPaused;

impl std::fmt::Display for DownloadPaused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("download paused")
    }
}

impl std::error::Error for DownloadPaused {}

/// The on-disk resume artifact: downloads stream into `<model file>.part` —
/// appended to the FULL file name, matching the TS twin's `${dest}.part`.
fn part_path() -> PathBuf {
    let mut s = models_dir().join(model_file()).into_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// Size of the `.part` on disk (None when absent/empty) — a cheap stat, for
/// status calls.
fn partial_size() -> Option<u64> {
    fs::metadata(part_path()).ok().map(|m| m.len()).filter(|s| *s > 0)
}

/// Bytes safe to resume from. A `.part` is only trusted when its prefix
/// carries the GGUF magic — anything else (junk, a sub-magic stub) is
/// discarded here so a corrupt partial can never poison the resumed file. This
/// is the cheap first gate; the completed file is size- and magic-checked
/// AGAIN before the rename.
fn resumable_bytes(tmp: &Path) -> u64 {
    let size = fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);
    if size >= 4 && is_gguf_file(tmp) {
        return size;
    }
    if size > 0 {
        let _ = fs::remove_file(tmp);
    }
    0
}

/// True when the running download (of generation `gen`) must stop writing: the
/// user paused it, or a newer download superseded it (pause → quick resume
/// before this task noticed). Checked before every chunk is written, so a
/// stale task never interleaves with its successor on the `.part`.
fn paused_or_stale(gen: u64) -> bool {
    PAUSE.load(Ordering::SeqCst) || GENERATION.load(Ordering::SeqCst) != gen
}

fn current_progress() -> Progress {
    PROGRESS
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| Progress::simple("absent"))
}

fn set_progress(p: Progress) {
    *PROGRESS.lock().unwrap() = Some(p);
}

/// Current model state; "ready" the moment an installed model is present.
pub fn model_status() -> Progress {
    // §3: on a mobile shell the private model is UNSUPPORTED — a first-class
    // status, not an error the UI retries. Reported before anything else so
    // no mobile caller ever sees "absent" (which reads as "installable").
    if !supported_here() {
        return unsupported_status();
    }
    if uninstall_pending() {
        return Progress::simple("uninstalling");
    }
    let progress = current_progress();
    if progress.status == "downloading" {
        return progress;
    }
    if installed_model().is_some() {
        return Progress::simple("ready");
    }
    // No usable model. A leftover `.gguf` is surfaced as removable; a kept
    // `.part` from an interrupted/paused download is surfaced too
    // (partial_bytes), so the UI can offer to RESUME instead of starting over.
    let removable = has_model_file();
    let partial_bytes = partial_size();
    if progress.status == "error" {
        return Progress {
            removable: Some(removable),
            partial_bytes,
            ..progress
        };
    }
    Progress {
        removable: Some(removable),
        partial_bytes,
        ..Progress::simple("absent")
    }
}

/// Request removal of the installed model by dropping the marker the desktop
/// shell watches (it stops llama-server, deletes the weights, clears the marker).
///
/// While a download is IN FLIGHT this doubles as "pause": there are no weights
/// to remove yet, so the transfer is torn down and the `.part` is KEPT — the
/// next install resumes it via an HTTP Range request (the UI labels the
/// affordance "Pause" in that state). A paused `.part` is cleared only by a
/// REAL uninstall (alongside the weights/marker), never by a repeated DELETE
/// on its own — a rapid second click must not silently discard gigabytes of
/// resumable progress.
pub fn request_uninstall() -> Progress {
    // §3: on a mobile shell nothing ever mmaps the weights (llama-server is
    // desktop-only) and no shell watcher exists to honor the marker handshake
    // — a marker would leave "uninstalling" pending forever. Delete stray
    // files directly instead: this is the engine half of the UI's existing
    // "remove the leftover file (frees N GB)" affordance.
    if !supported_here() {
        for f in model_gguf_files() {
            let _ = fs::remove_file(f);
        }
        let _ = fs::remove_file(part_path());
        let _ = fs::remove_file(uninstall_marker_path());
        return unsupported_status();
    }
    {
        let mut guard = PROGRESS.lock().unwrap();
        let downloading = guard
            .as_ref()
            .map(|p| p.status == "downloading")
            .unwrap_or(false);
        if downloading {
            PAUSE.store(true, Ordering::SeqCst);
            *guard = Some(Progress::simple("absent"));
            let mut paused = Progress::simple("absent");
            paused.partial_bytes = partial_size();
            return paused;
        }
    }
    if !has_model_file() && !uninstall_pending() {
        let mut absent = Progress::simple("absent");
        absent.partial_bytes = partial_size();
        return absent;
    }
    // A real uninstall clears a stray/paused `.part` too. Unlike the weights
    // it is never mmap'd by llama-server, so it can be removed directly here —
    // no shell handshake needed.
    let _ = fs::remove_file(part_path());
    let _ = fs::write(
        models_dir().join(UNINSTALL_MARKER),
        format!("{}", crate::config::now_ms()),
    );
    set_progress(Progress::simple("absent")); // clear any prior error
    Progress::simple("uninstalling")
}

/// Kick off the one-time model download if it isn't already present or running.
///
/// Safe to call from ANY thread. When a Tokio runtime is ambient (the axum
/// server), the download runs on it; otherwise it runs on a dedicated thread
/// with its own runtime. The desktop shell invokes commands from outside a
/// runtime context — a bare `tokio::spawn` here panics ("no reactor running"),
/// and since sync Tauri commands execute on the main thread, that panic took
/// the whole app down the moment the user clicked Install.
pub fn start_download() -> Progress {
    // §3 refusal: phone-class hardware can't run the ~4.2 GB private model,
    // so the engine never starts the download there. The UI already offers no
    // Install affordance on mobile (the roster drops the local entry) — this
    // is the engine-side guarantee for any other caller.
    if !supported_here() {
        return unsupported_status();
    }
    let gen;
    {
        // Check-and-mark under one lock so two rapid calls can't both spawn.
        let mut guard = PROGRESS.lock().unwrap();
        if let Some(p) = guard.as_ref() {
            if p.status == "downloading" {
                return p.clone();
            }
        }
        if installed_model().is_some() {
            return Progress::simple("ready");
        }
        // New generation: clears a pending pause and fences a paused
        // predecessor's callbacks off the module state (it stops at its next
        // chunk via `paused_or_stale`).
        PAUSE.store(false, Ordering::SeqCst);
        gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = Some(Progress::simple("downloading"));
    }
    let task = async move {
        let result = download(gen).await;
        if GENERATION.load(Ordering::SeqCst) != gen {
            return; // superseded by a newer download — not ours to report
        }
        match result {
            Ok(()) => set_progress(Progress::simple("ready")),
            Err(e) if e.downcast_ref::<DownloadPaused>().is_some() => {
                // Not a failure: the user paused. The `.part` stays for a
                // Range resume.
                PAUSE.store(false, Ordering::SeqCst);
                let mut paused = Progress::simple("absent");
                paused.partial_bytes = partial_size();
                set_progress(paused);
            }
            Err(e) => {
                let prev = current_progress();
                set_progress(Progress {
                    status: "error".to_string(),
                    received: prev.received,
                    total: prev.total,
                    error: Some(e.to_string()),
                    removable: None,
                    partial_bytes: None,
                });
            }
        }
    };
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(task);
    } else {
        std::thread::spawn(move || {
            match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt.block_on(task),
                Err(e) => set_progress(Progress {
                    status: "error".to_string(),
                    received: 0,
                    total: 0,
                    error: Some(format!("could not start the download runtime: {e}")),
                    removable: None,
                    partial_bytes: None,
                }),
            }
        });
    }
    current_progress()
}

/// One "downloading" progress frame (received/total).
fn progress_downloading(received: u64, total: u64) -> Progress {
    Progress {
        status: "downloading".into(),
        received,
        total,
        error: None,
        removable: None,
        partial_bytes: None,
    }
}

/// GET the model, resuming from `offset` via `Range: bytes=<offset>-` when > 0.
/// reqwest follows the HF `resolve` → CDN redirect itself, carrying the header.
async fn send_get(client: &reqwest::Client, offset: u64) -> reqwest::Result<reqwest::Response> {
    let mut req = client.get(model_url());
    if offset > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    req.send().await
}

/// Stream the model to a `.part` temp file, updating progress, and rename into
/// place only once the full byte count arrives.
///
/// Resume protocol: an existing GGUF-prefixed `.part` is continued with
/// `Range: bytes=<size>-`. HTTP 206 appends from that offset (progress
/// reflects the resumed offset immediately); HTTP 200 means the server ignored
/// the Range, so the `.part` is truncated and the transfer restarts from zero;
/// HTTP 416 means the `.part` is at/past the asset's size (or the asset
/// changed) — it is discarded and a fresh request made. On failure the `.part`
/// is KEPT for a later resume; it is deleted only when integrity is in doubt
/// (junk prefix, 416, overshoot, or a completed file that is not a valid GGUF
/// model).
async fn download(gen: u64) -> anyhow::Result<()> {
    let dest = models_dir().join(model_file());
    let tmp = part_path();
    let mut offset = resumable_bytes(&tmp);
    if offset > 0 {
        // Reflect the resumed offset immediately — before the first byte
        // arrives — so a resumed download never appears to restart at zero.
        set_progress(progress_downloading(offset, 0));
    }

    let client = reqwest::Client::builder()
        .user_agent("lighthouse-app")
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    crate::egress::record(&model_url(), crate::egress::PURPOSE_MODEL_DOWNLOAD);
    let mut res = send_get(&client, offset).await?;
    if res.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // Range not satisfiable: the .part is at/past the asset's size, or the
        // asset changed underneath us. Either way it can't be trusted —
        // discard it and fetch from zero.
        let _ = fs::remove_file(&tmp);
        offset = 0;
        res = send_get(&client, 0).await?;
    }
    if !res.status().is_success() {
        anyhow::bail!("GET {} → {}", model_url(), res.status().as_u16());
    }
    if paused_or_stale(gen) {
        // Paused while connecting (nothing streamed yet): stop before writing.
        return Err(DownloadPaused.into());
    }

    let append = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let total: u64 = if append {
        // The server honored the Range: strictly verify it resumed at OUR
        // offset (appending a mismatched slice would corrupt the file), and
        // take the full size from Content-Range ("bytes <start>-<end>/<total>").
        let content_range = res
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if offset == 0 || !content_range.starts_with(&format!("bytes {offset}-")) {
            anyhow::bail!(
                "resume failed: server returned a mismatched range ({})",
                if content_range.is_empty() {
                    "no content-range"
                } else {
                    content_range.as_str()
                }
            );
        }
        content_range
            .rsplit('/')
            .next()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .or_else(|| res.content_length().map(|l| offset + l))
            .unwrap_or(0)
    } else {
        // 200: the full body — no .part, or the server ignored the Range (some
        // hosts do). Restart from zero (the create below truncates) so resumed
        // bytes are never appended twice.
        offset = 0;
        res.content_length().unwrap_or(0)
    };
    if total == 0 {
        anyhow::bail!("download unverifiable: server did not report a Content-Length");
    }
    set_progress(progress_downloading(offset, total));

    let streamed: anyhow::Result<()> = async {
        use tokio::io::AsyncWriteExt;
        let mut out = if append {
            tokio::fs::OpenOptions::new().append(true).open(&tmp).await?
        } else {
            tokio::fs::File::create(&tmp).await?
        };
        let mut received = offset;
        let mut stream = res.bytes_stream();
        let piped: anyhow::Result<()> = async {
            while let Some(chunk) = stream.next().await {
                // Pause/supersede check BEFORE the write: a paused (or
                // replaced) task must stop touching the .part the moment it
                // can, so it never interleaves with a successor's writes.
                if paused_or_stale(gen) {
                    return Err(DownloadPaused.into());
                }
                let chunk = chunk?;
                received += chunk.len() as u64;
                set_progress(progress_downloading(received, total));
                out.write_all(&chunk).await?;
            }
            Ok(())
        }
        .await;
        // Quiesce the .part on EVERY exit (success, pause, failure) so a later
        // resume stats the true on-disk byte count.
        let _ = out.flush().await;
        piped
    }
    .await;
    streamed?;

    // Integrity is size- and magic-based (there is no upstream digest). Too
    // SHORT is an interruption — keep the `.part` so the next install resumes.
    // Anything else wrong (overshoot, not a GGUF) is corruption — a corrupt
    // part must never become a ready model, so delete it and start fresh next
    // time.
    let size = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if size < total {
        anyhow::bail!("incomplete download ({size}/{total} bytes)");
    }
    if size > total {
        let _ = fs::remove_file(&tmp);
        anyhow::bail!("download corrupted ({size}/{total} bytes) — removed; installing again starts fresh");
    }
    if !is_gguf_file(&tmp) {
        let _ = fs::remove_file(&tmp);
        anyhow::bail!(
            "download corrupted (not a valid GGUF model file) — removed; installing again starts fresh"
        );
    }
    fs::rename(&tmp, &dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §3 pinned verdict: the private model runs ONLY on the desktop shell,
    /// and anything unrecognized fails closed. KEEP IN SYNC with the
    /// localModelSupported pin in test/localModelPlatform.test.mjs.
    #[test]
    fn local_model_supported_only_on_desktop() {
        // The no-backend verdict is still desktop-only.
        assert!(local_model_supported("desktop"));
        assert!(!local_model_supported("ios"));
        assert!(!local_model_supported("android"));
        assert!(!local_model_supported(""));
        assert!(!local_model_supported("web"));
        // add-mobile-local-inference: WITH a reported on-device backend, a mobile
        // shell IS available; desktop ignores the flag; unknown fails closed.
        assert!(local_model_available("desktop", false));
        assert!(local_model_available("desktop", true));
        assert!(local_model_available("ios", true));
        assert!(local_model_available("android", true));
        assert!(!local_model_available("ios", false));
        assert!(!local_model_available("android", false));
        assert!(!local_model_available("web", true));
    }

    /// This build's own guard agrees with the config platform signal — the
    /// same assert pins the mobile arm under a cross-compiled `cargo test`.
    #[test]
    fn supported_here_matches_platform_kind() {
        assert_eq!(
            supported_here(),
            crate::config::platform_kind() == "desktop"
        );
    }
}
