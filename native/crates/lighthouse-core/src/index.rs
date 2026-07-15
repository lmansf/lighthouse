//! Persistent incremental retrieval index (Phase 5 of docs/rewrite-scope.md).
//!
//! Replaces the per-query re-read/re-chunk/re-tokenize loop: each included
//! file's chunked, term-frequency'd representation is built once, kept in
//! memory, persisted to `.rag-vault/cache/index-v1.json` (compact JSON,
//! written by a DEBOUNCED background flusher — see `mark_dirty`), and
//! revalidated by a cheap `stat` (mtime+size key — the same key the
//! extraction cache uses). Correctness never depends on the FS watcher or on
//! persistence: a stale entry is detected at query time by its key and
//! rebuilt, in parallel across files on a BOUNDED rayon pool (see
//! `build_pool`) so a big corpus indexes politely.
//!
//! The legacy 1 MB per-file read cap and 4,000-chunk query cap exist in the TS
//! engine purely to protect Node's event loop; with the index off the query
//! path they are replaced by generous, env-tunable bounds
//! (LIGHTHOUSE_INDEX_MAX_FILE_BYTES, default 8 MB;
//! LIGHTHOUSE_MAX_QUERY_CHUNKS, default 200,000).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::{read_json, state_dir, write_json_compact};
use crate::vault::{chunk_texts_named, name_tokens_of, read_text_abs_capped};

/// Threads used for index builds and load-time tf rebuilds. Deliberately a
/// FRACTION of the machine (half the cores, capped at 4) — the global rayon
/// pool would peg every core when a freshly-linked corpus indexes, which is
/// exactly the "app is stressing the computer" complaint. Override with
/// LIGHTHOUSE_INDEX_THREADS.
fn build_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let threads = std::env::var("LIGHTHOUSE_INDEX_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| (cores / 2).clamp(1, 4));
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("lh-index-{i}"))
            .build()
            .ok()
    })
    .as_ref()
}

/// Run `f` on the bounded build pool (global pool only as a fallback).
fn in_build_pool<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    match build_pool() {
        Some(pool) => pool.install(f),
        None => f(),
    }
}

/// Per-file byte cap for indexed text (bounds one pathological file, not the
/// corpus). Rich formats are additionally clamped by the extraction cache.
pub fn index_max_file_bytes() -> u64 {
    std::env::var("LIGHTHOUSE_INDEX_MAX_FILE_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8 * 1024 * 1024)
}

/// Safety valve on chunks scored per query (50× the legacy cap; logged when hit).
pub fn max_query_chunks() -> usize {
    std::env::var("LIGHTHOUSE_MAX_QUERY_CHUNKS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedChunk {
    pub text: String,
    /// Rebuilt from `text` on load (cheap, parallel) so the on-disk index stays
    /// roughly corpus-sized instead of double.
    #[serde(skip)]
    pub tf: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// `mtimeMs:size` — same freshness key as the extraction cache.
    pub key: String,
    pub name: String,
    pub name_tokens: Vec<String>,
    pub preview: String,
    pub chunks: Vec<IndexedChunk>,
}

#[derive(Serialize, Deserialize)]
struct DiskIndex {
    v: u32,
    files: HashMap<String, Arc<FileEntry>>,
}

// v2: structure-aware tabular chunking + parquet extraction (B1) changed
// chunk layouts — stale v1 entries must rebuild, not linger.
const DISK_VERSION: u32 = 2;

struct IndexState {
    /// The vault this in-memory index belongs to (tests and vault switches
    /// swap VAULT_DIR at runtime; a mismatch reloads from that vault's disk).
    state_dir: PathBuf,
    files: HashMap<String, Arc<FileEntry>>,
}

static STATE: Mutex<Option<IndexState>> = Mutex::new(None);

fn disk_path(sd: &Path) -> PathBuf {
    let dir = sd.join("cache");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("index-v1.json")
}

fn load_from_disk(sd: &Path) -> HashMap<String, Arc<FileEntry>> {
    let disk: Option<DiskIndex> = read_json(&disk_path(sd), None);
    let Some(disk) = disk.filter(|d| d.v == DISK_VERSION) else {
        return HashMap::new();
    };
    // Rebuild the skipped tf maps in parallel — on the bounded pool, since a
    // big corpus makes this a full re-tokenization pass.
    let mut files: Vec<(String, FileEntry)> = disk
        .files
        .into_iter()
        .map(|(id, e)| (id, Arc::try_unwrap(e).unwrap_or_else(|a| (*a).clone())))
        .collect();
    in_build_pool(|| {
        files.par_iter_mut().for_each(|(_, e)| {
            for c in &mut e.chunks {
                c.tf = tf_of(&c.text);
            }
        });
    });
    files.into_iter().map(|(id, e)| (id, Arc::new(e))).collect()
}

fn persist(sd: &Path, files: &HashMap<String, Arc<FileEntry>>) {
    let disk = DiskIndex {
        v: DISK_VERSION,
        files: files.clone(),
    };
    write_json_compact(&disk_path(sd), &disk);
}

// --- debounced persistence ------------------------------------------------------
//
// The index used to be re-serialized and fsync'd IN FULL after every call
// that built anything — on a large corpus that is a hundreds-of-MB write per
// query while the watcher trickles invalidations in. Persistence is only a
// warm-start cache (correctness comes from the per-query mtime+size keys),
// so writes are batched: builds mark the index dirty and a background
// flusher writes at most once per interval. `flush_now` exists for shutdown.

static DIRTY: AtomicBool = AtomicBool::new(false);
static FLUSHER: OnceLock<()> = OnceLock::new();

fn flush_snapshot() {
    let snap = {
        let guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .as_ref()
            .map(|s| (s.state_dir.clone(), s.files.clone()))
    };
    if let Some((sd, files)) = snap {
        persist(&sd, &files);
    }
}

fn mark_dirty() {
    DIRTY.store(true, Ordering::Release);
    FLUSHER.get_or_init(|| {
        std::thread::Builder::new()
            .name("lh-index-flush".into())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if DIRTY.swap(false, Ordering::AcqRel) {
                    flush_snapshot();
                }
            })
            .map(|_| ())
            .unwrap_or(()); // no flusher thread ⇒ flush_now/shutdown still works
    });
}

/// Write any pending index changes to disk immediately (shutdown hook; losing
/// a pending flush is never wrong — the cache is just cold next launch).
pub fn flush_now() {
    if DIRTY.swap(false, Ordering::AcqRel) {
        flush_snapshot();
    }
}

fn tf_of(text: &str) -> HashMap<String, f64> {
    let mut tf = HashMap::new();
    for t in crate::vault::tokenize(text) {
        *tf.entry(t).or_insert(0.0) += 1.0;
    }
    tf
}

/// The freshness key for a file right now, or None if it is unreadable.
fn key_of(abs: &Path) -> Option<String> {
    let meta = std::fs::metadata(abs).ok()?;
    let ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Some(format!("{ms}:{}", meta.len()))
}

fn build_entry(name: &str, path_for: &str, abs: &Path, key: String) -> FileEntry {
    let text = read_text_abs_capped(abs, index_max_file_bytes());
    let chunk_texts = if text.trim().is_empty() {
        Vec::new()
    } else {
        chunk_texts_named(name, &text)
    };
    let preview = chunk_texts
        .first()
        .map(|c| c.chars().take(240).collect())
        .unwrap_or_default();
    let chunks = chunk_texts
        .into_iter()
        .map(|text| {
            let tf = tf_of(&text);
            IndexedChunk { text, tf }
        })
        .collect();
    FileEntry {
        key,
        name: name.to_string(),
        name_tokens: name_tokens_of(path_for, name),
        preview,
        chunks,
    }
}

/// A retrieval item the index can serve: a node id plus where its bytes live.
pub struct IndexItem {
    pub id: String,
    pub name: String,
    /// Path-ish string used for name/path token matching ("" for cloud ids).
    pub path_for: String,
    pub abs: Option<PathBuf>,
}

/// Current, validated entries for `items` — hits are served from memory, stale
/// or missing entries are (re)built in parallel and persisted. Files that no
/// longer exist on disk get an empty entry (findable by name only), matching
/// the legacy read-failure behavior.
pub fn entries_for(items: &[IndexItem]) -> HashMap<String, Arc<FileEntry>> {
    let sd = state_dir();
    let mut out: HashMap<String, Arc<FileEntry>> = HashMap::new();
    let mut misses: Vec<(&IndexItem, String)> = Vec::new();

    {
        let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        let state = match guard.as_mut() {
            Some(s) if s.state_dir == sd => s,
            _ => {
                *guard = Some(IndexState {
                    state_dir: sd.clone(),
                    files: load_from_disk(&sd),
                });
                guard.as_mut().unwrap()
            }
        };
        for item in items {
            let key = item.abs.as_deref().and_then(key_of).unwrap_or_default();
            match state.files.get(&item.id) {
                Some(e) if e.key == key => {
                    out.insert(item.id.clone(), e.clone());
                }
                _ => misses.push((item, key)),
            }
        }
    }

    if misses.is_empty() {
        return out;
    }

    // Build outside the lock, parallel across files — on the BOUNDED pool so
    // a freshly-linked corpus indexes politely instead of pegging every core.
    let built: Vec<(String, Arc<FileEntry>)> = in_build_pool(|| {
        misses
            .par_iter()
            .map(|(item, key)| {
                let entry = match item.abs.as_deref() {
                    Some(abs) => build_entry(&item.name, &item.path_for, abs, key.clone()),
                    None => FileEntry {
                        key: key.clone(),
                        name: item.name.clone(),
                        name_tokens: name_tokens_of(&item.path_for, &item.name),
                        preview: String::new(),
                        chunks: Vec::new(),
                    },
                };
                (item.id.clone(), Arc::new(entry))
            })
            .collect()
    });

    {
        let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        let state = match guard.as_mut() {
            Some(s) if s.state_dir == sd => s,
            _ => {
                *guard = Some(IndexState {
                    state_dir: sd.clone(),
                    files: load_from_disk(&sd),
                });
                guard.as_mut().unwrap()
            }
        };
        for (id, entry) in built {
            out.insert(id.clone(), entry.clone());
            state.files.insert(id, entry);
        }
    }
    mark_dirty(); // batched write — see the debounced-persistence block above
    crate::embed::nudge_warm(); // fresh entries may need vectors (B2)
    out
}

/// (id, freshness key, chunk texts) for every in-memory entry — the embedding
/// warm pass (crate::embed) diffs this against its sidecar to find chunks that
/// still need vectors. Snapshot semantics: cheap Arc clones under the lock.
pub fn snapshot_chunks() -> Vec<(String, String, Vec<String>)> {
    let guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(state) = guard.as_ref() else {
        return Vec::new();
    };
    state
        .files
        .iter()
        .map(|(id, e)| {
            (
                id.clone(),
                e.key.clone(),
                e.chunks.iter().map(|c| c.text.clone()).collect(),
            )
        })
        .collect()
}

/// What the read-only file inspector needs from the persistent index: the
/// stored freshness key (`mtimeMs:size`), how many chunks the index holds for
/// the file, and whether that key still matches the file on disk right now.
pub struct IndexPeek {
    pub key: String,
    pub chunk_count: usize,
    pub fresh: bool,
}

/// Read-only inspector peek at the PERSISTED entry for `id`, WITHOUT
/// revalidating or rebuilding it — so a stale entry stays observably stale
/// (that staleness is the point the inspector reports). Loads the on-disk index
/// into memory if nothing is loaded yet (a read), but never builds a missing
/// entry, marks the index dirty, or persists. `abs` is the file's current path,
/// used only to compute the on-disk key for the freshness compare. None when
/// the index holds no entry for this id yet (e.g. never included/warmed).
pub fn peek_entry(id: &str, abs: Option<&Path>) -> Option<IndexPeek> {
    let sd = state_dir();
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let state = match guard.as_mut() {
        Some(s) if s.state_dir == sd => s,
        _ => {
            *guard = Some(IndexState {
                state_dir: sd.clone(),
                files: load_from_disk(&sd),
            });
            guard.as_mut().unwrap()
        }
    };
    let entry = state.files.get(id)?;
    let fresh = abs.and_then(key_of).as_deref() == Some(entry.key.as_str());
    Some(IndexPeek {
        key: entry.key.clone(),
        chunk_count: entry.chunks.len(),
        fresh,
    })
}

/// Drop entries for changed node ids (watcher nicety — correctness comes from
/// the per-query key check, so a missed invalidation is never wrong, only warm).
pub fn invalidate_ids(ids: &[String]) {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(state) = guard.as_mut() {
        for id in ids {
            state.files.remove(id);
        }
    }
}

/// Drop the whole in-memory index (e.g. cloud mirror churn).
pub fn invalidate_all() {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    *guard = None;
}
