//! SharePoint / OneDrive source connector (port of
//! `src/server/sources/sharepoint.ts`).
//!
//! Once connected, a names-only placeholder tree is cached; enabling a file
//! mirrors just its bytes into a local mirror dir where the normal retrieval
//! pipeline reads it like any vault file. Node ids are namespaced
//! `sharepoint::<driveId>::<itemId>`.
//!
//! DORMANT BY DECISION (2026-07-15): this connector is intentionally RETAINED as
//! plumbing — it is not surfaced in the shipping UI, but the connector code, its
//! `SourceConnector` seam wiring (`sources/mod.rs`), and the `SHAREPOINT_*` env
//! surface (`config.rs`) are kept on purpose. Do NOT remove them in a cleanup
//! pass; a future release may re-surface the connector. PARITY: same note on the
//! TS twin `src/server/sources/sharepoint.ts`.

use std::collections::HashMap;
use std::path::PathBuf;

use sha1::{Digest, Sha1};

use crate::config::SHAREPOINT_SOURCE_ID;
use crate::contracts::{DataSource, FileNode, NodeKind};
use crate::vault::ExternalItem;

use super::microsoft::{
    self, download_item, is_connected, list_tree, load_state, mirror_dir, save_state, MsState,
    SpNode, MAX_MIRROR_BYTES,
};

pub fn owns_id(id: &str) -> bool {
    id.starts_with(&format!("{SHAREPOINT_SOURCE_ID}::"))
}

fn node_map(nodes: &[SpNode]) -> HashMap<&str, &SpNode> {
    nodes.iter().map(|n| (n.id.as_str(), n)).collect()
}

/// Effective inclusion: the node's own flag, or any ancestor folder's flag.
fn effectively_included(id: &str, state: &MsState, by_id: &HashMap<&str, &SpNode>) -> bool {
    let empty = HashMap::new();
    let inc = state.included.as_ref().unwrap_or(&empty);
    let mut cur: Option<&str> = Some(id);
    while let Some(c) = cur {
        if inc.get(c).copied().unwrap_or(false) {
            return true;
        }
        cur = by_id.get(c).and_then(|n| n.parent_id.as_deref());
    }
    false
}

/// Local mirror path for a node, preserving its extension so the extractor
/// dispatches.
fn mirror_path_for(node: &SpNode) -> PathBuf {
    let ext = match node.name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{ext}"),
        _ => String::new(),
    };
    let mut h = Sha1::new();
    h.update(node.id.as_bytes());
    mirror_dir().join(format!("{}{ext}", hex::encode(h.finalize())))
}

/// All descendant file nodes of a folder (a file passed directly is itself).
fn descendant_files(id: &str, nodes: &[SpNode]) -> Vec<SpNode> {
    if let Some(this) = nodes.iter().find(|n| n.id == id) {
        if this.kind == "file" {
            return vec![this.clone()];
        }
    }
    let mut by_parent: HashMap<&str, Vec<&SpNode>> = HashMap::new();
    for n in nodes {
        if let Some(p) = &n.parent_id {
            by_parent.entry(p.as_str()).or_default().push(n);
        }
    }
    let mut out = Vec::new();
    let mut stack = vec![id.to_string()];
    while let Some(cur) = stack.pop() {
        for child in by_parent.get(cur.as_str()).into_iter().flatten() {
            if child.kind == "file" {
                out.push((*child).clone());
            } else {
                stack.push(child.id.clone());
            }
        }
    }
    out
}

async fn mirror(node: &SpNode) {
    let dest = mirror_path_for(node);
    if dest.exists() {
        return; // already mirrored
    }
    if let Err(err) = download_item(&node.drive_id, &node.item_id, &dest, MAX_MIRROR_BYTES).await {
        eprintln!("[sharepoint] could not mirror {}: {err}", node.name);
    }
}

/// Mirror many files with bounded concurrency so a large folder can't fan out
/// into 1500 simultaneous (or serialized) downloads.
async fn mirror_all(files: Vec<SpNode>) {
    const CONCURRENCY: usize = 4;
    let files = std::sync::Arc::new(files);
    let next = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let workers = (0..CONCURRENCY.min(files.len())).map(|_| {
        let files = files.clone();
        let next = next.clone();
        async move {
            loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= files.len() {
                    break;
                }
                mirror(&files[i]).await;
            }
        }
    });
    futures::future::join_all(workers).await;
}

fn unmirror(node: &SpNode) {
    let _ = std::fs::remove_file(mirror_path_for(node));
}

/// Refresh the cached placeholder tree from Graph (after connect / on demand).
pub async fn refresh_listing() -> anyhow::Result<usize> {
    let nodes = list_tree().await;
    let mut s = load_state();
    let count = nodes.len();
    s.nodes = Some(nodes);
    save_state(&s);
    Ok(count)
}

/// Only surfaces as a source once the user has connected.
pub fn is_present() -> bool {
    is_connected()
}

pub fn source() -> DataSource {
    let s = load_state();
    let name = match s
        .account
        .as_ref()
        .map(|a| a.email.as_str())
        .filter(|e| !e.is_empty())
    {
        Some(email) => format!("SharePoint · {email}"),
        None => "SharePoint".to_string(),
    };
    DataSource {
        id: SHAREPOINT_SOURCE_ID.to_string(),
        name,
        kind: "folder".to_string(),
        available: s.available.unwrap_or(true),
    }
}

pub fn list_nodes() -> Vec<FileNode> {
    let s = load_state();
    if !is_connected() {
        return Vec::new();
    }
    let nodes = s.nodes.clone().unwrap_or_default();
    let by_id = node_map(&nodes);
    nodes
        .iter()
        .map(|n| FileNode {
            id: n.id.clone(),
            parent_id: n.parent_id.clone(),
            source_id: SHAREPOINT_SOURCE_ID.to_string(),
            name: n.name.clone(),
            kind: if n.kind == "folder" {
                NodeKind::Folder
            } else {
                NodeKind::File
            },
            mime_type: n.mime_type.clone(),
            size: n.size,
            rag_included: effectively_included(&n.id, &s, &by_id),
            // Local-only marks live in the vault state, keyed by node id for any
            // source — so a marked SharePoint file's lock renders here too.
            local_only: crate::vault::node_is_local_only(&n.id),
            external: Some(true), // content lives remotely until mirrored
        })
        .collect()
}

pub fn set_included(node_id: &str, included: bool) {
    let mut s = load_state();
    let nodes = s.nodes.clone().unwrap_or_default();
    if !nodes.iter().any(|n| n.id == node_id) {
        return;
    }
    let map = s.included.get_or_insert_with(HashMap::new);
    if included {
        map.insert(node_id.to_string(), true);
    } else {
        map.remove(node_id);
    }
    save_state(&s);

    // Mirror (or drop) the affected files so retrieval has their content.
    let files = descendant_files(node_id, &nodes);
    if included {
        // Mirror in the background with bounded concurrency: enabling a large
        // folder shouldn't block the request; retrievalItems surfaces each file
        // lazily as its mirror lands.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { mirror_all(files).await });
        }
    } else {
        let s = load_state();
        let by_id = node_map(&nodes);
        for f in &files {
            if !effectively_included(&f.id, &s, &by_id) {
                unmirror(f);
            }
        }
    }
}

pub fn set_available(available: bool) {
    let mut s = load_state();
    s.available = Some(available);
    save_state(&s);
}

/// Mirrored content for the connector's enabled files, for the ranker.
pub fn retrieval_items(included_ids: &[String]) -> Vec<ExternalItem> {
    let s = load_state();
    if !is_connected() || s.available == Some(false) {
        return Vec::new();
    }
    let nodes = s.nodes.clone().unwrap_or_default();
    let by_id = node_map(&nodes);
    let mut out = Vec::new();
    for id in included_ids {
        if !owns_id(id) {
            continue;
        }
        let Some(node) = by_id.get(id.as_str()) else {
            continue;
        };
        if node.kind != "file" {
            continue;
        }
        if !effectively_included(id, &s, &by_id) {
            continue;
        }
        let abs = mirror_path_for(node);
        if abs.exists() {
            out.push(ExternalItem {
                id: id.clone(),
                name: node.name.clone(),
                abs,
            });
        }
    }
    out
}

/// Sign out: drop tokens, cached listing, inclusion, and mirrored content.
pub fn disconnect() {
    microsoft::disconnect();
}
