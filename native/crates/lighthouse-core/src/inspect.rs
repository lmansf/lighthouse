//! "What the AI sees" — a read-only, per-file inspector (openspec:
//! add-file-inspector).
//!
//! `inspect(file_id, query)` assembles, for one vault file, exactly what the
//! engine has extracted, chunked, catalogued, and indexed for it — plus a
//! bounded, file-scoped test-search that reuses the EXISTING retrieval scorer.
//! It is a PURE READ: it calls list_nodes / doc_text / the column catalog / the
//! index (peek only) / retrieve — never a setter (no set_included,
//! set_local_only, save_state, or vault write). The only state the panel it
//! feeds can change are the inclusion + local-only toggles it merely surfaces.
//!
//! The TS twin (src/server/inspect.ts) mirrors the SHARED fields and omits the
//! Rust-engine-only ones (fromOcr, the persisted chunk count, the column
//! catalog, the persisted last-indexed key + freshness) — see docs/ts-twin.md.

use serde::Serialize;

use crate::catalog::Column;
use crate::contracts::NodeKind;

/// One test-search result: a chunk's text (bounded) and its retrieval score.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectHit {
    pub text: String,
    pub score: f64,
}

/// A read-only view of what the engine holds for one file. All fields are
/// optional so the TS twin can omit what it cannot compute (never a fake
/// value). KEEP IN SYNC with the `FileInspection` shape in
/// src/contracts/types.ts (shared fields) — the twin drops the Rust-only ones.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Effective AI-visibility (included in retrieval).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included: Option<bool>,
    /// Effective "Private — this device only" (ancestor-wins).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    /// A bounded slice of the extracted text the model would read. None when the
    /// file has no extractable text (it stays findable by name only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_preview: Option<String>,
    /// Rust-only (OCR is a Rust-engine capability): the preview text came from
    /// OCR (an image, or a scanned-PDF fallback). PARITY: the TS twin omits it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_ocr: Option<bool>,
    /// `tabular` (row-windows) vs `prose` (word-windows). Shared — the chunker
    /// is parity-pinned across the twins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_mode: Option<String>,
    /// Rust-only (persistent index): the file's chunk count as the index holds
    /// it. PARITY: the TS twin re-chunks per query and persists no count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<usize>,
    /// Rust-only (column catalog): detected columns + kinds for a tabular file.
    /// PARITY: the TS twin omits the catalog inventory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<Column>>,
    /// Rust-only (persistent index + watcher): the index freshness key
    /// (`mtimeMs:size`). PARITY: the TS twin persists no last-indexed time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_at: Option<String>,
    /// Rust-only: whether `indexed_at` still matches the file on disk right now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh: Option<bool>,
    /// Present only when a test-search query was supplied: the file's top chunks
    /// for that query with scores, scoped to this one file. Shared field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_search: Option<Vec<InspectHit>>,
    /// WHY the effective inclusion is what it is (openspec: add-curation-rules):
    /// which layer decided — the node's own explicit flag, an ancestor's, a
    /// curation rule (named, e.g. "spreadsheets in /reports"), or the global
    /// default. Shared field — the TS twin computes it with full fidelity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included_by: Option<crate::vault::FlagAttribution>,
    /// The local-only analog of `included_by`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_only_by: Option<crate::vault::FlagAttribution>,
}

/// Preview slice cap — a glance at the extracted text, not the whole document.
const PREVIEW_CHARS: usize = 600;
/// Test-search top-K (bounded — the panel is a glance, not a full search UI).
const TEST_SEARCH_K: usize = 5;
/// Per-hit text cap (matches the retrieval snippet cap).
const HIT_CHARS: usize = 240;

/// The file extension including the dot, lowercased ("" when the name has none).
fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{}", ext.to_lowercase()),
        _ => String::new(),
    }
}

/// Read-only inspection of `file_id`. When `query` is non-empty it ALSO runs the
/// bounded, file-scoped test-search. Never mutates vault state.
pub fn inspect(file_id: &str, query: Option<&str>) -> FileInspection {
    // Name + effective inclusion + local-only come from the SAME painted walk the
    // explorer renders, so the panel's labels match the file's row exactly.
    let node = crate::vault::list_nodes()
        .into_iter()
        .find(|n| n.kind == NodeKind::File && n.id == file_id);
    let Some(node) = node else {
        // Unknown / removed id: nothing to inspect (every field stays absent).
        return FileInspection::default();
    };
    let name = node.name.clone();
    let ext = ext_of(&name);
    let abs = crate::vault::resolve_node_path(file_id).ok();
    let tabular = crate::analytics::is_tabular(&name);

    let mut out = FileInspection {
        name: Some(name.clone()),
        included: Some(node.rag_included),
        local_only: Some(node.local_only),
        chunk_mode: Some(if tabular { "tabular" } else { "prose" }.to_string()),
        // Attribution ("included by rule 'spreadsheets in /reports'") — the
        // same decision layer the walk above resolved, reported as WHY.
        included_by: Some(crate::vault::inclusion_attribution(file_id)),
        local_only_by: Some(crate::vault::local_only_attribution(file_id)),
        ..Default::default()
    };

    // Extract preview — the bounded slice of text the model would read.
    let preview = crate::vault::doc_text(file_id, Some(PREVIEW_CHARS)).map(|(_, text)| text);
    // fromOcr only matters when there IS text to flag; gate the (PDF-reparsing)
    // derivation on a real preview so a name-only file pays nothing.
    out.from_ocr = Some(match (&preview, &abs) {
        (Some(_), Some(abs)) => crate::extract::text_is_ocr_derived(abs, &ext),
        _ => false,
    });
    out.extract_preview = preview;

    // Chunk count + last-indexed key + freshness — a PEEK at the persistent
    // index (no rebuild, so a stale entry stays observably stale, which is the
    // point the freshness field reports).
    if let Some(peek) = crate::index::peek_entry(file_id, abs.as_deref()) {
        out.chunk_count = Some(peek.chunk_count);
        out.indexed_at = Some(peek.key);
        out.fresh = Some(peek.fresh);
    }

    // Columns + kinds for a tabular file (the catalog reads only header + a
    // bounded row sample, cache-first; an unreadable file yields none).
    if tabular {
        if let Some(abs) = &abs {
            let cols =
                crate::catalog::columns_for(&[(file_id.to_string(), name.clone(), abs.clone())]);
            if let Some(fc) = cols.into_iter().next() {
                out.columns = Some(fc.columns);
            }
        }
    }

    // File-scoped test-search — the EXISTING retrieval scorer over ONLY this file
    // id, on the device path (a local preview, never sent to a provider, so
    // local-only files stay searchable here). `contexts` are all top chunks of
    // the one file, so this returns that file's top chunks with scores.
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        let ids = [file_id.to_string()];
        let retrieved = crate::vault::retrieve(q, &ids, TEST_SEARCH_K, &[], &[], false);
        out.test_search = Some(
            retrieved
                .contexts
                .into_iter()
                .map(|c| InspectHit {
                    text: c.text.chars().take(HIT_CHARS).collect(),
                    score: c.score,
                })
                .collect(),
        );
    }

    out
}
