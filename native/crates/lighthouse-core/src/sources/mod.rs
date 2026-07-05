//! Source registry — the seam that keeps the explorer and API source-agnostic
//! (port of `src/server/sources/registry.ts` + `local.ts`).
//!
//! The local vault is always present and is the fallback owner for bare node
//! ids; the SharePoint connector owns ids prefixed `sharepoint::`. The registry
//! routes each curation op to the owning source and aggregates listings.

pub mod microsoft;
pub mod sharepoint;

use crate::contracts::{DataSource, FileNode};
use crate::vault::{self, Retrieved};

pub async fn list_sources() -> Vec<DataSource> {
    let mut out = Vec::new();
    if sharepoint::is_present() {
        out.push(sharepoint::source());
    }
    out.extend(vault::list_sources());
    out
}

pub async fn list_nodes() -> Vec<FileNode> {
    let mut out = Vec::new();
    if sharepoint::is_present() {
        out.extend(sharepoint::list_nodes());
    }
    out.extend(vault::list_nodes());
    out
}

pub async fn set_included(node_id: &str, included: bool) {
    if sharepoint::owns_id(node_id) {
        sharepoint::set_included(node_id, included);
    } else {
        vault::set_included(node_id, included);
    }
    // Newly-included content indexes in the background (single-flight, cheap
    // stat pass when nothing changed) so the next question doesn't pay for it.
    if included {
        vault::warm_index_async();
    }
}

pub async fn set_source_available(available: bool, source_id: Option<&str>) {
    if source_id == Some(crate::config::SHAREPOINT_SOURCE_ID) {
        sharepoint::set_available(available);
    } else {
        vault::set_source_available(available); // local vault is the fallback
    }
}

pub async fn add_reference(path: &str) -> anyhow::Result<(String, String)> {
    vault::add_reference(path)
}

pub async fn remove_reference(ref_id: &str) -> anyhow::Result<()> {
    if sharepoint::owns_id(ref_id) {
        anyhow::bail!("references are unsupported for this source");
    }
    vault::remove_reference(ref_id);
    Ok(())
}

pub async fn move_node(from_id: &str, to_parent_id: Option<&str>) -> anyhow::Result<String> {
    if sharepoint::owns_id(from_id) {
        anyhow::bail!("move is unsupported for this source");
    }
    vault::move_node(from_id, to_parent_id)
}

pub async fn remove_from_vault(node_id: &str) -> anyhow::Result<()> {
    if sharepoint::owns_id(node_id) {
        anyhow::bail!("remove is unsupported for this source");
    }
    vault::remove_from_vault(node_id)
}

/// Retrieval across the included set: vault files plus any cloud connector's
/// mirrored content, ranked together in the source-agnostic engine.
/// Attachment-scoped queries skip cloud mirroring (attachments are vault files).
pub async fn retrieve(
    query: &str,
    included_file_ids: &[String],
    attachment_ids: &[String],
    k: usize,
) -> Retrieved {
    let external = if attachment_ids.is_empty() {
        sharepoint::retrieval_items(included_file_ids)
    } else {
        Vec::new()
    };
    let query = query.to_string();
    let ids = included_file_ids.to_vec();
    let attachments = attachment_ids.to_vec();
    // The ranking engine is synchronous CPU+disk work; keep it off the async
    // reactor so a big corpus can't stall other requests (the TS engine blocks
    // Node's event loop here — this is the structural fix).
    tokio::task::spawn_blocking(move || vault::retrieve(&query, &ids, k, &external, &attachments))
        .await
        .unwrap_or(Retrieved {
            references: vec![],
            contexts: vec![],
        })
}
