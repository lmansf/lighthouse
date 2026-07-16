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

/// Mark/unmark a node "Private — this device only". Unlike inclusion, local-only
/// is a pure gate flag with no content-mirroring side effect, and its marks live
/// in the vault state keyed by node id for ANY source — so this routes straight
/// to the vault engine regardless of which source owns the id.
pub async fn set_local_only(node_id: &str, value: bool) {
    vault::set_local_only(node_id, value);
}

/// Bulk curation rules (openspec: add-curation-rules). Like local-only marks,
/// rules live in the vault state and resolve by node id, so they route
/// straight to the vault engine regardless of the owning source.
pub async fn rules_listing() -> Vec<vault::RuleListing> {
    vault::rules_listing()
}

/// Validate + add a rule (engine-minted id); returns the enriched rule for
/// the wire. A rule can newly include content, so warm the index like a
/// visibility flip does.
pub async fn add_rule(
    scope: &str,
    kind: Option<&str>,
    ext: Option<&[String]>,
    glob: Option<&str>,
    action: &str,
) -> anyhow::Result<vault::RuleListing> {
    let rule = vault::add_rule(scope, kind, ext, glob, action)?;
    vault::warm_index_async();
    Ok(vault::enrich_rule(rule))
}

/// Remove a rule (idempotent). Removing an exclude rule can newly include
/// content too — warm the index the same way.
pub async fn remove_rule(id: &str) {
    vault::remove_rule(id);
    vault::warm_index_async();
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

pub async fn rename_node(id: &str, new_name: &str) -> anyhow::Result<String> {
    if sharepoint::owns_id(id) {
        anyhow::bail!("rename is unsupported for this source");
    }
    vault::rename_node(id, new_name)
}

pub async fn create_folder(parent_id: Option<&str>, name: &str) -> anyhow::Result<String> {
    if parent_id.is_some_and(sharepoint::owns_id) {
        anyhow::bail!("new folders are unsupported for this source");
    }
    vault::create_folder(parent_id, name)
}

pub async fn remove_from_vault(node_id: &str) -> anyhow::Result<serde_json::Value> {
    if sharepoint::owns_id(node_id) {
        anyhow::bail!("remove is unsupported for this source");
    }
    vault::remove_from_vault(node_id)
}

/// Undo a `remove_from_vault` from the descriptor it returned (vault source only).
pub async fn restore_from_vault(desc: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    vault::restore_from_vault(desc)
}

/// Retrieval across the included set: vault files plus any cloud connector's
/// mirrored content, ranked together in the source-agnostic engine.
/// Attachment-scoped queries skip cloud mirroring (attachments are vault files).
pub async fn retrieve(
    query: &str,
    included_file_ids: &[String],
    attachment_ids: &[String],
    k: usize,
    is_cloud: bool,
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
    // Node's event loop here — this is the structural fix). `is_cloud` narrows
    // the candidate set to the shareable one inside `vault::retrieve`.
    tokio::task::spawn_blocking(move || vault::retrieve(&query, &ids, k, &external, &attachments, is_cloud))
        .await
        .unwrap_or(Retrieved {
            references: vec![],
            contexts: vec![],
        })
}

/// Read-only inspection of a single file ("What the AI sees"): what the engine
/// has extracted, chunked, catalogued, and indexed for it, plus an optional
/// bounded, file-scoped test-search. Like local-only marks, this is keyed by
/// node id and served by the vault/inspect engine regardless of the owning
/// source. Runs on a blocking thread — it is synchronous CPU+disk work (the same
/// reason `retrieve` above spawns_blocking). PURE READ: no setter is reachable.
pub async fn inspect(file_id: &str, query: Option<&str>) -> crate::inspect::FileInspection {
    let file_id = file_id.to_string();
    let query = query.map(str::to_string);
    tokio::task::spawn_blocking(move || crate::inspect::inspect(&file_id, query.as_deref()))
        .await
        .unwrap_or_default()
}
