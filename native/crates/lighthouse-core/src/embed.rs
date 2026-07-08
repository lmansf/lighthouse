//! Local embeddings + hybrid retrieval (docs/analytics-genie.md, B2).
//!
//! TF-IDF is blind to meaning ("Q3 revenue" ≠ "third-quarter sales"). A small
//! embedding model (nomic-embed-text v1.5, bundled with the installer) runs
//! under the same llama-server we already supervise — `--embedding`, second
//! port, CPU-only — and every indexed chunk gets a vector stored in a binary
//! sidecar beside the index. Retrieval fuses the lexical and vector rankings
//! with reciprocal-rank fusion. Everything is on-device; when the embedding
//! server is missing/off/unhealthy, retrieval is exactly the lexical path.
//!
//! Desktop-first like the analytics engine: the TS dev twin never grows a
//! vector leg — its retrieval stays lexical.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::config::{resources_dir, state_dir};

/// Chunk text is capped before embedding: nomic's useful signal saturates well
/// before this, and llama-server rejects inputs longer than its microbatch.
const EMBED_MAX_CHARS: usize = 1500;
const QUERY_MAX_CHARS: usize = 300;
/// Texts per /v1/embeddings request during the warm pass.
const WARM_BATCH: usize = 8;
/// RRF constant (the standard k=60) and how deep each ranked list contributes.
const RRF_K: f64 = 60.0;
const RRF_DEPTH: usize = 400;

/// Second llama-server instance, embeddings only. Fixed like the chat port
/// (8080); override for dev/tests with LIGHTHOUSE_EMBED_URL.
pub const EMBED_PORT: u16 = 8091;

fn embed_url() -> String {
    std::env::var("LIGHTHOUSE_EMBED_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{EMBED_PORT}"))
}

/// Semantic search is ON unless the user turned it off in Preferences.
/// Desktop-only (the web dev twin has no embedding server to talk to) —
/// except when LIGHTHOUSE_EMBED_URL points somewhere explicitly (tests, dev).
pub fn semantic_enabled() -> bool {
    let overridden = std::env::var("LIGHTHOUSE_EMBED_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some();
    if !crate::config::is_desktop_app() && !overridden {
        return false;
    }
    crate::settings::read_desktop_settings().semantic_search != Some(false)
}

/// The bundled embedding model: any real GGUF under `resources/embed/`.
/// Deliberately a SEPARATE directory from `resources/llm` — the chat-model
/// discovery in local_model.rs picks up any >100 MB GGUF in its search dirs,
/// and the embedding weights must never masquerade as an installed chat model.
pub fn bundled_embed_model() -> Option<PathBuf> {
    let dir = resources_dir().join("embed");
    let entries = std::fs::read_dir(&dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if !p
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().ends_with(".gguf"))
            .unwrap_or(false)
        {
            continue;
        }
        let big_enough = std::fs::metadata(&p).map(|m| m.len() > 10_000_000).unwrap_or(false);
        let mut magic = [0u8; 4];
        let is_gguf = std::fs::File::open(&p)
            .and_then(|mut f| f.read_exact(&mut magic))
            .map(|_| &magic == b"GGUF")
            .unwrap_or(false);
        if big_enough && is_gguf {
            return Some(p);
        }
    }
    None
}

// --- Quantized vectors -------------------------------------------------------------

/// A unit-normalized embedding quantized to i8 with one f32 scale — 769 bytes
/// per chunk instead of 3 KB, at a recall cost too small to measure here.
#[derive(Clone)]
pub struct QVec {
    pub scale: f32,
    pub q: Vec<i8>,
}

/// Quantize a raw embedding: L2-normalize (defensive — the server already
/// normalizes for /v1/embeddings), then map the largest component to ±127.
pub fn quantize(v: &[f32]) -> QVec {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm = if norm == 0.0 { 1.0 } else { norm };
    let max_abs = v.iter().fold(0.0f32, |m, x| m.max((x / norm).abs()));
    let max_abs = if max_abs == 0.0 { 1.0 } else { max_abs };
    let scale = max_abs / 127.0;
    let q = v
        .iter()
        .map(|x| ((x / norm) / scale).round().clamp(-127.0, 127.0) as i8)
        .collect();
    QVec { scale, q }
}

/// Cosine between a raw f32 query vector and a quantized document vector.
/// Both sides are unit-normalized, so the dot product IS the cosine.
pub fn cosine_qf(qnorm: &[f32], d: &QVec) -> f64 {
    if qnorm.len() != d.q.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    for (a, b) in qnorm.iter().zip(&d.q) {
        dot += a * (*b as f32);
    }
    (dot * d.scale) as f64
}

/// L2-normalize in place; returns None for a zero vector.
fn unit(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm == 0.0 {
        return None;
    }
    for x in &mut v {
        *x /= norm;
    }
    Some(v)
}

// --- Sidecar store -----------------------------------------------------------------
//
// `cache/vectors-v1.bin` beside the index: vectors keyed by node id + the SAME
// `mtimeMs:size` freshness key the index entry carries, so a vector set is
// valid exactly when its index entry is. Binary because 768 floats × thousands
// of chunks in JSON would dwarf the corpus. Layout (all little-endian):
//   "LHV1" | u32 dim | u32 n_files | per file:
//     u16 id_len, id | u16 key_len, key | u32 n_chunks | n_chunks × (f32 scale, dim × i8)

const SIDECAR_MAGIC: &[u8; 4] = b"LHV1";

struct VecState {
    state_dir: PathBuf,
    dim: usize,
    files: HashMap<String, (String, Vec<QVec>)>,
}

static VSTATE: Mutex<Option<VecState>> = Mutex::new(None);

fn sidecar_path(sd: &Path) -> PathBuf {
    let dir = sd.join("cache");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("vectors-v1.bin")
}

fn load_sidecar(sd: &Path) -> (usize, HashMap<String, (String, Vec<QVec>)>) {
    let mut out = HashMap::new();
    let Ok(buf) = std::fs::read(sidecar_path(sd)) else {
        return (0, out);
    };
    let mut at = 0usize;
    let take = |at: &mut usize, n: usize| -> Option<&[u8]> {
        let s = buf.get(*at..*at + n)?;
        *at += n;
        Some(s)
    };
    let read_u16 = |at: &mut usize| take(at, 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let read_u32 =
        |at: &mut usize| take(at, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let parse = |at: &mut usize| -> Option<(usize, HashMap<String, (String, Vec<QVec>)>)> {
        if take(at, 4)? != SIDECAR_MAGIC {
            return None;
        }
        let dim = read_u32(at)?;
        if dim == 0 || dim > 8192 {
            return None;
        }
        let n_files = read_u32(at)?;
        let mut files = HashMap::new();
        for _ in 0..n_files {
            let id_len = read_u16(at)?;
            let id = String::from_utf8(take(at, id_len)?.to_vec()).ok()?;
            let key_len = read_u16(at)?;
            let key = String::from_utf8(take(at, key_len)?.to_vec()).ok()?;
            let n_chunks = read_u32(at)?;
            if n_chunks > 1_000_000 {
                return None;
            }
            let mut vecs = Vec::with_capacity(n_chunks);
            for _ in 0..n_chunks {
                let scale = f32::from_le_bytes(take(at, 4)?.try_into().ok()?);
                let q: Vec<i8> = take(at, dim)?.iter().map(|b| *b as i8).collect();
                vecs.push(QVec { scale, q });
            }
            files.insert(id, (key, vecs));
        }
        Some((dim, files))
    };
    match parse(&mut at) {
        Some((dim, files)) => (dim, files),
        None => {
            out.clear(); // corrupt/foreign file — rebuilt by the warm pass
            (0, out)
        }
    }
}

fn save_sidecar(sd: &Path, dim: usize, files: &HashMap<String, (String, Vec<QVec>)>) {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(SIDECAR_MAGIC);
    buf.extend_from_slice(&(dim as u32).to_le_bytes());
    buf.extend_from_slice(&(files.len() as u32).to_le_bytes());
    for (id, (key, vecs)) in files {
        buf.extend_from_slice(&(id.len().min(u16::MAX as usize) as u16).to_le_bytes());
        buf.extend_from_slice(&id.as_bytes()[..id.len().min(u16::MAX as usize)]);
        buf.extend_from_slice(&(key.len().min(u16::MAX as usize) as u16).to_le_bytes());
        buf.extend_from_slice(&key.as_bytes()[..key.len().min(u16::MAX as usize)]);
        buf.extend_from_slice(&(vecs.len() as u32).to_le_bytes());
        for v in vecs {
            buf.extend_from_slice(&v.scale.to_le_bytes());
            buf.extend(v.q.iter().map(|b| *b as u8));
        }
    }
    let path = sidecar_path(sd);
    let tmp = path.with_extension("bin.tmp");
    if std::fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(&buf).and(f.flush()))
        .is_ok()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Run `f` with the loaded vector state for the current vault (lazy load, and
/// reload when tests / vault switches move state_dir).
fn with_vstate<R>(f: impl FnOnce(&mut VecState) -> R) -> R {
    let sd = state_dir();
    let mut guard = VSTATE.lock().unwrap_or_else(|p| p.into_inner());
    let reload = !matches!(guard.as_ref(), Some(s) if s.state_dir == sd);
    if reload {
        let (dim, files) = load_sidecar(&sd);
        *guard = Some(VecState {
            state_dir: sd,
            dim,
            files,
        });
    }
    f(guard.as_mut().unwrap())
}

/// Vectors for a file, only if they were built from exactly this content key.
pub fn vectors_for(id: &str, key: &str) -> Option<Vec<QVec>> {
    with_vstate(|s| {
        s.files
            .get(id)
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    })
}

// --- Embedding client ---------------------------------------------------------------
//
// Blocking on purpose: retrieval runs inside spawn_blocking, and the warm pass
// runs on its own thread. Tight timeouts keep a hung server from stalling asks —
// a miss just means "lexical-only this query".

fn http() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .connect_timeout(std::time::Duration::from_millis(400))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .ok()
        })
        .as_ref()
}

/// nomic-embed requires task prefixes; both sides must use the matching pair.
fn prefixed(text: &str, is_query: bool) -> String {
    let cap = if is_query { QUERY_MAX_CHARS } else { EMBED_MAX_CHARS };
    let body: String = text.chars().take(cap).collect();
    if is_query {
        format!("search_query: {body}")
    } else {
        format!("search_document: {body}")
    }
}

/// Embed a batch of texts. None on any transport/shape failure (callers treat
/// that as "embeddings unavailable", never as an error). `timeout_ms` is tight
/// for query-time calls (a slow server must not stall an ask) and generous for
/// the background warm pass (weak CPUs embedding big batches).
pub fn embed_texts(texts: &[String], is_query: bool, timeout_ms: u64) -> Option<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Some(Vec::new());
    }
    let client = http()?;
    let input: Vec<String> = texts.iter().map(|t| prefixed(t, is_query)).collect();
    let res = client
        .post(format!("{}/v1/embeddings", embed_url()))
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .json(&serde_json::json!({ "input": input, "model": "lighthouse-embed" }))
        .send()
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body: serde_json::Value = res.json().ok()?;
    let data = body["data"].as_array()?;
    if data.len() != texts.len() {
        return None;
    }
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let v: Vec<f32> = item["embedding"]
            .as_array()?
            .iter()
            .map(|x| x.as_f64().unwrap_or(0.0) as f32)
            .collect();
        if v.is_empty() {
            return None;
        }
        out.push(v);
    }
    Some(out)
}

/// One embedded, unit-normalized query vector (None ⇒ lexical-only).
pub fn query_vector(query: &str) -> Option<Vec<f32>> {
    if !semantic_enabled() {
        return None;
    }
    let vs = embed_texts(&[query.to_string()], true, 1500)?;
    unit(vs.into_iter().next()?)
}

/// Hybrid retrieval scores for one query (the B2 entry point, called from
/// vault::retrieve). `chunks` describes every scored chunk as
/// (file id, index freshness key, ordinal within the file); `lex` is the raw
/// lexical cosine per chunk, same order. Returns RRF-fused display scores, or
/// None ⇒ keep the lexical scores untouched (off, server down, vectors cold).
pub fn hybrid_scores(
    query: &str,
    chunks: &[(String, String, usize)],
    lex: &[f64],
) -> Option<Vec<f64>> {
    if chunks.is_empty() || chunks.len() != lex.len() {
        return None;
    }
    let qv = query_vector(query)?; // checks the toggle; embeds with a tight timeout
    // Vector cosine per chunk where a current vector exists.
    let mut cos: Vec<Option<f64>> = vec![None; chunks.len()];
    let mut by_file: HashMap<(&str, &str), Vec<usize>> = HashMap::new();
    for (i, (id, key, _)) in chunks.iter().enumerate() {
        by_file.entry((id, key)).or_default().push(i);
    }
    let mut covered = 0usize;
    for ((id, key), idxs) in by_file {
        let Some(vecs) = vectors_for(id, key) else {
            continue;
        };
        for i in idxs {
            let ord = chunks[i].2;
            if let Some(v) = vecs.get(ord) {
                cos[i] = Some(cosine_qf(&qv, v));
                covered += 1;
            }
        }
    }
    // Fusing while most chunks are still un-embedded would over-rank whichever
    // files the warm pass reached first; stay lexical until coverage is real.
    if (covered as f64) < chunks.len() as f64 * 0.8 {
        return None;
    }
    let mut lex_ranked: Vec<usize> = (0..lex.len()).filter(|&i| lex[i] > 0.0).collect();
    lex_ranked.sort_by(|&a, &b| lex[b].partial_cmp(&lex[a]).unwrap_or(std::cmp::Ordering::Equal));
    let mut vec_ranked: Vec<usize> = (0..cos.len())
        .filter(|&i| cos[i].is_some_and(|c| c > 0.0))
        .collect();
    vec_ranked.sort_by(|&a, &b| {
        cos[b]
            .partial_cmp(&cos[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(rrf_scores(chunks.len(), &lex_ranked, &vec_ranked))
}

// --- Reciprocal-rank fusion -----------------------------------------------------------

/// Fuse two ranked lists of chunk indices (best first) into per-chunk display
/// scores on the existing retrieval scale: a chunk ranked #1 by BOTH legs
/// scores 1.0; #1 in exactly one leg scores 0.5. Only the top RRF_DEPTH of
/// each list contributes, so deep-tail ranks don't add a noise floor.
pub fn rrf_scores(n: usize, lex_ranked: &[usize], vec_ranked: &[usize]) -> Vec<f64> {
    let mut fused = vec![0.0f64; n];
    let scale = (RRF_K + 1.0) / 2.0; // 1/(k+1) per leg → 0.5 per top rank
    for (rank, &i) in lex_ranked.iter().take(RRF_DEPTH).enumerate() {
        if let Some(f) = fused.get_mut(i) {
            *f += scale / (RRF_K + rank as f64 + 1.0);
        }
    }
    for (rank, &i) in vec_ranked.iter().take(RRF_DEPTH).enumerate() {
        if let Some(f) = fused.get_mut(i) {
            *f += scale / (RRF_K + rank as f64 + 1.0);
        }
    }
    fused
}

// --- Warm pass -------------------------------------------------------------------------
//
// Build vectors for every in-memory index entry that lacks a current set.
// Single-flight + debounced; safe to nudge from anywhere, any number of times.
// The pass early-outs instantly when semantic search is off, the server is
// unreachable (not started yet, crashed, port taken), or nothing is missing —
// correctness never depends on it (retrieval checks keys per query).

static WARMING: AtomicBool = AtomicBool::new(false);
static LAST_NUDGE_MS: AtomicI64 = AtomicI64::new(0);

/// Ask the warm pass to run soon (no-op if one is running or just ran).
pub fn nudge_warm() {
    if !semantic_enabled() {
        return;
    }
    let now = crate::config::now_ms();
    let last = LAST_NUDGE_MS.load(Ordering::Relaxed);
    if now - last < 5_000 {
        return; // debounce bursts (per-query nudges, watcher storms)
    }
    LAST_NUDGE_MS.store(now, Ordering::Relaxed);
    if WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("lh-embed-warm".into())
        .spawn(|| {
            warm_once();
            WARMING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        WARMING.store(false, Ordering::SeqCst);
    }
}

fn server_healthy() -> bool {
    http()
        .map(|c| {
            c.get(format!("{}/health", embed_url()))
                .timeout(std::time::Duration::from_millis(700))
                .send()
                .map(|r| r.status().is_success())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn warm_once() {
    if !semantic_enabled() || !server_healthy() {
        return;
    }
    let snapshot = crate::index::snapshot_chunks();
    if snapshot.is_empty() {
        return;
    }
    let sd = state_dir();
    // Trim vectors for files no longer in the index snapshot lazily: keep the
    // map bounded by only retaining ids present in the snapshot or fresher.
    let want: Vec<(String, String, Vec<String>)> = {
        let have: HashMap<String, String> = with_vstate(|s| {
            s.files
                .iter()
                .map(|(id, (key, _))| (id.clone(), key.clone()))
                .collect()
        });
        snapshot
            .into_iter()
            .filter(|(id, key, chunks)| !chunks.is_empty() && have.get(id) != Some(key))
            .collect()
    };
    if want.is_empty() {
        return;
    }
    let mut dim_seen = 0usize;
    for (id, key, chunks) in want {
        if !semantic_enabled() {
            break; // toggled off mid-pass
        }
        let mut vecs: Vec<QVec> = Vec::with_capacity(chunks.len());
        let mut ok = true;
        for batch in chunks.chunks(WARM_BATCH) {
            match embed_texts(batch, false, 30_000) {
                Some(embedded) => {
                    for v in embedded {
                        dim_seen = v.len();
                        vecs.push(quantize(&v));
                    }
                }
                None => {
                    ok = false; // server went away — retry on a later nudge
                    break;
                }
            }
        }
        if !ok {
            break;
        }
        with_vstate(|s| {
            if dim_seen != 0 && s.dim != dim_seen {
                if s.dim != 0 {
                    s.files.clear(); // model changed dims — old vectors are garbage
                }
                s.dim = dim_seen;
            }
            s.files.insert(id.clone(), (key.clone(), vecs));
        });
        // Persist after every file so a mid-pass quit loses at most one file.
        with_vstate(|s| save_sidecar(&sd, s.dim, &s.files));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_roundtrip_preserves_cosine() {
        let a: Vec<f32> = (0..768).map(|i| ((i as f32) * 0.37).sin()).collect();
        let b: Vec<f32> = (0..768).map(|i| ((i as f32) * 0.11).cos()).collect();
        let (ua, ub) = (unit(a).unwrap(), unit(b).unwrap());
        let exact: f64 = ua.iter().zip(&ub).map(|(x, y)| (x * y) as f64).sum();
        let approx = cosine_qf(&ua, &quantize(&ub));
        assert!((exact - approx).abs() < 0.01, "exact {exact} vs approx {approx}");
        // Self-similarity stays ~1.
        let self_sim = cosine_qf(&ua, &quantize(&ua));
        assert!((self_sim - 1.0).abs() < 0.01, "{self_sim}");
    }

    #[test]
    fn rrf_scales_to_the_retrieval_scoreboard() {
        // Chunk 2 is #1 in both legs → 1.0; chunk 0 is #1 lexical only → 0.5.
        let fused = rrf_scores(4, &[2, 0, 1], &[2, 3]);
        assert!((fused[2] - 1.0).abs() < 1e-9, "{fused:?}");
        assert!((fused[0] - 0.5 * 61.0 / 62.0).abs() < 1e-9, "{fused:?}");
        assert_eq!(fused[1] > 0.0, true);
        assert_eq!(fused.len(), 4);
    }

    #[test]
    fn sidecar_roundtrips_through_disk() {
        let dir = std::env::temp_dir().join(format!("lh-embed-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let v1 = quantize(&(0..64).map(|i| i as f32 / 64.0).collect::<Vec<_>>());
        let v2 = quantize(&(0..64).map(|i| (64 - i) as f32 / 64.0).collect::<Vec<_>>());
        let mut files = HashMap::new();
        files.insert("fileA".to_string(), ("123:456".to_string(), vec![v1.clone(), v2.clone()]));
        save_sidecar(&dir, 64, &files);
        let (dim, loaded) = load_sidecar(&dir);
        assert_eq!(dim, 64);
        let (key, vecs) = loaded.get("fileA").expect("fileA present");
        assert_eq!(key, "123:456");
        assert_eq!(vecs.len(), 2);
        assert_eq!(vecs[0].q, v1.q);
        assert!((vecs[1].scale - v2.scale).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_sidecar_loads_empty() {
        let dir = std::env::temp_dir().join(format!("lh-embed-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(sidecar_path(&dir), b"not a sidecar at all").unwrap();
        let (dim, loaded) = load_sidecar(&dir);
        assert_eq!(dim, 0);
        assert!(loaded.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
