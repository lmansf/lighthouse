//! "What the AI sees" — a read-only, per-file inspector (openspec:
//! add-file-inspector).
//!
//! `inspect(conversation_id, file_id, query)` assembles, for one ATTACHMENT,
//! exactly what the engine has extracted, chunked, catalogued, and indexed for
//! it — plus a bounded, file-scoped test-search that reuses the EXISTING
//! retrieval scorer. It is a PURE READ: it resolves the attachment and calls
//! doc_text / the column catalog / the index (peek only) / retrieve — never a
//! writer. Since 0.15.0 the panel it feeds surfaces no toggles at all, so
//! inspecting cannot change anything the ask will later see.
//!
//! The TS twin (src/server/inspect.ts) mirrors the SHARED fields and omits the
//! Rust-engine-only ones (fromOcr, the persisted chunk count, the column
//! catalog, the persisted last-indexed key + freshness) — see docs/ts-twin.md.

use serde::Serialize;

use crate::catalog::Column;

/// One test-search result: a chunk's text (bounded) and its retrieval score.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectHit {
    pub text: String,
    pub score: f64,
}

/// A bounded, parsed preview of a delimited (CSV/TSV) file: the header row and
/// the first few data rows, columns capped — a glance at the table's SHAPE, not
/// the whole file. Shared field (CSV/TSV parse in pure JS too, so the TS twin
/// fills it identically) — KEEP IN SYNC with `PreviewTable` in
/// src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTable {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// True when the file has more rows or columns than shown — the preview is a
    /// glance, never a claim of completeness.
    pub truncated: bool,
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
    /// A bounded slice of the extracted text the model would read. None when the
    /// file has no extractable text (it stays findable by name only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_preview: Option<String>,
    /// For a CSV/TSV file, a tiny parsed table preview — header + first rows,
    /// columns capped — so the panel shows the table's shape, not just a raw
    /// text slice. Shared field; None for non-delimited files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_table: Option<PreviewTable>,
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
}

/// Preview slice cap — a glance at the extracted text, not the whole document.
const PREVIEW_CHARS: usize = 600;
/// CSV/TSV parsed-preview bounds — a glance at the table's shape, not the file.
const PREVIEW_TABLE_ROWS: usize = 5;
const PREVIEW_TABLE_COLS: usize = 8;
/// A larger head than the prose preview so the parsed rows aren't clipped mid-
/// table (PREVIEW_CHARS can cut inside the first data row of a wide sheet).
const PREVIEW_TABLE_CHARS: usize = 2000;
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

/// Parse the head of a delimited file into a bounded (header, rows) preview.
/// Pure and cheap — the SAME logic the TS twin runs, so the field is byte-shaped
/// alike across engines. `truncated` reflects a source longer than the slice, a
/// row beyond the cap, or more columns than the cap — never a completeness
/// claim. None when there isn't at least a 2-column header plus one data row.
fn parse_preview_table(text: &str, delim: char) -> Option<PreviewTable> {
    // The bounded slice may end mid-line; keep only whole lines so a partial
    // trailing row never shows (the caller still flags `truncated`).
    let source_truncated = text.len() >= PREVIEW_TABLE_CHARS;
    let mut whole: Vec<&str> = text.lines().collect();
    if source_truncated && whole.len() > 1 {
        whole.pop();
    }
    let mut lines = whole.into_iter().filter(|l| !l.trim().is_empty());
    let split = |line: &str| -> Vec<String> {
        line.split(delim)
            .take(PREVIEW_TABLE_COLS)
            .map(|c| c.trim().to_string())
            .collect()
    };
    let header_line = lines.next()?;
    let header = split(header_line);
    if header.len() < 2 {
        return None;
    }
    let width = header.len();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut more_rows = false;
    for line in lines {
        if rows.len() >= PREVIEW_TABLE_ROWS {
            more_rows = true;
            break;
        }
        let mut cells = split(line);
        cells.resize(width, String::new()); // align every row to header width
        rows.push(cells);
    }
    if rows.is_empty() {
        return None;
    }
    let wide = header_line.split(delim).count() > PREVIEW_TABLE_COLS;
    Some(PreviewTable {
        header,
        rows,
        truncated: source_truncated || more_rows || wide,
    })
}

/// Read-only inspection of one ATTACHMENT. When `query` is non-empty it ALSO
/// runs the bounded, file-scoped test-search. Never mutates anything.
///
/// Since 0.15.0 the subject is a conversation's attachment rather than a vault
/// node, so the inclusion / local-only fields — and the rule ATTRIBUTION behind
/// them — are gone: attaching is the whole decision, and there is no rule layer
/// left to explain. Everything else the panel shows (the extract preview, the
/// chunking, the column catalog, the index peek, the test-search) is unchanged.
pub fn inspect(conversation_id: &str, file_id: &str, query: Option<&str>) -> FileInspection {
    let Some((name, abs)) = crate::workspace::resolve(conversation_id, file_id) else {
        // Unknown / detached id: nothing to inspect (every field stays absent).
        return FileInspection::default();
    };
    let ext = ext_of(&name);
    let abs = Some(abs);
    let tabular = crate::analytics::is_tabular(&name);

    let mut out = FileInspection {
        name: Some(name.clone()),
        chunk_mode: Some(if tabular { "tabular" } else { "prose" }.to_string()),
        ..Default::default()
    };

    // Extract preview — the bounded slice of text the model would read.
    let preview = crate::workspace::doc_text(conversation_id, file_id, Some(PREVIEW_CHARS))
        .map(|(_, text)| text);
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

    // CSV/TSV also get a small parsed table preview (header + first rows) so the
    // panel shows the table's SHAPE, not just a raw text slice. A pure parse of a
    // bounded head — shared with the TS twin. Non-delimited tabular files (xlsx)
    // keep the text preview only (their doc_text is extracted text, not raw rows).
    if ext == ".csv" || ext == ".tsv" {
        let delim = if ext == ".tsv" { '\t' } else { ',' };
        if let Some((_, text)) =
            crate::workspace::doc_text(conversation_id, file_id, Some(PREVIEW_TABLE_CHARS))
        {
            out.preview_table = parse_preview_table(&text, delim);
        }
    }

    // File-scoped test-search — the EXISTING retrieval scorer over ONLY this file
    // id, on the device path (a local preview, never sent to a provider, so
    // local-only files stay searchable here). `contexts` are all top chunks of
    // the one file, so this returns that file's top chunks with scores.
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        let ids = [file_id.to_string()];
        let retrieved = crate::workspace::retrieve(conversation_id, q, &ids, TEST_SEARCH_K, &[]);
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
