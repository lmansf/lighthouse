//! Filesystem watcher (Phase 5): turns the poll-driven freshness model into an
//! event-driven one. Watches the vault directory, every linked reference root,
//! and the cloud mirror dir; on a change it invalidates the affected index
//! entries and the walk cache and bumps a generation counter the UI transports
//! (SSE / Tauri events) can push on.
//!
//! Best-effort by design: index correctness comes from per-query mtime+size
//! validation, and the walk cache keeps a TTL fallback — a platform where the
//! watcher fails just behaves like the legacy poll model.

use std::collections::HashSet;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

use crate::config::vault_dir;

static GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<()> = OnceLock::new();

/// Monotonic change counter — bumped on every relevant filesystem event.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Relaxed)
}

/// Whether a live watcher is running (extends the walk-cache TTL when true).
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// The roots the watcher should cover right now: vault + reference roots +
/// the SharePoint mirror.
fn watch_roots() -> Vec<PathBuf> {
    let mut roots = vec![vault_dir()];
    for r in crate::vault::reference_roots() {
        roots.push(r);
    }
    roots.push(crate::sources::microsoft::mirror_dir());
    roots
}

/// Map a changed absolute path to the node id(s) it invalidates.
fn ids_for_path(path: &Path, vault: &Path, refs: &[(String, PathBuf)]) -> Vec<String> {
    let p = path.to_string_lossy().to_string();
    let v = vault.to_string_lossy().to_string();
    if p == v || p.starts_with(&format!("{v}{MAIN_SEPARATOR}")) {
        // Ignore our own state churn under .rag-vault (index persists, walk
        // snapshots, licensing writes) — those are not vault content.
        if p.contains(&format!("{MAIN_SEPARATOR}.rag-vault")) {
            return Vec::new();
        }
        return path
            .strip_prefix(vault)
            .ok()
            .map(|rel| {
                vec![rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/")]
            })
            .unwrap_or_default();
    }
    for (ref_id, root) in refs {
        let r = root.to_string_lossy().to_string();
        if p == r {
            return vec![ref_id.clone()];
        }
        if p.starts_with(&format!("{r}{MAIN_SEPARATOR}")) {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                return vec![format!("{ref_id}/{rel}")];
            }
        }
    }
    Vec::new()
}

/// Start the watcher thread (idempotent). Never panics the caller; failures
/// leave `is_active() == false` and the TTL fallback in charge.
pub fn start() {
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("lighthouse-watch".into())
            .spawn(run)
            .map(|_| ())
            .unwrap_or(());
    });
}

fn run() {
    loop {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => {
                // No watcher on this platform/filesystem — poll model stays.
                std::thread::sleep(Duration::from_secs(60));
                continue;
            }
        };

        let mut watched: HashSet<PathBuf> = HashSet::new();
        for root in watch_roots() {
            if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
                watched.insert(root);
            }
        }
        ACTIVE.store(!watched.is_empty(), Ordering::Relaxed);

        loop {
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Ok(event)) => {
                    let vault = vault_dir();
                    let refs: Vec<(String, PathBuf)> = crate::vault::reference_roots_with_ids();
                    let mut ids: Vec<String> = Vec::new();
                    let mut relevant = false;
                    for path in &event.paths {
                        let mapped = ids_for_path(path, &vault, &refs);
                        if !mapped.is_empty()
                            || path.starts_with(crate::sources::microsoft::mirror_dir())
                        {
                            relevant = true;
                        }
                        ids.extend(mapped);
                    }
                    if relevant {
                        if ids.is_empty() {
                            crate::index::invalidate_all(); // mirror churn: ids unmappable
                        } else {
                            crate::index::invalidate_ids(&ids);
                        }
                        crate::vault::invalidate_walk_cache();
                        GENERATION.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Ok(Err(_)) => { /* transient backend error — keep listening */ }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Roots can change at runtime (links added/removed, vault
                    // switched). Rebuild the watcher when the set differs.
                    let want: HashSet<PathBuf> = watch_roots().into_iter().collect();
                    if want != watched {
                        break; // outer loop recreates the watcher with new roots
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        ACTIVE.store(false, Ordering::Relaxed);
    }
}
