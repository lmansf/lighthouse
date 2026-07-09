//! Local vault engine (port of `src/server/vault.ts`).
//!
//! Turns a real directory of files into the contract's FileNode tree, persists
//! per-node inclusion flags, and runs real content retrieval (TF-IDF cosine
//! over the text of the *included* files only). No cloud, no database server —
//! just the filesystem, byte-compatible with the TS engine's `state.json`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::config::{
    read_json, state_dir, state_path, utc_day, vault_dir, write_json, VAULT_SOURCE_ID,
};
use crate::contracts::{DataSource, FileNode, NodeKind, RagReference};
use crate::extract::{extract_rich_text, is_rich_file};

/// An item referenced in place (not copied) — its real absolute path on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub path: String,
    pub name: String,
    pub kind: String, // "file" | "folder"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    #[serde(default = "default_true")]
    pub source_available: bool,
    /// Explicit inclusion overrides keyed by node id; absent ⇒ default.
    #[serde(default)]
    pub included: HashMap<String, bool>,
    /// External references keyed by a synthetic node-id prefix (e.g. "ext0").
    #[serde(default)]
    pub references: HashMap<String, Reference>,
}

fn default_true() -> bool {
    true
}

impl Default for VaultState {
    fn default() -> Self {
        VaultState {
            source_available: true,
            included: HashMap::new(),
            references: HashMap::new(),
        }
    }
}

fn load_state() -> VaultState {
    read_json(&state_path(), VaultState::default())
}

fn save_state(s: &VaultState) {
    write_json(&state_path(), s);
    invalidate_walk_cache(); // inclusion flags and references feed the walked tree
}

/// True when `child` is `parent` or lives beneath it on disk (string paths).
fn is_within(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}{MAIN_SEPARATOR}"))
}

fn paths_overlap(a: &str, b: &str) -> bool {
    is_within(a, b) || is_within(b, a)
}

/// Which reference, if any, owns a node id (`extN` itself or `extN/...`).
fn ref_id_of<'a>(id: &str, refs: &'a HashMap<String, Reference>) -> Option<&'a str> {
    refs.keys()
        .find(|r| id == r.as_str() || id.starts_with(&format!("{r}/")))
        .map(|s| s.as_str())
}

/// Lexically absolutize + normalize (like Node's `path.resolve`: no symlink
/// resolution, `..`/`.` collapsed).
fn lexical_resolve(base: &Path, sub: &str) -> PathBuf {
    let joined = if Path::new(sub).is_absolute() {
        PathBuf::from(sub)
    } else {
        base.join(sub)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node-style `path.resolve(p)` for a single (possibly relative) path.
fn resolve_path(p: &str) -> PathBuf {
    lexical_resolve(&std::env::current_dir().unwrap_or_default(), p)
}

/// Resolve a vault-relative id to an absolute path, refusing to escape the vault.
fn safe_abs(rel_id: &str) -> anyhow::Result<PathBuf> {
    let base = vault_dir();
    let abs = lexical_resolve(&base, rel_id);
    let (b, a) = (
        base.to_string_lossy().to_string(),
        abs.to_string_lossy().to_string(),
    );
    if a != b && !a.starts_with(&format!("{b}{MAIN_SEPARATOR}")) {
        anyhow::bail!("path escapes the vault");
    }
    Ok(abs)
}

/// Resolve a node id to an absolute path on disk. Vault-relative ids map under
/// the vault directory; referenced ids (`extN/...`) map under their registered
/// real path. Both reject paths that escape their base.
fn resolve_abs(id: &str, state: &VaultState) -> anyhow::Result<PathBuf> {
    let Some(ref_id) = ref_id_of(id, &state.references) else {
        return safe_abs(id);
    };
    let base = resolve_path(&state.references[ref_id].path);
    let sub = id[ref_id.len()..].trim_start_matches('/');
    let abs = lexical_resolve(&base, sub);
    let (b, a) = (
        base.to_string_lossy().to_string(),
        abs.to_string_lossy().to_string(),
    );
    if a != b && !a.starts_with(&format!("{b}{MAIN_SEPARATOR}")) {
        anyhow::bail!("path escapes the reference");
    }
    Ok(abs)
}

/// Resolve a node id to its real absolute path (vault file or referenced item).
/// Used to open a file in its native application from a chat citation.
pub fn resolve_node_path(node_id: &str) -> anyhow::Result<PathBuf> {
    resolve_abs(node_id, &load_state())
}

/// The real roots of every linked reference (for the FS watcher).
pub fn reference_roots() -> Vec<PathBuf> {
    load_state()
        .references
        .values()
        .map(|r| resolve_path(&r.path))
        .collect()
}

/// Reference roots paired with their `extN` ids (for path→id mapping).
pub fn reference_roots_with_ids() -> Vec<(String, PathBuf)> {
    load_state()
        .references
        .iter()
        .map(|(id, r)| (id.clone(), resolve_path(&r.path)))
        .collect()
}

// --- walk cache ---------------------------------------------------------------

/// Snapshot TTL for the walked tree. With the Phase 5 watcher active, external
/// changes invalidate the snapshot by event, so the TTL is only a deep
/// fallback (60 s); without a watcher it keeps the legacy 3 s bound on how
/// long an outside change can go unnoticed. Every in-app mutation invalidates
/// immediately either way.
fn walk_ttl_ms() -> u128 {
    if crate::watch::is_active() {
        60_000
    } else {
        3_000
    }
}

struct WalkCache {
    root: PathBuf,
    nodes: Vec<FileNode>,
    at: Instant,
}

static WALK_CACHE: Mutex<Option<WalkCache>> = Mutex::new(None);

pub fn invalidate_walk_cache() {
    *WALK_CACHE.lock().unwrap() = None;
}

/// Whether absent inclusion flags default to INCLUDED. Honors the user's
/// explicit onboarding choice first (`include`/`exclude`), falling back to the
/// `default_inclusion` A/B experiment variant when they haven't chosen.
fn default_included() -> bool {
    crate::profile::effective_default_inclusion() == "include"
}

/// Effective inclusion. An ancestor folder explicitly excluded always forces a
/// node out. For an absent own flag the default is the experiment's.
fn is_effectively_included(id: &str, state: &VaultState, default_in: bool) -> bool {
    let parts: Vec<&str> = id.split('/').collect();
    let mut prefix = String::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if prefix.is_empty() {
            prefix = (*part).to_string();
        } else {
            prefix = format!("{prefix}/{part}");
        }
        if state.included.get(&prefix) == Some(&false) {
            return false; // an ancestor folder is excluded
        }
    }
    if default_in {
        state.included.get(id) != Some(&false)
    } else {
        state.included.get(id) == Some(&true)
    }
}

/// Extensions read directly as UTF-8 text (rich binary formats go via extract).
const TEXT_EXT: &[&str] = &[
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".rst",
    ".csv",
    ".tsv",
    ".json",
    ".yaml",
    ".yml",
    ".log",
    ".html",
    ".htm",
    // .xml deliberately absent: app-generated sidecar/config XML in linked
    // folders kept surfacing as AI sources (0.6.x field report). The files
    // stay visible in the explorer — they just never become chunks.
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".java",
    ".go",
    ".rb",
    ".rs",
    ".c",
    ".h",
    ".cpp",
    ".sh",
    ".sql",
    ".toml",
    ".ini",
    ".env",
    ".css",
];

fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{}", ext.to_lowercase()),
        _ => String::new(),
    }
}

fn is_text_file(name: &str) -> bool {
    TEXT_EXT.contains(&ext_of(name).as_str())
}

fn mime_of(name: &str) -> Option<String> {
    let m = match ext_of(name).as_str() {
        ".md" | ".markdown" => "text/markdown",
        ".txt" => "text/plain",
        ".csv" => "text/csv",
        ".json" => "application/json",
        ".pdf" => "application/pdf",
        ".html" | ".htm" => "text/html",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls" => "application/vnd.ms-excel",
        _ => return None,
    };
    Some(m.to_string())
}

/// Serializes cache rebuilds: the tree poll, a window-focus refresh, and a
/// watcher push routinely land TOGETHER on a just-invalidated cache, and each
/// caller used to re-walk the whole tree in parallel — a stat storm exactly
/// when the vault is busiest. Losers of this lock re-check the cache and
/// ride the winner's snapshot.
static WALK_BUILD: Mutex<()> = Mutex::new(());

fn cached_walk(root: &Path) -> Option<Vec<FileNode>> {
    let cache = WALK_CACHE.lock().unwrap();
    cache.as_ref().and_then(|c| {
        (c.root == root && c.at.elapsed().as_millis() < walk_ttl_ms()).then(|| c.nodes.clone())
    })
}

/// A node id is its POSIX-relative path from the vault root (stable + unique).
fn walk(root: &Path) -> Vec<FileNode> {
    if let Some(nodes) = cached_walk(root) {
        return nodes;
    }
    let _build = WALK_BUILD.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(nodes) = cached_walk(root) {
        return nodes; // someone rebuilt while we waited for the lock
    }
    let nodes = walk_uncached(root);
    *WALK_CACHE.lock().unwrap() = Some(WalkCache {
        root: root.to_path_buf(),
        nodes: nodes.clone(),
        at: Instant::now(),
    });
    nodes
}

fn rel_id(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn walk_uncached(root: &Path) -> Vec<FileNode> {
    let mut out: Vec<FileNode> = Vec::new();
    let state = load_state();
    let default_in = default_included(); // resolve the variant once for this walk

    fn recurse(
        out: &mut Vec<FileNode>,
        state: &VaultState,
        default_in: bool,
        root: &Path,
        abs_dir: &Path,
        parent_id: Option<&str>,
    ) {
        let Ok(entries) = fs::read_dir(abs_dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // skip .rag-vault and dotfiles
            }
            let abs = abs_dir.join(&name);
            let id = rel_id(root, &abs);
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                out.push(FileNode {
                    id: id.clone(),
                    parent_id: parent_id.map(String::from),
                    source_id: VAULT_SOURCE_ID.to_string(),
                    name,
                    kind: NodeKind::Folder,
                    mime_type: None,
                    size: None,
                    rag_included: is_effectively_included(&id, state, default_in),
                    external: None,
                });
                recurse(out, state, default_in, root, &abs, Some(&id));
            } else if ft.is_file() {
                let size = fs::metadata(&abs).ok().map(|m| m.len());
                out.push(FileNode {
                    id: id.clone(),
                    parent_id: parent_id.map(String::from),
                    source_id: VAULT_SOURCE_ID.to_string(),
                    name: name.clone(),
                    kind: NodeKind::File,
                    mime_type: mime_of(&name),
                    size,
                    rag_included: is_effectively_included(&id, state, default_in),
                    external: None,
                });
            }
        }
    }
    recurse(&mut out, &state, default_in, root, root, None);

    // Referenced items (added via "Link…"): read in place under an `extN` prefix.
    let mut ref_ids: Vec<&String> = state.references.keys().collect();
    ref_ids.sort(); // deterministic order (JS object order is insertion; sort is stable enough here)
    for ref_id in ref_ids {
        let reference = &state.references[ref_id];
        let ref_path = PathBuf::from(&reference.path);
        let exists = fs::metadata(&ref_path).is_ok();
        if reference.kind == "file" {
            let size = fs::metadata(&ref_path).ok().map(|m| m.len());
            out.push(FileNode {
                id: ref_id.clone(),
                parent_id: None,
                source_id: VAULT_SOURCE_ID.to_string(),
                name: reference.name.clone(),
                kind: NodeKind::File,
                mime_type: mime_of(&reference.name),
                size,
                rag_included: is_effectively_included(ref_id, &state, default_in),
                external: Some(true),
            });
            continue;
        }
        out.push(FileNode {
            id: ref_id.clone(),
            parent_id: None,
            source_id: VAULT_SOURCE_ID.to_string(),
            name: reference.name.clone(),
            kind: NodeKind::Folder,
            mime_type: None,
            size: None,
            rag_included: is_effectively_included(ref_id, &state, default_in),
            external: Some(true),
        });
        if !exists {
            continue;
        }

        fn recurse_ext(
            out: &mut Vec<FileNode>,
            state: &VaultState,
            default_in: bool,
            ref_root: &Path,
            ref_id: &str,
            abs_dir: &Path,
            parent_id: &str,
        ) {
            let Ok(entries) = fs::read_dir(abs_dir) else {
                return;
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let abs = abs_dir.join(&name);
                let rel = rel_id(ref_root, &abs);
                let id = format!("{ref_id}/{rel}");
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    out.push(FileNode {
                        id: id.clone(),
                        parent_id: Some(parent_id.to_string()),
                        source_id: VAULT_SOURCE_ID.to_string(),
                        name,
                        kind: NodeKind::Folder,
                        mime_type: None,
                        size: None,
                        rag_included: is_effectively_included(&id, state, default_in),
                        external: Some(true),
                    });
                    recurse_ext(out, state, default_in, ref_root, ref_id, &abs, &id);
                } else if ft.is_file() {
                    let size = fs::metadata(&abs).ok().map(|m| m.len());
                    out.push(FileNode {
                        id: id.clone(),
                        parent_id: Some(parent_id.to_string()),
                        source_id: VAULT_SOURCE_ID.to_string(),
                        name: name.clone(),
                        kind: NodeKind::File,
                        mime_type: mime_of(&name),
                        size,
                        rag_included: is_effectively_included(&id, state, default_in),
                        external: Some(true),
                    });
                }
            }
        }
        recurse_ext(
            &mut out, &state, default_in, &ref_path, ref_id, &ref_path, ref_id,
        );
    }
    out
}

pub fn list_sources() -> Vec<DataSource> {
    let state = load_state();
    vec![DataSource {
        id: VAULT_SOURCE_ID.to_string(),
        name: "Local Vault".to_string(),
        kind: "folder".to_string(),
        available: state.source_available,
    }]
}

/// Full-tree listing — the app's regular vault scan (also the hook that catches
/// files copied in / deleted OUTSIDE the app, via the privacy-safe presence diff).
pub fn list_nodes() -> Vec<FileNode> {
    let all = walk(&vault_dir());
    record_presence_diff(&all);
    all
}

fn usage_snapshot_path() -> PathBuf {
    state_dir().join("usage-snapshot.json")
}

#[derive(Default, Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    ids: HashMap<String, String>,
}

/// Emit privacy-safe file-presence telemetry by diffing the current tree against
/// the last snapshot. COUNTS ONLY — at most a coarse `{ kind }`, never a name.
/// First run seeds silently. Best-effort: never breaks or slows the scan.
fn record_presence_diff(nodes: &[FileNode]) {
    let mut current: HashMap<String, String> = HashMap::new();
    for n in nodes {
        let kind = match n.kind {
            NodeKind::File => "file",
            NodeKind::Folder => "folder",
        };
        current.insert(n.id.clone(), kind.to_string());
    }
    let snap: Option<Snapshot> = read_json(&usage_snapshot_path(), None);
    let Some(prev) = snap.map(|s| s.ids) else {
        write_json(&usage_snapshot_path(), &Snapshot { ids: current });
        return;
    };
    for (id, kind) in &current {
        if !prev.contains_key(id) {
            fire_event("file_added", kind);
        }
    }
    for (id, kind) in &prev {
        if !current.contains_key(id) {
            fire_event("file_removed", kind);
        }
    }
    write_json(&usage_snapshot_path(), &Snapshot { ids: current });
}

/// Fire-and-forget telemetry (needs a Tokio runtime; silently skipped without one).
fn fire_event(name: &'static str, kind: &str) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let props = serde_json::json!({ "kind": kind });
        handle.spawn(async move {
            crate::license::record_event(name, props).await;
        });
    }
}

/// Toggle a node and (for folders) all of its descendants.
pub fn set_included(node_id: &str, value: bool) {
    let all = walk(&vault_dir());
    let mut target: HashSet<String> = HashSet::from([node_id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for n in &all {
            if let Some(pid) = &n.parent_id {
                if target.contains(pid) && !target.contains(&n.id) {
                    target.insert(n.id.clone());
                    grew = true;
                }
            }
        }
    }
    let mut state = load_state();
    for id in target {
        state.included.insert(id, value);
    }
    save_state(&state);
}

pub fn set_source_available(available: bool) {
    let mut state = load_state();
    state.source_available = available;
    save_state(&state);
}

/// Move a file/folder within the vault (an *internal* move), preserving its
/// inclusion setting and that of its subtree.
pub fn move_node(from_id: &str, to_parent_id: Option<&str>) -> anyhow::Result<String> {
    if from_id.is_empty() {
        anyhow::bail!("fromId required");
    }
    let from_abs = safe_abs(from_id)?;
    let name = from_id.rsplit('/').next().unwrap_or(from_id).to_string();
    let new_id = match to_parent_id {
        Some(p) => format!("{p}/{name}"),
        None => name,
    };
    let to_abs = safe_abs(&new_id)?;
    if fs::metadata(&from_abs).is_err() {
        anyhow::bail!("source not found");
    }
    if fs::metadata(&to_abs).is_ok() {
        anyhow::bail!("destination already exists");
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&from_abs, &to_abs)?;

    // Remap the node and every descendant's inclusion flag onto the new prefix.
    let mut state = load_state();
    let mut next: HashMap<String, bool> = HashMap::new();
    for (k, v) in &state.included {
        if k == from_id {
            next.insert(new_id.clone(), *v);
        } else if k.starts_with(&format!("{from_id}/")) {
            next.insert(format!("{new_id}{}", &k[from_id.len()..]), *v);
        } else {
            next.insert(k.clone(), *v);
        }
    }
    state.included = next;
    save_state(&state);
    Ok(new_id)
}

/// Rename a node in place (same parent, new basename), carrying its inclusion
/// flags and its subtree's. Refuses empty / dotfile / separator names and a
/// destination that already exists. Vault-resident nodes only.
pub fn rename_node(id: &str, new_name: &str) -> anyhow::Result<String> {
    if id.is_empty() {
        anyhow::bail!("id required");
    }
    let clean = new_name.trim();
    if clean.is_empty() || clean.starts_with('.') || clean.contains('/') || clean.contains('\\') {
        anyhow::bail!("invalid name");
    }
    let from_abs = safe_abs(id)?;
    if fs::metadata(&from_abs).is_err() {
        anyhow::bail!("source not found");
    }
    let new_id = match id.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{clean}"),
        None => clean.to_string(),
    };
    if new_id == id {
        return Ok(new_id); // no-op rename
    }
    let to_abs = safe_abs(&new_id)?;
    if fs::metadata(&to_abs).is_ok() {
        anyhow::bail!("destination already exists");
    }
    fs::rename(&from_abs, &to_abs)?;
    // Remap the node and every descendant's inclusion flag (same as move_node).
    let mut state = load_state();
    let mut next: HashMap<String, bool> = HashMap::new();
    for (k, v) in &state.included {
        if k == id {
            next.insert(new_id.clone(), *v);
        } else if k.starts_with(&format!("{id}/")) {
            next.insert(format!("{new_id}{}", &k[id.len()..]), *v);
        } else {
            next.insert(k.clone(), *v);
        }
    }
    state.included = next;
    save_state(&state);
    Ok(new_id)
}

/// Create an empty folder under a parent (or the vault root when None). Returns
/// its id. Refuses empty / dotfile / separator names and existing paths.
pub fn create_folder(parent_id: Option<&str>, name: &str) -> anyhow::Result<String> {
    let clean = name.trim();
    if clean.is_empty() || clean.starts_with('.') || clean.contains('/') || clean.contains('\\') {
        anyhow::bail!("invalid folder name");
    }
    let new_id = match parent_id {
        Some(p) if !p.is_empty() => format!("{p}/{clean}"),
        _ => clean.to_string(),
    };
    let abs = safe_abs(&new_id)?;
    if fs::metadata(&abs).is_ok() {
        anyhow::bail!("a file or folder with that name already exists");
    }
    fs::create_dir_all(&abs)?;
    invalidate_walk_cache(); // a new (empty, excluded) folder — no state entry
    Ok(new_id)
}

/// Write an uploaded file into the vault (optionally under a folder). Collisions
/// get a " (n)" suffix. No state entry is created, so an uploaded file follows
/// the default-inclusion experiment like any external add.
pub fn add_file(name: &str, bytes: &[u8], dest_parent_id: Option<&str>) -> anyhow::Result<String> {
    let safe_name = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim()
        .to_string();
    if safe_name.is_empty() || safe_name.starts_with('.') {
        anyhow::bail!("invalid filename");
    }
    let ext = ext_of_preserving_case(&safe_name);
    let base = &safe_name[..safe_name.len() - ext.len()];

    let mut final_id = match dest_parent_id {
        Some(d) => format!("{d}/{safe_name}"),
        None => safe_name.clone(),
    };
    let mut abs = safe_abs(&final_id)?;
    let mut i = 1u32;
    while fs::metadata(&abs).is_ok() {
        let alt = format!("{base} ({i}){ext}");
        final_id = match dest_parent_id {
            Some(d) => format!("{d}/{alt}"),
            None => alt,
        };
        abs = safe_abs(&final_id)?;
        i += 1;
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&abs, bytes)?;
    invalidate_walk_cache(); // a new file exists that no state write announced
    Ok(final_id)
}

/// Like Node's `path.extname`: extension including the dot, original case.
fn ext_of_preserving_case(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.contains('/') => format!(".{ext}"),
        _ => String::new(),
    }
}

/// Register a file or folder *in place* (a reference / link) instead of copying.
/// The path must exist. Re-linking the same path is idempotent; overlapping an
/// existing reference (or the vault) is rejected so content is never indexed twice.
pub fn add_reference(input_path: &str) -> anyhow::Result<(String, String)> {
    let abs = resolve_path(input_path);
    let meta = fs::metadata(&abs).map_err(|_| anyhow::anyhow!("path not found"))?;
    let kind = if meta.is_dir() { "folder" } else { "file" };
    let mut state = load_state();

    let abs_s = abs.to_string_lossy().to_string();
    let vault_s = vault_dir().to_string_lossy().to_string();
    if paths_overlap(&abs_s, &vault_s) {
        anyhow::bail!("overlaps the vault");
    }
    let mut ids: Vec<String> = state.references.keys().cloned().collect();
    ids.sort();
    for id in &ids {
        let r = &state.references[id];
        let rp = resolve_path(&r.path).to_string_lossy().to_string();
        if rp == abs_s {
            return Ok((id.clone(), r.kind.clone()));
        }
        // A path INSIDE an already-linked folder resolves to that existing
        // descendant node id instead of re-linking.
        if r.kind == "folder" && is_within(&rp, &abs_s) {
            let rel = abs
                .strip_prefix(&rp)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            return Ok((format!("{id}/{rel}"), kind.to_string()));
        }
        if paths_overlap(&abs_s, &rp) {
            anyhow::bail!("overlaps an existing reference");
        }
    }

    let mut i = 0u32;
    let mut id = format!("ext{i}");
    while state.references.contains_key(&id) {
        i += 1;
        id = format!("ext{i}");
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| abs_s.clone());
    state.references.insert(
        id.clone(),
        Reference {
            path: abs_s,
            name,
            kind: kind.to_string(),
        },
    );
    save_state(&state);
    // Index the newly-linked content in the background now, so the first
    // question afterwards doesn't stall on building it interactively.
    warm_index_async();
    Ok((id, kind.to_string()))
}

/// Collect + drop the inclusion flags for a node and its subtree, returning the
/// removed (id → included) pairs so a later restore can put them back exactly.
fn take_included_subtree(
    state: &mut VaultState,
    node_id: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let prefix = format!("{node_id}/");
    let mut taken = serde_json::Map::new();
    state.included.retain(|k, v| {
        if k.as_str() == node_id || k.starts_with(prefix.as_str()) {
            taken.insert(k.clone(), serde_json::Value::Bool(*v));
            false
        } else {
            true
        }
    });
    taken
}

/// Re-apply an (id → included) map captured by `take_included_subtree`.
fn restore_included(state: &mut VaultState, included: &serde_json::Map<String, serde_json::Value>) {
    for (k, v) in included {
        if let Some(b) = v.as_bool() {
            state.included.insert(k.clone(), b);
        }
    }
}

/// Remove a node from the vault — non-destructively. A linked item unlinks; a
/// vault-resident file/folder MOVES to a recoverable trash
/// (`.rag-vault/trash/<date>/…`) and its inclusion flags are dropped. Returns a
/// restore descriptor (fed to `restore_from_vault`) so the removal can be undone
/// without the user hand-digging the trash folder.
pub fn remove_from_vault(node_id: &str) -> anyhow::Result<serde_json::Value> {
    let mut state = load_state();
    let ref_id = ref_id_of(node_id, &state.references).map(String::from);
    // Reference root: unlink; restore re-links the same real path.
    if ref_id.as_deref() == Some(node_id) {
        let path = state
            .references
            .get(node_id)
            .map(|r| r.path.clone())
            .unwrap_or_default();
        let included = take_included_subtree(&mut state, node_id);
        state.references.remove(node_id);
        save_state(&state);
        return Ok(
            serde_json::json!({ "kind": "unlink", "root": node_id, "path": path, "included": included }),
        );
    }
    // A node *inside* a linked folder: scope the removal to just this node's
    // subtree by dropping its inclusion flags; the link itself stays intact.
    if ref_id.is_some() {
        let included = take_included_subtree(&mut state, node_id);
        save_state(&state);
        return Ok(serde_json::json!({ "kind": "flags", "included": included }));
    }
    let abs = safe_abs(node_id)?; // refuses to escape the vault
    if abs == vault_dir() {
        anyhow::bail!("cannot remove the vault root");
    }
    let included = take_included_subtree(&mut state, node_id);
    if fs::metadata(&abs).is_ok() {
        let trash_dir = state_dir().join("trash").join(utc_day());
        fs::create_dir_all(&trash_dir)?;
        let base_name = node_id.rsplit('/').next().unwrap_or(node_id);
        let mut dest = trash_dir.join(base_name);
        let dest_name = dest.file_name().unwrap().to_string_lossy().to_string();
        let ext = ext_of_preserving_case(&dest_name);
        let stem = &dest_name[..dest_name.len() - ext.len()];
        let mut i = 1u32;
        while fs::metadata(&dest).is_ok() {
            dest = trash_dir.join(format!("{stem} ({i}){ext}"));
            i += 1;
        }
        fs::rename(&abs, &dest)?;
        save_state(&state);
        return Ok(serde_json::json!({
            "kind": "trash",
            "id": node_id,
            "trashPath": dest.to_string_lossy(),
            "included": included,
        }));
    }
    // Nothing on disk to move (already gone) — only flags were dropped.
    save_state(&state);
    Ok(serde_json::json!({ "kind": "flags", "included": included }))
}

/// Reverse a `remove_from_vault` using the descriptor it returned. Non-
/// destructive and refuses to overwrite: if something now occupies the original
/// location, it fails rather than clobbering. Returns the node's (possibly new)
/// id so the caller can refresh.
pub fn restore_from_vault(desc: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let included = desc
        .get("included")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    match desc.get("kind").and_then(|v| v.as_str()) {
        Some("unlink") => {
            let path = desc.get("path").and_then(|v| v.as_str()).unwrap_or_default();
            if path.is_empty() {
                anyhow::bail!("nothing to restore");
            }
            // Re-link the same real path; it may receive a fresh extN id, so
            // remap the saved flags from the old root prefix onto the new one.
            let old_root = desc.get("root").and_then(|v| v.as_str()).unwrap_or_default();
            let (new_root, _kind) = add_reference(path)?;
            let mut state = load_state();
            for (k, v) in &included {
                if let Some(b) = v.as_bool() {
                    let new_key = if k.as_str() == old_root {
                        new_root.clone()
                    } else if let Some(rest) = k.strip_prefix(&format!("{old_root}/")) {
                        format!("{new_root}/{rest}")
                    } else {
                        k.clone()
                    };
                    state.included.insert(new_key, b);
                }
            }
            save_state(&state);
            Ok(serde_json::json!({ "id": new_root }))
        }
        Some("flags") => {
            let mut state = load_state();
            restore_included(&mut state, &included);
            save_state(&state);
            Ok(serde_json::json!({ "ok": true }))
        }
        Some("trash") => {
            let id = desc.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let trash_path = desc
                .get("trashPath")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if id.is_empty() || trash_path.is_empty() {
                anyhow::bail!("incomplete restore token");
            }
            let abs = safe_abs(id)?;
            if fs::metadata(&abs).is_ok() {
                anyhow::bail!("something already exists at the original location");
            }
            if let Some(parent) = abs.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(trash_path, &abs)?;
            let mut state = load_state();
            restore_included(&mut state, &included);
            save_state(&state);
            Ok(serde_json::json!({ "id": id }))
        }
        _ => anyhow::bail!("unknown restore token"),
    }
}

/// Drop a reference (unlink). Leaves the real files on disk untouched.
pub fn remove_reference(ref_id: &str) {
    let mut state = load_state();
    if state.references.remove(ref_id).is_none() {
        return;
    }
    state
        .included
        .retain(|k, _| k != ref_id && !k.starts_with(&format!("{ref_id}/")));
    save_state(&state);
}

/// File ids currently included on disk — the single source of truth for what
/// chat may see. Empty if the vault source is toggled unavailable.
pub fn active_included_file_ids() -> Vec<String> {
    let state = load_state();
    if !state.source_available {
        return Vec::new();
    }
    let default_in = default_included();
    walk(&vault_dir())
        .into_iter()
        .filter(|n| n.kind == NodeKind::File && is_effectively_included(&n.id, &state, default_in))
        .map(|n| n.id)
        .collect()
}

// --- text reading ---------------------------------------------------------------

/// Read text from an absolute path — rich formats (pdf/docx/xlsx) go through
/// the extractor with its own size handling and cache; plain text is read
/// directly, capped at `cap` bytes so one pathological file can't dominate
/// memory. The index (Phase 5) passes a generous, env-tunable cap; the legacy
/// 1 MB bound existed only to protect the per-query read path that no longer
/// exists.
pub fn read_text_abs_capped(abs: &Path, cap: u64) -> String {
    let name = abs.to_string_lossy();
    if is_rich_file(&name) {
        return extract_rich_text(abs, &ext_of(&name));
    }
    if !is_text_file(&name) {
        return String::new();
    }
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    if size <= cap {
        return fs::read(abs)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
    }
    // Large file: read only the first `cap` bytes.
    use std::io::Read;
    let Ok(f) = fs::File::open(abs) else {
        return String::new();
    };
    let mut buf = vec![0u8; cap as usize];
    let mut taken = f.take(cap);
    let mut read = 0usize;
    loop {
        match taken.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return String::new(),
        }
    }
    String::from_utf8_lossy(&buf[..read]).into_owned()
}

// --- tokenization & scoring ------------------------------------------------------

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "as", "at",
    "by", "from", "this", "that", "it", "be", "do", "does", "have", "any", "there", "my", "our",
    "your", "you", "me", "i",
];

/// Lowercased runs of `[a-z0-9]{2,}` minus stop words (port of `tokenize`).
pub fn tokenize(s: &str) -> Vec<String> {
    word_runs(&s.to_lowercase())
        .into_iter()
        .filter(|t| t.len() >= 2 && !STOP_WORDS.contains(&t.as_str()))
        .collect()
}

/// All maximal runs of ascii `[a-z0-9]` in an (already lowercased) string.
fn word_runs(lower: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Crude singularizer so "cards" matches "card".
fn singular(t: &str) -> &str {
    if t.len() > 3 && t.ends_with('s') {
        &t[..t.len() - 1]
    } else {
        t
    }
}

/// Searchable tokens from a file's name and path.
pub fn name_tokens_of(id: &str, name: &str) -> Vec<String> {
    tokenize(&format!("{} {}", id.replace('/', " "), name))
}

/// How strongly the query matches a file's name/path tokens.
fn name_match(q_tokens: &[String], name_toks: &[String]) -> (usize, bool) {
    let mut hits = 0usize;
    let mut strong = false;
    for raw in q_tokens {
        let q = singular(raw);
        if q.len() < 3 {
            continue;
        }
        let hit = name_toks.iter().any(|nt0| {
            let nt = singular(nt0);
            nt == q || nt.contains(q) || (nt.len() >= 3 && q.contains(nt))
        });
        if hit {
            hits += 1;
            if raw.len() >= 4 {
                strong = true;
            }
        }
    }
    (hits, strong)
}

/// The named-file pin's target, if any: the single file whose meaningful
/// name/path tokens the question covers substantially enough to read as
/// "the user named this file". Deliberately conservative — the pin FORCES a
/// file into the top-k, so a weak or ambiguous match must select nothing
/// (0.6.2 field report: a lone generic token shared with a filename pinned
/// irrelevant files — "quoting the right documents but recommending the
/// wrong ones"). KEEP IN SYNC with vault.ts::pinnedNamedFile. Rules:
///   - coverage: the question must mention at least half of the file's
///     unique meaningful name tokens (len ≥ 3, extension tokens dropped);
///   - specificity: ≥ 2 covered tokens, or a single-token name whose token
///     is ≥ 5 chars ("resume" can pin, "plan" never does);
///   - uniqueness: two files with the same coverage signature mean the
///     phrase is generic (meeting-notes-1/2/3…) — pin nothing.
fn pinned_named_file<'a>(
    qtokens: &[String],
    files: impl Iterator<Item = (&'a str, &'a [String])>,
) -> Option<&'a str> {
    let mut best: Option<(&str, usize, usize)> = None; // (id, covered, total)
    let mut ambiguous = false;
    for (id, name_toks) in files {
        let mut uniq: Vec<&str> = name_toks
            .iter()
            .map(|t| singular(t))
            .filter(|t| t.len() >= 3 && !EXT_TOKENS.contains(t))
            .collect();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.is_empty() {
            continue;
        }
        let covered: Vec<&str> = uniq
            .iter()
            .copied()
            .filter(|&nt| {
                qtokens.iter().any(|q0| {
                    let q = singular(q0);
                    q.len() >= 3 && (q == nt || nt.contains(q) || q.contains(nt))
                })
            })
            .collect();
        let (c, m) = (covered.len(), uniq.len());
        let specific = c >= 2 || (m == 1 && covered.first().is_some_and(|t| t.len() >= 5));
        if c * 2 < m || !specific {
            continue;
        }
        match best {
            None => best = Some((id, c, m)),
            Some((_, bc, bm)) => {
                // Compare coverage fractions via cross-multiplication (c/m
                // vs bc/bm), then absolute covered count. An exact tie on
                // both is the generic-siblings case.
                let (lhs, rhs) = (c * bm, bc * m);
                if lhs > rhs || (lhs == rhs && c > bc) {
                    best = Some((id, c, m));
                    ambiguous = false;
                } else if lhs == rhs && c == bc {
                    ambiguous = true;
                }
            }
        }
    }
    if ambiguous {
        return None;
    }
    best.map(|(id, _, _)| id)
}

// --- catalog / listing queries ----------------------------------------------------

struct Listing {
    label: String,
    exts: Option<HashSet<String>>, // None ⇒ match every file
}

fn listing_exts(kind: &str) -> Vec<&'static str> {
    match kind {
        "dataset" => vec![
            ".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".json", ".arrow", ".feather",
        ],
        "spreadsheet" => vec![".csv", ".tsv", ".xlsx", ".xls"],
        "document" => vec![
            ".md",
            ".markdown",
            ".txt",
            ".text",
            ".rst",
            ".doc",
            ".docx",
            ".pdf",
            ".rtf",
            ".odt",
        ],
        "pdf" => vec![".pdf"],
        _ => vec![],
    }
}

const LISTING_FILLER: &[&str] = &[
    "show",
    "me",
    "list",
    "give",
    "please",
    "can",
    "could",
    "would",
    "you",
    "display",
    "name",
    "names",
    "enumerate",
    "tell",
    "what",
    "which",
    "how",
    "many",
    "much",
    "are",
    "there",
    "is",
    "do",
    "does",
    "did",
    "i",
    "we",
    "my",
    "our",
    "the",
    "a",
    "an",
    "all",
    "every",
    "each",
    "of",
    "in",
    "on",
    "to",
    "get",
    "see",
    "view",
    "find",
    "catalog",
    "catalogue",
    "count",
    "number",
    "total",
    "available",
    "included",
    "uploaded",
    "stored",
    "have",
    "has",
    "any",
];

const LISTING_NOUN: &[&str] = &[
    "file",
    "files",
    "dataset",
    "datasets",
    "document",
    "documents",
    "doc",
    "docs",
    "pdf",
    "pdfs",
    "spreadsheet",
    "spreadsheets",
    "csv",
    "csvs",
    "table",
    "tables",
    "source",
    "sources",
];

fn listing_qualifier(t: &str) -> Option<Vec<&'static str>> {
    let exts: Vec<&'static str> = match t {
        "csv" => vec![".csv"],
        "tsv" => vec![".tsv"],
        "xlsx" => vec![".xlsx"],
        "xls" => vec![".xls"],
        "parquet" => vec![".parquet"],
        "json" => vec![".json"],
        "arrow" => vec![".arrow"],
        "feather" => vec![".feather"],
        "md" | "markdown" => vec![".md", ".markdown"],
        "txt" | "text" => vec![".txt", ".text"],
        "rst" => vec![".rst"],
        "rtf" => vec![".rtf"],
        "odt" => vec![".odt"],
        "docx" => vec![".docx"],
        "xml" => vec![".xml"],
        "html" => vec![".html"],
        _ => return None,
    };
    Some(exts)
}

/// Whether `q` contains `phrase` bounded by non-word chars (JS `\b…\b` on a
/// literal, supporting the two-word "how many").
fn contains_phrase(q: &str, phrase: &str) -> bool {
    let bytes = q.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut start = 0;
    while let Some(pos) = q[start..].find(phrase) {
        let at = start + pos;
        let before_ok = at == 0 || !is_word(bytes[at - 1]);
        let after = at + phrase.len();
        let after_ok = after >= bytes.len() || !is_word(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        start = at + 1;
    }
    false
}

/// Detect a catalog-style query ("show me all files", "list my datasets", "how
/// many documents") and which file kind it refers to. None for an ordinary
/// content question.
fn listing_intent(query: &str) -> Option<Listing> {
    let q = query.to_lowercase();
    // First noun token matching \b(file|dataset|document|doc|pdf|spreadsheet|csv|table|source)(s)?\b.
    const NOUNS: &[&str] = &[
        "file",
        "dataset",
        "document",
        "doc",
        "pdf",
        "spreadsheet",
        "csv",
        "table",
        "source",
    ];
    let tokens = word_runs(&q);
    let mut matched: Option<(&str, bool)> = None; // (noun, plural)
    'outer: for t in &tokens {
        for n in NOUNS {
            if t == n {
                matched = Some((n, false));
                break 'outer;
            }
            if t.len() == n.len() + 1 && t.starts_with(n) && t.ends_with('s') {
                matched = Some((n, true));
                break 'outer;
            }
        }
    }
    let (noun, plural) = matched?;

    let verb = [
        "show",
        "list",
        "give",
        "display",
        "name",
        "what",
        "which",
        "enumerate",
        "tell",
    ]
    .iter()
    .any(|v| contains_phrase(&q, v))
        || contains_phrase(&q, "how many");
    if !verb {
        return None;
    }
    let strong = [
        "all",
        "every",
        "each",
        "list",
        "enumerate",
        "catalog",
        "catalogue",
    ]
    .iter()
    .any(|v| contains_phrase(&q, v))
        || contains_phrase(&q, "how many");
    if !plural && !strong {
        return None;
    }

    // Only a pure catalog request should enumerate: if any meaningful content
    // token survives the scaffolding strip, fall through to relevance ranking.
    let residual = tokens.iter().any(|t| {
        !LISTING_FILLER.contains(&t.as_str())
            && !LISTING_NOUN.contains(&t.as_str())
            && listing_qualifier(t).is_none()
    });
    if residual {
        return None;
    }

    // A named file-type qualifier narrows the listing to exactly its extensions.
    let mut qual_words: Vec<String> = Vec::new();
    let mut qual_exts: HashSet<String> = HashSet::new();
    for t in &tokens {
        let base = if listing_qualifier(t).is_some() {
            Some(t.clone())
        } else if t.ends_with('s') && listing_qualifier(&t[..t.len() - 1]).is_some() {
            Some(t[..t.len() - 1].to_string())
        } else {
            None
        };
        if let Some(b) = base {
            if !qual_words.contains(&b) {
                for e in listing_qualifier(&b).unwrap() {
                    qual_exts.insert(e.to_string());
                }
                qual_words.push(b);
            }
        }
    }
    if !qual_exts.is_empty() {
        return Some(Listing {
            label: format!(
                "{} files",
                qual_words
                    .iter()
                    .map(|w| w.to_uppercase())
                    .collect::<Vec<_>>()
                    .join("/")
            ),
            exts: Some(qual_exts),
        });
    }

    let kind = match noun {
        "dataset" | "csv" | "table" => "dataset",
        "spreadsheet" => "spreadsheet",
        "document" | "doc" => "document",
        "pdf" => "pdf",
        _ => "all",
    };
    if kind == "all" {
        return Some(Listing {
            label: "files".to_string(),
            exts: None,
        });
    }
    let exts: HashSet<String> = listing_exts(kind).into_iter().map(String::from).collect();
    let label = if kind == "pdf" {
        "PDFs".to_string()
    } else {
        format!("{kind}s")
    };
    Some(Listing {
        label,
        exts: Some(exts),
    })
}

fn listing_matches(intent: &Listing, name: &str) -> bool {
    match &intent.exts {
        None => true,
        Some(exts) => exts.contains(&ext_of(name)),
    }
}

/// Enumerate the included files matching a listing intent (capped for huge vaults).
fn build_listing(nodes: &[FileNode], intent: &Listing) -> Retrieved {
    let files: Vec<&FileNode> = nodes
        .iter()
        .filter(|n| listing_matches(intent, &n.name))
        .collect();
    if files.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![Context {
                name: format!("Included {}", intent.label),
                text: format!("No included {} found.", intent.label),
                score: 1.0,
            }],
        };
    }
    const CAP: usize = 50;
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    let mut list = format!("{} included {}:\n", files.len(), intent.label);
    list.push_str(
        &names
            .iter()
            .take(CAP)
            .map(|n| format!("- {n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if names.len() > CAP {
        list.push_str(&format!("\n…and {} more", names.len() - CAP));
    }
    let references: Vec<RagReference> = files
        .iter()
        .take(CAP)
        .map(|f| RagReference {
            file_id: f.id.clone(),
            name: f.name.clone(),
            snippet: String::new(),
            score: 1.0,
        })
        .collect();
    Retrieved {
        references,
        contexts: vec![Context {
            name: format!("Included {}", intent.label),
            text: list,
            score: 1.0,
        }],
    }
}

// --- chunking & retrieval -----------------------------------------------------------

/// Split like JS `text.split(/\s+/)` (leading/trailing empties preserved so
/// window alignment matches the TS chunker exactly).
fn js_split_ws(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    if rest.is_empty() {
        return vec![""];
    }
    let starts_ws = rest
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(false);
    if starts_ws {
        out.push(&text[0..0]); // JS yields a leading ""
    }
    while !rest.is_empty() {
        let ws_at = rest.find(char::is_whitespace);
        match ws_at {
            Some(0) => {
                let next = rest
                    .char_indices()
                    .find(|(_, c)| !c.is_whitespace())
                    .map(|(i, _)| i)
                    .unwrap_or(rest.len());
                rest = &rest[next..];
                if rest.is_empty() {
                    out.push(&text[0..0]); // trailing ""
                }
            }
            Some(i) => {
                out.push(&rest[..i]);
                rest = &rest[i..];
            }
            None => {
                out.push(rest);
                rest = &rest[rest.len()..];
            }
        }
    }
    out
}

/// Structure-aware chunking (docs/analytics-genie.md, B1): tabular extracts
/// chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
/// holding row 400 still carries its column names; prose keeps the word
/// windows below. KEEP BYTE-IDENTICAL with the TS chunker (vault.ts chunksOf).
pub fn chunk_texts_named(name: &str, text: &str) -> Vec<String> {
    if crate::analytics::is_tabular(name) {
        return chunk_tabular(name, text);
    }
    chunk_texts_of(text)
}

fn chunk_tabular(name: &str, text: &str) -> Vec<String> {
    const ROWS: usize = 30;
    const ROW_OVERLAP: usize = 5;
    let lower = name.to_lowercase();
    // Workbook extracts prepend the sheet name above each sheet's CSV; carry
    // BOTH the sheet line and the header row into every chunk.
    let header_lines = if lower.ends_with(".xlsx") || lower.ends_with(".xls") { 2 } else { 1 };
    let mut chunks: Vec<String> = Vec::new();
    // Blank-line-separated blocks (one per sheet for workbooks).
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block
            .split('\n')
            .map(str::trim_end)
            .filter(|l| !l.trim().is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let h = header_lines.min(lines.len().saturating_sub(1));
        if lines.len() <= h + 1 {
            chunks.push(lines.join("\n"));
            continue;
        }
        let header = lines[..h].join("\n");
        let data = &lines[h..];
        let mut i = 0usize;
        while i < data.len() {
            let end = (i + ROWS).min(data.len());
            let body = data[i..end].join("\n");
            chunks.push(if header.is_empty() { body } else { format!("{header}\n{body}") });
            if i + ROWS >= data.len() {
                break;
            }
            i += ROWS - ROW_OVERLAP;
        }
    }
    chunks
}

/// 120-word chunks with 25-word overlap — identical windows to the TS engine.
/// Term frequencies are attached by the index at build time.
pub fn chunk_texts_of(text: &str) -> Vec<String> {
    let words = js_split_ws(text);
    const SIZE: usize = 120;
    const OVERLAP: usize = 25;
    let mut chunks = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        let end = (i + SIZE).min(words.len());
        let slice = words[i..end].join(" ").trim().to_string();
        if !slice.is_empty() {
            chunks.push(slice);
        }
        if i + SIZE >= words.len() {
            break;
        }
        i += SIZE - OVERLAP;
    }
    chunks
}

#[derive(Debug, Clone, Serialize)]
pub struct Context {
    pub name: String,
    pub text: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Retrieved {
    pub references: Vec<RagReference>,
    pub contexts: Vec<Context>,
}

/// An externally-mirrored item (cloud connector) ranked alongside vault files.
pub struct ExternalItem {
    pub id: String,
    pub name: String,
    pub abs: PathBuf,
}

/// Build the retrieval index for everything currently included, on a
/// background thread (bounded parallelism inside `entries_for`). Called after
/// linking a folder and at desktop boot so the FIRST question never pays the
/// whole corpus build interactively — that wait was the "load times are very
/// slow after linking a large number of files" complaint. Single-flight: a
/// request that lands while one is running is dropped (the per-query key
/// check self-heals any gap).
pub fn warm_index_async() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WARMING: AtomicBool = AtomicBool::new(false);
    if WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("lh-index-warm".into())
        .spawn(|| {
            let ids: HashSet<String> = active_included_file_ids().into_iter().collect();
            let state = load_state();
            let items: Vec<crate::index::IndexItem> = walk(&vault_dir())
                .into_iter()
                .filter(|n| n.kind == NodeKind::File && ids.contains(&n.id))
                .map(|n| crate::index::IndexItem {
                    abs: resolve_abs(&n.id, &state).ok(),
                    path_for: n.id.clone(),
                    id: n.id,
                    name: n.name,
                })
                .collect();
            let _ = crate::index::entries_for(&items);
            // Vectors may be cold even when every index entry was a hit (first
            // boot after enabling B2, sidecar deleted, embed server was down).
            crate::embed::nudge_warm();
            WARMING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        WARMING.store(false, Ordering::SeqCst);
    }
}

/// Retrieval over the included files: TF-IDF cosine over content chunks combined
/// with a filename/path match, plus catalog/listing enumeration.
pub fn retrieve(
    query: &str,
    included_file_ids: &[String],
    k: usize,
    external: &[ExternalItem],
    attachment_ids: &[String],
) -> Retrieved {
    // Explicit per-question attachments scope retrieval to only them (the attach
    // gesture is the consent); otherwise server-authoritative inclusion.
    let idset: HashSet<&str> = if !attachment_ids.is_empty() {
        attachment_ids.iter().map(String::as_str).collect()
    } else {
        let authoritative = active_included_file_ids();
        let auth: HashSet<&str> = authoritative.iter().map(String::as_str).collect();
        included_file_ids
            .iter()
            .map(String::as_str)
            .filter(|id| auth.contains(*id))
            .collect()
    };
    let owned_ids: Vec<String> = idset.iter().map(|s| s.to_string()).collect();
    let idset: HashSet<String> = owned_ids.into_iter().collect();

    let state = load_state();
    let nodes: Vec<FileNode> = walk(&vault_dir())
        .into_iter()
        .filter(|n| n.kind == NodeKind::File && idset.contains(&n.id))
        .collect();
    if nodes.is_empty() && external.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    // Catalog/listing intent enumerates vault files.
    if !nodes.is_empty() {
        if let Some(listing) = listing_intent(query) {
            return build_listing(&nodes, &listing);
        }
    }

    let qtokens = tokenize(query);
    if qtokens.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    // Unified retrieval items served by the persistent index (Phase 5): vault
    // files by node id, mirrored cloud files by absolute mirror path. Stale or
    // missing entries are rebuilt in parallel inside `entries_for`.
    let items: Vec<crate::index::IndexItem> = nodes
        .iter()
        .map(|n| crate::index::IndexItem {
            id: n.id.clone(),
            name: n.name.clone(),
            path_for: n.id.clone(),
            abs: resolve_abs(&n.id, &state).ok(),
        })
        .chain(external.iter().map(|e| crate::index::IndexItem {
            id: e.id.clone(),
            name: e.name.clone(),
            path_for: String::new(),
            abs: Some(e.abs.clone()),
        }))
        .collect();
    let entries = crate::index::entries_for(&items);

    // Chunks scored this query. The legacy 4,000-chunk cap protected the
    // per-query read loop; from the index a far larger budget is cheap, and
    // hitting it is logged instead of silent.
    let max_chunks = crate::index::max_query_chunks();
    type ChunkRef<'a> = (
        &'a str,
        &'a crate::index::FileEntry,
        &'a crate::index::IndexedChunk,
    );
    let mut chunk_refs: Vec<ChunkRef> = Vec::new();
    'items: for item in &items {
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        for c in &entry.chunks {
            if chunk_refs.len() >= max_chunks {
                eprintln!(
                    "retrieve: chunk budget {max_chunks} reached; some included content was not scored this query"
                );
                break 'items;
            }
            chunk_refs.push((item.id.as_str(), entry, c));
        }
    }

    // --- content scoring (TF-IDF cosine over chunks; identical math to TS) ---
    struct Scored<'a> {
        file_id: &'a str,
        name: &'a str,
        text: &'a str,
        score: f64,
    }
    let mut scored: Vec<Scored> = Vec::new();
    if !chunk_refs.is_empty() {
        let mut df: HashMap<&str, f64> = HashMap::new();
        for (_, _, c) in &chunk_refs {
            for t in c.tf.keys() {
                *df.entry(t.as_str()).or_insert(0.0) += 1.0;
            }
        }
        let n = chunk_refs.len() as f64;
        let idf = |t: &str| ((n + 1.0) / (df.get(t).copied().unwrap_or(0.0) + 1.0)).ln() + 1.0;
        let mut qtf: HashMap<String, f64> = HashMap::new();
        for t in &qtokens {
            *qtf.entry(t.clone()).or_insert(0.0) += 1.0;
        }
        let vec_of = |tf: &HashMap<String, f64>| -> (HashMap<String, f64>, f64) {
            let mut v = HashMap::new();
            let mut norm = 0.0;
            for (t, f) in tf {
                let w = f * idf(t);
                v.insert(t.clone(), w);
                norm += w * w;
            }
            (v, if norm.sqrt() == 0.0 { 1.0 } else { norm.sqrt() })
        };
        let (qv, qnorm) = vec_of(&qtf);
        let mut lex: Vec<f64> = Vec::with_capacity(chunk_refs.len());
        for (_, _, c) in &chunk_refs {
            let (dv, dnorm) = vec_of(&c.tf);
            let mut dot = 0.0;
            for (t, w) in &qv {
                dot += w * dv.get(t).copied().unwrap_or(0.0);
            }
            lex.push(dot / (qnorm * dnorm));
        }
        // Hybrid search (B2): when the local embedding server is up and the
        // scored chunks have current vectors, replace the raw lexical scores
        // with RRF-fused lexical+vector scores. None ⇒ exactly today's path.
        let chunk_meta: Vec<(String, String, usize)> = {
            let mut ord: HashMap<&str, usize> = HashMap::new();
            chunk_refs
                .iter()
                .map(|(id, entry, _)| {
                    let o = ord.entry(id).or_insert(0);
                    let meta = (id.to_string(), entry.key.clone(), *o);
                    *o += 1;
                    meta
                })
                .collect()
        };
        let base = crate::embed::hybrid_scores(query, &chunk_meta, &lex).unwrap_or(lex);
        for (i, (file_id, entry, c)) in chunk_refs.iter().enumerate() {
            let mut score = base[i];
            // Nudge a chunk up when its file also matches by name.
            let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
            if strong {
                score += 0.2 * (hits as f64 / qtokens.len() as f64);
            }
            scored.push(Scored {
                file_id,
                name: entry.name.as_str(),
                text: c.text.as_str(),
                score,
            });
        }
    }

    // Merged candidates: scored content chunks, plus a synthetic entry for any
    // file that matches by name but isn't already represented by its content.
    struct Cand {
        file_id: String,
        name: String,
        text: String,
        score: f64,
    }
    let mut cands: Vec<Cand> = scored
        .iter()
        .filter(|s| s.score > 0.0)
        .map(|s| Cand {
            file_id: s.file_id.to_string(),
            name: s.name.to_string(),
            text: s.text.to_string(),
            score: s.score,
        })
        .collect();
    let present: HashSet<String> = cands.iter().map(|c| c.file_id.clone()).collect();
    for item in &items {
        if present.contains(&item.id) {
            continue;
        }
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
        if hits == 0 || !strong {
            continue;
        }
        let pv = entry.preview.clone();
        cands.push(Cand {
            file_id: item.id.clone(),
            name: item.name.clone(),
            text: if pv.is_empty() {
                "(matched by file name; no readable text could be extracted)".to_string()
            } else {
                pv
            },
            score: 0.5 + 0.4 * (hits as f64 / qtokens.len() as f64), // 0.5..0.9
        });
    }

    cands.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut top: Vec<&Cand> = cands.iter().take(k).collect();
    // Named-file guarantee: a question that strongly names a file MUST surface
    // that file. Before hybrid search this held by accident — name-matched
    // candidates (0.5–0.9) always beat lexical cosines (~0.05–0.3). RRF fused
    // scores fill the 0.9–1.0 band, so topically-similar chunks from OTHER
    // files can crowd the named file out of the top-k (0.6.0 field report:
    // "the file is not present in the provided context" — about a file named
    // verbatim in the question). Pin the best-named file's best candidate
    // into the last slot when ranking dropped it.
    let named = pinned_named_file(
        &qtokens,
        items.iter().filter_map(|item| {
            entries
                .get(&item.id)
                .map(|e| (item.id.as_str(), e.name_tokens.as_slice()))
        }),
    );
    if let Some(named_id) = named {
        if !top.iter().any(|c| c.file_id == named_id) {
            if let Some(best) = cands.iter().find(|c| c.file_id == named_id) {
                if top.len() >= k && !top.is_empty() {
                    top.pop();
                }
                top.push(best);
            }
        }
    }
    if top.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    let max = if top[0].score == 0.0 {
        1.0
    } else {
        top[0].score
    };
    // One reference per file (best chunk), but keep all top chunks as context.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut references: Vec<RagReference> = Vec::new();
    for c in &top {
        if seen.contains(c.file_id.as_str()) {
            continue;
        }
        seen.insert(&c.file_id);
        let snippet: String = c.text.chars().take(240).collect();
        let truncated = c.text.chars().count() > 240;
        references.push(RagReference {
            file_id: c.file_id.clone(),
            name: c.name.clone(),
            snippet: format!("{}{}", snippet.trim(), if truncated { "…" } else { "" }),
            score: (c.score / max).min(1.0),
        });
    }
    let contexts: Vec<Context> = top
        .iter()
        .map(|c| Context {
            name: c.name.clone(),
            text: c.text.clone(),
            score: (c.score / max).min(1.0),
        })
        .collect();
    Retrieved {
        references,
        contexts,
    }
}

/// A file's display name + extracted text, for the synthesis pipeline
/// (crate::synth): table profiles need the full content; `preview_chars`
/// bounds the map-step fallback used when a query's tokens miss the file.
/// Mirrors src/server/vault.ts::docText.
pub fn doc_text(file_id: &str, preview_chars: Option<usize>) -> Option<(String, String)> {
    const DOC_TEXT_CAP: u64 = 4 * 1024 * 1024;
    let node = walk(&vault_dir())
        .into_iter()
        .find(|n| n.kind == NodeKind::File && n.id == file_id)?;
    let state = load_state();
    let abs = resolve_abs(file_id, &state).ok()?;
    let text = read_text_abs_capped(&abs, DOC_TEXT_CAP);
    if text.trim().is_empty() {
        return None;
    }
    let text = match preview_chars {
        Some(n) => text.chars().take(n).collect(),
        None => text,
    };
    Some((node.name, text))
}

/// Extension-ish tokens that don't count as "naming" a file in a question.
const EXT_TOKENS: &[&str] = &[
    "xlsx", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
    "pptx", "json", "html", "log",
];

/// Vault files the question NAMES (every meaningful name token appears in the
/// question) that are NOT currently included. Feeds the deterministic
/// "it exists but the AI can't see it" note in the answer pipeline — without
/// it, asking about an excluded file gets a gaslighting "not present in the
/// provided context" (0.6.0 field report, verbatim file name in the question).
/// Returns display names, capped at 2.
pub fn named_but_excluded(question: &str) -> Vec<String> {
    let qtokens: Vec<String> = tokenize(question).iter().map(|t| singular(t).to_string()).collect();
    if qtokens.is_empty() {
        return Vec::new();
    }
    let active: HashSet<String> = active_included_file_ids().into_iter().collect();
    let mut out = Vec::new();
    for node in walk(&vault_dir()) {
        if node.kind != NodeKind::File || active.contains(&node.id) {
            continue;
        }
        let meaningful: Vec<String> = tokenize(&node.name)
            .into_iter()
            .filter(|t| t.len() >= 3 && !EXT_TOKENS.contains(&t.as_str()))
            .collect();
        if meaningful.is_empty() || !meaningful.iter().any(|t| t.len() >= 4) {
            continue; // too generic to claim the question "named" it
        }
        let all_present = meaningful.iter().all(|nt0| {
            let nt = singular(nt0);
            qtokens.iter().any(|q| q == nt || q.contains(nt) || (q.len() >= 3 && nt.contains(q.as_str())))
        });
        if all_present {
            out.push(node.name);
            if out.len() == 2 {
                break;
            }
        }
    }
    out
}

/// A file's display name + resolved absolute path, for the analytics engine
/// (crate::analytics) — csv/tsv/parquet register with DataFusion by real path.
pub fn doc_path(file_id: &str) -> Option<(String, PathBuf)> {
    let node = walk(&vault_dir())
        .into_iter()
        .find(|n| n.kind == NodeKind::File && n.id == file_id)?;
    let state = load_state();
    let abs = resolve_abs(file_id, &state).ok()?;
    Some((node.name, abs))
}

#[cfg(test)]
mod named_pin_tests {
    use super::{name_tokens_of, pinned_named_file, tokenize};

    fn files(ids: &[&str]) -> Vec<(String, Vec<String>)> {
        ids.iter().map(|id| (id.to_string(), name_tokens_of(id, id))).collect()
    }

    fn pick<'a>(question: &str, fs: &'a [(String, Vec<String>)]) -> Option<&'a str> {
        let q = tokenize(question);
        pinned_named_file(&q, fs.iter().map(|(id, t)| (id.as_str(), t.as_slice())))
    }

    #[test]
    fn a_verbatim_name_pins() {
        let fs = files(&["1 Galaxy Servers.md", "meeting-notes-1.md", "recipes.md"]);
        assert_eq!(pick("what is inside 1 Galaxy Servers", &fs), Some("1 Galaxy Servers.md"));
    }

    /// 0.6.2 field report: right quotes, wrong recommended files — a lone
    /// generic token ("plan") shared with a filename must never force it in.
    #[test]
    fn a_lone_generic_token_never_pins() {
        let fs = files(&["plan.md", "roadmap.md"]);
        assert_eq!(pick("what is the plan for the rollout", &fs), None);
    }

    #[test]
    fn a_distinctive_single_token_name_still_pins() {
        let fs = files(&["resume.pdf", "recipes.md"]);
        assert_eq!(pick("can you summarize my resume", &fs), Some("resume.pdf"));
    }

    /// Same coverage signature across sibling files = a generic phrase, not
    /// a named file — nothing may be pinned arbitrarily.
    #[test]
    fn generic_siblings_tie_and_nothing_pins() {
        let fs = files(&["meeting-notes-1.md", "meeting-notes-2.md"]);
        assert_eq!(pick("what did the meeting notes say", &fs), None);
    }

    #[test]
    fn fuller_name_coverage_wins_over_partial() {
        let fs = files(&["galaxy servers rollout plan.md", "1 Galaxy Servers.md"]);
        assert_eq!(pick("what is inside 1 galaxy servers", &fs), Some("1 Galaxy Servers.md"));
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::chunk_texts_named;

    /// PARITY FIXTURE — mirrored in test/chunker.test.mjs. 70 data rows chunk
    /// as 1-30 / 26-55 / 51-70, every chunk led by the header line.
    #[test]
    fn csv_rows_chunk_with_header_prepended() {
        let mut text = String::from("region,amount\n");
        for i in 1..=70 {
            text.push_str(&format!("r{i},{i}\n"));
        }
        let chunks = chunk_texts_named("sales.csv", &text);
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert!(c.starts_with("region,amount\n"), "{c}");
        }
        assert!(chunks[0].ends_with("r30,30"));
        assert!(chunks[1].contains("r26,26") && chunks[1].ends_with("r55,55"));
        assert!(chunks[2].contains("r51,51") && chunks[2].ends_with("r70,70"));
    }

    #[test]
    fn workbook_blocks_carry_sheet_and_header_lines() {
        let mut text = String::from("Sheet1\nh1,h2\na,1\nb,2\nc,3\n\nSheet2\nh1,h2\n");
        for i in 1..=40 {
            text.push_str(&format!("x{i},{i}\n"));
        }
        let chunks = chunk_texts_named("book.xlsx", &text);
        assert_eq!(chunks.len(), 3); // sheet1: 1 chunk · sheet2: rows 1-30, 26-40
        assert!(chunks[0].starts_with("Sheet1\nh1,h2\n"));
        assert!(chunks[1].starts_with("Sheet2\nh1,h2\n") && chunks[1].ends_with("x30,30"));
        assert!(chunks[2].starts_with("Sheet2\nh1,h2\n") && chunks[2].ends_with("x40,40"));
    }

    #[test]
    fn prose_keeps_word_windows() {
        let text = (1..=300).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let chunks = chunk_texts_named("notes.md", &text);
        assert_eq!(chunks.len(), 3); // 120-word windows, 95-word step
        assert!(chunks[0].starts_with("w1 ") && chunks[0].ends_with("w120"));
    }
}
