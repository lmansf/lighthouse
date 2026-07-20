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
    /// Whether OCR can run in THIS engine right now, and why not when it can't
    /// (iOS field patch 3 §1 — makes a build whose models never shipped
    /// diagnosable from the inspector instead of silently name-only):
    /// "ready" | "off" | "missing-models" (`ocr::availability`). Present only
    /// for files OCR could apply to (images + PDFs) so inspecting a .txt never
    /// loads the models. PARITY: the TS twin fills the same field with its own
    /// honest constant "unsupported" (it has no OCR at all).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_availability: Option<String>,
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
    // OCR availability (fp3 §1) — only for files OCR could ever touch, so a
    // plain-text inspect never pays the one-time model load probe.
    if crate::extract::ocr_could_apply(&ext) {
        out.ocr_availability = Some(crate::ocr::availability().to_string());
    }

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
        let retrieved = crate::vault::retrieve(q, &ids, TEST_SEARCH_K, &[], &[], false, &[]);
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

// --- View inspection (openspec: add-shaped-views §4) --------------------------------
//
// The view analog of `inspect`: "Inspector on a view" (design.md). Everything
// here is STORED STATE plus the same vault lookups the rest of the engine uses
// (source display names via `vault::doc_path`, saved ages via
// `analytics::saved_age_label`) — NO SQL executes, so the TS twin
// (src/server/views.ts::inspectView) mirrors it byte-for-byte. A view carries
// no persistent index / column catalog / OCR, so — unlike `FileInspection` —
// there are no Rust-only fields: the two engines fill in the identical shape.

/// One source file a view reads, resolved for the inspector: its display name
/// and how fresh the on-disk copy is (the freshness the requirement asks for,
/// via the SAME `saved_age_label` the analytics footer uses). A file the id no
/// longer resolves to is reported honestly with `missing` (design.md "Failure
/// & degradation": the inspector shows the missing source rather than hiding
/// it). KEEP IN SYNC with the `ViewSource` shape in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSource {
    pub file_id: String,
    /// Display name when the id resolves; the pinned table-name binding as a
    /// last-resort label when the file is missing (so the row still names
    /// something recognizable).
    pub name: String,
    /// Saved-age label ("2 hours ago") from the file's mtime — the freshness
    /// derived from the source's saved time. Absent when the file is
    /// missing/unreadable (there is no honest age to show).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_age: Option<String>,
    /// The file id no longer resolves in the vault (removed/moved). Present
    /// (and true) only then — a live source omits it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
}

/// A read-only inspection of a saved VIEW (openspec: add-shaped-views §4). Like
/// `FileInspection`, every field is optional so an unknown/removed id returns a
/// default/empty inspection (the FileInspection precedent). All values are
/// stored state or vault lookups — no execution — so the TS twin computes the
/// identical shape. KEEP IN SYNC with `ViewInspection` in src/contracts/types.ts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewInspection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The exact stored definition SQL — the SELECT the engine re-guards and
    /// runs at ask time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// The one-line summary text (may be empty — a model-shaped view can carry
    /// none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Where the summary came from — `"question"` (Save-as-view on a Beam
    /// answer) or `"model"` (a shaping ask): the provenance label the inspector
    /// shows beside the summary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_source: Option<String>,
    /// Every source FILE this view reads, TRANSITIVELY (through `reads.views`),
    /// so the user sees every file underneath — display names + saved ages,
    /// deduped in reads order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<ViewSource>>,
    /// The names of the views this one reads DIRECTLY (provenance completeness —
    /// the stack above the files).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reads_views: Option<Vec<String>>,
    /// Effectively local-only: any transitive source file carries a local-only
    /// mark (`views::view_effectively_local_only`) — the inspector's private
    /// badge, and why the view is excluded from cloud asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    /// DIRECT dependent view names — what the rename warning shows (rename is
    /// refused while any exist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependents: Option<Vec<String>>,
    /// TRANSITIVE dependent view names — what the delete/cascade confirmation
    /// shows (the whole downstream set a cascade would remove).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transitive_dependents: Option<Vec<String>>,
    /// Creation instant (epoch ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_ms: Option<i64>,
}

/// This view's transitive source-file bindings: its own `reads.files`, then
/// every parent view's, deduped by file id in reads order (the exact
/// accumulation `analytics::register_views` does). Cycle-tolerant on synthetic
/// graphs via the `seen` set.
fn collect_transitive_files(
    v: &crate::views::View,
    records: &[crate::views::View],
    out: &mut Vec<crate::views::FileRead>,
    seen: &mut Vec<String>,
) {
    for f in &v.reads.files {
        if !out.iter().any(|k| k.file_id == f.file_id) {
            out.push(f.clone());
        }
    }
    for pid in &v.reads.views {
        if seen.iter().any(|s| s == pid) {
            continue;
        }
        seen.push(pid.clone());
        if let Some(parent) = records.iter().find(|r| r.id == *pid) {
            collect_transitive_files(parent, records, out, seen);
        }
    }
}

/// Read-only inspection of a saved view by id. Unknown/removed id → a default
/// (empty) `ViewInspection`, mirroring `inspect`'s precedent for unknown file
/// ids. Never executes SQL and never mutates state.
pub fn inspect_view(view_id: &str) -> ViewInspection {
    let records = crate::views::list();
    let Some(v) = records.iter().find(|r| r.id == view_id) else {
        return ViewInspection::default();
    };

    // Transitive source files → display names + saved ages (freshness).
    let mut file_reads: Vec<crate::views::FileRead> = Vec::new();
    collect_transitive_files(v, &records, &mut file_reads, &mut vec![v.id.clone()]);
    let now = crate::config::now_ms();
    let sources: Vec<ViewSource> = file_reads
        .iter()
        .map(|f| match crate::vault::doc_path(&f.file_id) {
            // The SAME per-id lookup run_direct/register_views use; freshness is
            // the source's on-disk mtime through the analytics saved-age label.
            Some((name, abs)) => {
                let saved_age = std::fs::metadata(&abs)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| crate::analytics::saved_age_label(d.as_millis() as i64, now));
                ViewSource {
                    file_id: f.file_id.clone(),
                    name,
                    saved_age,
                    missing: None,
                }
            }
            None => ViewSource {
                file_id: f.file_id.clone(),
                name: f.table_name.clone(),
                saved_age: None,
                missing: Some(true),
            },
        })
        .collect();

    // Reads-views ids → names (drop any id that no longer resolves).
    let reads_views: Vec<String> = v
        .reads
        .views
        .iter()
        .filter_map(|id| records.iter().find(|r| r.id == *id).map(|r| r.name.clone()))
        .collect();

    let summary_source = match v.summary.source {
        crate::views::SummarySource::Question => "question",
        crate::views::SummarySource::Model => "model",
    };

    ViewInspection {
        id: Some(v.id.clone()),
        name: Some(v.name.clone()),
        sql: Some(v.sql.clone()),
        summary: Some(v.summary.text.clone()),
        summary_source: Some(summary_source.to_string()),
        sources: Some(sources),
        reads_views: Some(reads_views),
        local_only: Some(crate::views::view_effectively_local_only(v, &records)),
        dependents: Some(
            crate::views::dependents_in(&records, view_id)
                .into_iter()
                .map(|d| d.name)
                .collect(),
        ),
        transitive_dependents: Some(
            crate::views::transitive_dependents_in(&records, view_id)
                .into_iter()
                .map(|d| d.name)
                .collect(),
        ),
        created_ms: Some(v.created_ms),
    }
}
