//! Optional, on-demand download of the private local model (port of
//! `src/server/localModel.ts`). The ~4.2 GB GGUF is fetched once from Hugging
//! Face into the user's data dir; the desktop shell watches the directory and
//! runs `llama-server` against it. Uninstall is a marker-file handshake with
//! the shell (which owns the process whose mmap locks the weights).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
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
    pub status: String, // ready | absent | downloading | uninstalling | error
    pub received: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removable: Option<bool>,
}

impl Progress {
    fn simple(status: &str) -> Self {
        Progress {
            status: status.to_string(),
            received: 0,
            total: 0,
            error: None,
            removable: None,
        }
    }
}

// One download at a time, tracked in module state so GET /api/model can report
// progress while POST /api/model runs it in the background.
static PROGRESS: Mutex<Option<Progress>> = Mutex::new(None);

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
    let removable = has_model_file();
    if progress.status == "error" {
        return Progress {
            removable: Some(removable),
            ..progress
        };
    }
    Progress {
        removable: Some(removable),
        ..Progress::simple("absent")
    }
}

/// Request removal of the installed model by dropping the marker the desktop
/// shell watches (it stops llama-server, deletes the weights, clears the marker).
pub fn request_uninstall() -> Progress {
    if !has_model_file() && !uninstall_pending() {
        return Progress::simple("absent");
    }
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
        *guard = Some(Progress::simple("downloading"));
    }
    let task = async {
        match download().await {
            Ok(()) => set_progress(Progress::simple("ready")),
            Err(e) => {
                let prev = current_progress();
                set_progress(Progress {
                    status: "error".to_string(),
                    received: prev.received,
                    total: prev.total,
                    error: Some(e.to_string()),
                    removable: None,
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
                }),
            }
        });
    }
    current_progress()
}

/// Stream the model to a `.part` temp file, updating progress, and rename into
/// place only once the full byte count arrives.
async fn download() -> anyhow::Result<()> {
    let dest = models_dir().join(model_file());
    let tmp = dest.with_extension("gguf.part");

    let client = reqwest::Client::builder()
        .user_agent("lighthouse-app")
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    crate::egress::record(&model_url(), crate::egress::PURPOSE_MODEL_DOWNLOAD);
    let res = client.get(model_url()).send().await?;
    if !res.status().is_success() {
        anyhow::bail!("GET {} → {}", model_url(), res.status().as_u16());
    }
    let total = res.content_length().unwrap_or(0);
    if total == 0 {
        anyhow::bail!("download unverifiable: server did not report a Content-Length");
    }
    set_progress(Progress {
        status: "downloading".into(),
        received: 0,
        total,
        error: None,
        removable: None,
    });

    let result: anyhow::Result<u64> = async {
        let mut out = tokio::fs::File::create(&tmp).await?;
        use tokio::io::AsyncWriteExt;
        let mut received: u64 = 0;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            received += chunk.len() as u64;
            set_progress(Progress {
                status: "downloading".into(),
                received,
                total,
                error: None,
                removable: None,
            });
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        Ok(received)
    }
    .await;

    match result {
        Ok(received) if received == total => {
            fs::rename(&tmp, &dest)?;
            Ok(())
        }
        Ok(received) => {
            let _ = fs::remove_file(&tmp);
            anyhow::bail!("incomplete download ({received}/{total} bytes)")
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}
