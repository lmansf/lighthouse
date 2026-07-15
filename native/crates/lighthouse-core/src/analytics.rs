//! Ask-your-data analytics (docs/analytics-genie.md, Phase A).
//!
//! The model writes SQL; DataFusion executes it; the model narrates the
//! verified result. The model never sees file contents here — only schemas and
//! a few sample rows — and never does arithmetic: every number in the answer
//! comes out of the engine. Everything is in-process (no network paths).
//!
//! Desktop-first by design: this module has no TS twin — the web dev server's
//! pipeline simply never takes the analytics branch.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::contracts::ChatTurn;
use datafusion::arrow::array::{ArrayRef, Float64Array, StringArray};
use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::arrow::util::display::array_value_to_string;
use datafusion::datasource::MemTable;
use datafusion::prelude::{CsvReadOptions, ParquetReadOptions, SessionContext};
use sha1::{Digest, Sha1};

/// Budgets — conservative caps so one query can't stall or flood an answer.
pub const MAX_TABLE_FILES: usize = 4;
/// Candidates gathered BEFORE grouping — wide enough that a 12-file monthly
/// family is seen whole; slots (groups count once) still bound registration.
pub const CANDIDATE_SCAN: usize = 64;
const MAX_SHEETS_PER_BOOK: usize = 4;
/// Tables registered across ALL files: 4 workbooks × 4 sheets would otherwise
/// put 16 schema cards in the SQL prompt — a field report had the local
/// model's whole 6144-token window blown by exactly this class of overflow.
const MAX_TABLES_TOTAL: usize = 6;
const MAX_XLSX_ROWS: usize = 100_000;
const MAX_XLSX_COLS: usize = 64;
/// A PDF larger than this is not reconstructed for analytics — the text-layer
/// glyph pass is bounded, but a huge file shouldn't stall an ask.
const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;
const QUERY_TIMEOUT_SECS: u64 = 10;
const MAX_RESULT_ROWS: usize = 200;
const MAX_RESULT_COLS: usize = 24;
const MAX_CELL_CHARS: usize = 80;
const SAMPLE_ROWS: usize = 3;
/// Per schema card (prompt block), chars. Wide sheets get their sample rows
/// clipped rather than eating the context window.
const MAX_CARD_CHARS: usize = 1200;
/// The narration prompt sees at most this much of the result — enough to
/// answer and quote from; the 200-row execution cap is for correctness
/// semantics, not for stuffing the model's context.
const NARRATE_MAX_ROWS: usize = 40;
const NARRATE_MAX_CHARS: usize = 6000;

// --- Intent ----------------------------------------------------------------------

const CUE_WORDS: &[&str] = &[
    "sum",
    "total",
    "totals",
    "average",
    "avg",
    "mean",
    "median",
    "count",
    "top",
    "largest",
    "smallest",
    "highest",
    "lowest",
    "max",
    "maximum",
    "min",
    "minimum",
    "trend",
    "trends",
    "breakdown",
    "distribution",
    "percent",
    "percentage",
    "share",
    "ratio",
    "rank",
    "ranking",
    "monthly",
    "yearly",
    "quarterly",
    "analyze",
    "analyse",
    "analysis",
];
const CUE_PHRASES: &[&str] = &["how many", "how much", "group by", "per "];

/// Whether a question reads as an aggregate/analytics ask. Pure; unit-tested.
/// (Deliberately conservative — everything else keeps its existing path.)
pub fn analytics_cue(question: &str) -> bool {
    let lower = question.to_lowercase();
    let mut norm = String::with_capacity(lower.len());
    let mut last_space = true;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            norm.push(ch);
            last_space = false;
        } else if !last_space {
            norm.push(' ');
            last_space = true;
        }
    }
    let padded = format!(" {} ", norm.trim());
    for p in CUE_PHRASES {
        if padded.contains(&format!(" {p}")) {
            return true;
        }
    }
    padded.split(' ').any(|t| CUE_WORDS.contains(&t))
}

/// File kinds the engine can register as tables.
pub fn is_tabular(name: &str) -> bool {
    let n = name.to_lowercase();
    // .xlsm is a macro-enabled workbook — same OOXML format as .xlsx, so it
    // reads and queries identically. It MUST stay in step with meta.rs's
    // `kind_label` spreadsheet set, or "which files have column X" contradicts
    // "what spreadsheets do I have".
    [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"]
        .iter()
        .any(|e| n.ends_with(e))
}

/// A PDF whose confident text-layer grids can be reconstructed and registered as
/// tables (openspec: add-queryable-pdf-tables). Deliberately SEPARATE from
/// `is_tabular`: that gate also drives catalog profiling, union grouping,
/// spreadsheet meta answers ("which spreadsheets do I have"), and — critically —
/// tabular CHUNKING (`vault::chunk_texts_named`). A PDF must stay on prose
/// chunking and out of the spreadsheet story, so it gets a registration-only
/// gate. PARITY: Rust-only, like the rest of analytics.
pub fn is_pdf(name: &str) -> bool {
    name.to_lowercase().ends_with(".pdf")
}

/// Lowercased stem, non-alphanumerics folded to `_`, digit-safe, deduped by
/// the caller. "Q3 Sales (final).xlsx" → "q3_sales_final". Shared with the
/// column catalog so cataloged names match SQL names exactly.
pub(crate) fn sanitize_table_name(file_name: &str) -> String {
    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(file_name)
        .to_lowercase();
    let mut out = String::with_capacity(stem.len());
    let mut last_us = true; // also trims leading underscores
    for ch in stem.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    let out = out.trim_end_matches('_').to_string();
    let out = if out.is_empty() {
        "table".to_string()
    } else {
        out
    };
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("t_{out}")
    } else {
        out
    }
}

// --- Registration ----------------------------------------------------------------

/// Provenance of a table unioned from a same-shaped file family.
#[derive(Debug, Clone)]
pub struct GroupMeta {
    pub file_ids: Vec<String>,
    pub file_names: Vec<String>,
    pub newest_ms: i64,
}

/// One registered table and the description the model plans against.
#[derive(Debug, Clone)]
pub struct TableReg {
    pub table: String,
    pub file_id: String,
    pub file_name: String,
    /// "col TYPE, col TYPE, …" + row count + sample rows, ready for a prompt block.
    pub card: String,
    /// The file's on-disk mtime (epoch ms) when it was registered — i.e. the
    /// version of the data this ask reads. None if the stat failed.
    pub modified_ms: Option<i64>,
    /// Lowercased column names, for deterministic join hints.
    pub columns: Vec<String>,
    /// Present when this table unions a file family; file_id/file_name then
    /// describe the family (first member id, pattern-style label).
    pub group: Option<GroupMeta>,
}

/// A same-shaped file family destined for one unioned table.
#[derive(Debug, Clone)]
pub(crate) struct UnionGroup {
    pub stem: String,
    pub ext: String,
    /// (file_id, name, abs), newest first, capped at MAX_GROUP_FILES.
    pub members: Vec<(String, String, PathBuf)>,
}

/// Members per unioned family — bounds one ask's registration work.
const MAX_GROUP_FILES: usize = 48;

/// Name stem with digit runs (and their surrounding separators) collapsed:
/// "sales-2025-01.csv" → "sales", "q3_sales" → "q_sales".
pub(crate) fn union_stem(name: &str) -> String {
    let stem = name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(name)
        .to_lowercase();
    let mut out = String::new();
    let mut last_sep = false;
    for ch in stem.chars() {
        if ch.is_ascii_digit() {
            continue;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_sep = false;
        } else if !last_sep && !out.is_empty() {
            out.push('_');
            last_sep = true;
        } else {
            last_sep = true;
        }
    }
    out.trim_matches('_').to_string()
}

/// Split candidates into unionable families and singles. Grouping needs BOTH
/// a shared digit-stripped stem and an identical cataloged column signature —
/// same-shaped but unrelated files must not silently merge, and renamed
/// columns split a family rather than misaligning rows.
pub(crate) fn union_groups(
    files: &[(String, String, PathBuf)],
    catalog: &[crate::catalog::FileColumns],
) -> (Vec<UnionGroup>, Vec<(String, String, PathBuf)>) {
    use std::collections::HashMap;
    // Signature = ordered (name:kind) pairs. Folding the cataloged column KIND
    // in means same-named columns that differ in type (one file's "value" is
    // text, another's numeric) split into separate families instead of unioning
    // into a schema-incoherent table whose aggregates are nonsense.
    let signatures: HashMap<&str, Vec<String>> = catalog
        .iter()
        .map(|fc| {
            (
                fc.id.as_str(),
                fc.columns
                    .iter()
                    .map(|c| format!("{}:{:?}", c.name, c.kind))
                    .collect(),
            )
        })
        .collect();
    let mtimes: HashMap<&str, i64> = catalog
        .iter()
        .map(|fc| (fc.id.as_str(), fc.modified_ms))
        .collect();

    let mut buckets: HashMap<(String, String, Vec<String>), Vec<(String, String, PathBuf)>> =
        HashMap::new();
    let mut singles: Vec<(String, String, PathBuf)> = Vec::new();
    let mut order: Vec<(String, String, Vec<String>)> = Vec::new();
    for f in files {
        let (id, name, _) = f;
        let Some(sig) = signatures.get(id.as_str()) else {
            singles.push(f.clone());
            continue;
        };
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_lowercase())
            .unwrap_or_default();
        let key = (ext, union_stem(name), sig.clone());
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push(f.clone());
    }

    let mut groups = Vec::new();
    for key in order {
        let mut members = buckets.remove(&key).unwrap_or_default();
        // Stem must be a real token (≥2 chars): a single-letter stem like "q"
        // (from q1.csv/q2.csv) collapses unrelated files, so those stay singles.
        if members.len() < 2 || key.1.chars().count() < 2 {
            singles.extend(members);
            continue;
        }
        members.sort_by_key(|(id, _, _)| -mtimes.get(id.as_str()).copied().unwrap_or(0));
        members.truncate(MAX_GROUP_FILES);
        groups.push(UnionGroup {
            stem: key.1,
            ext: key.0,
            members,
        });
    }
    (groups, singles)
}

/// A table name not already in `used`: the base, else base_2, base_3, … until
/// free. A single `base_{used.len()+1}` guess can equal a name already
/// registered from another file (e.g. a real `foo_3.csv`), and DataFusion's
/// `register_*` replaces silently — so the guess could overwrite a live table
/// and leave two cards pointing at one. Looping to an actually-unused suffix
/// closes that.
fn unique_table_name(base: &str, used: &[String]) -> String {
    if !used.iter().any(|u| u == base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let cand = format!("{base}_{n}");
        if !used.iter().any(|u| u == &cand) {
            return cand;
        }
        n += 1;
    }
}

/// Register every supported file into one context (multi-file joins come
/// free). Same-shaped file families union into one table; failures degrade to
/// per-file registration. Unreadable/mis-shaped files are skipped — never
/// fatal.
pub async fn register_tables(
    ctx: &SessionContext,
    files: &[(String, String, PathBuf)], // (file_id, name, abs)
) -> Vec<TableReg> {
    // A cold catalog pass parses headers+samples for up to CANDIDATE_SCAN
    // workbooks — blocking work that must not stall the runtime thread.
    let files_owned = files.to_vec();
    let catalog = tokio::task::spawn_blocking(move || crate::catalog::columns_for(&files_owned))
        .await
        .unwrap_or_default();
    let (groups, mut singles) = union_groups(files, &catalog);

    let mut regs: Vec<TableReg> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    // A group consumes ONE file slot regardless of member count.
    let mut slots = 0usize;
    for g in groups {
        if slots >= MAX_TABLE_FILES || regs.len() >= MAX_TABLES_TOTAL {
            // Out of room — members may still compete as singles below.
            singles.extend(g.members);
            continue;
        }
        match register_group(ctx, &g, &mut used).await {
            Some(reg) => {
                regs.push(reg);
                slots += 1;
            }
            None => {
                // Union failed (reader quirk, drifted file) — the newest
                // members fall back to ordinary per-file registration.
                singles.extend(g.members);
            }
        }
    }

    // Keep the NEWEST files when the table caps bite: singles register in this
    // order and the loop stops at the cap, so leaving walk-order (arbitrary) to
    // decide which files the analysis sees would drop recent data at random.
    singles.sort_by_key(|(_, _, abs)| std::cmp::Reverse(file_mtime_ms(abs).unwrap_or(0)));
    for (file_id, name, abs) in singles {
        if slots >= MAX_TABLE_FILES || regs.len() >= MAX_TABLES_TOTAL {
            break;
        }
        let lower = name.to_lowercase();
        let base = unique_table_name(&sanitize_table_name(&name), &used);
        let modified_ms = file_mtime_ms(&abs);
        let path = abs.to_string_lossy().to_string();
        let registered: Vec<String> = if lower.ends_with(".csv") || lower.ends_with(".tsv") {
            let delim = if lower.ends_with(".tsv") { b'\t' } else { b',' };
            let opts = CsvReadOptions::new().delimiter(delim);
            match ctx.register_csv(&base, &path, opts).await {
                Ok(()) => vec![base.clone()],
                Err(_) => vec![],
            }
        } else if lower.ends_with(".parquet") {
            match ctx
                .register_parquet(&base, &path, ParquetReadOptions::default())
                .await
            {
                Ok(()) => vec![base.clone()],
                Err(_) => vec![],
            }
        } else if is_pdf(&lower) {
            register_pdf(ctx, &base, &abs).await
        } else {
            register_workbook(ctx, &base, &abs)
        };
        let mut any = false;
        for table in registered {
            if regs.len() >= MAX_TABLES_TOTAL {
                break;
            }
            if let Some((card, columns)) = table_card(ctx, &table).await {
                used.push(base.clone());
                any = true;
                regs.push(TableReg {
                    table: table.clone(),
                    file_id: file_id.clone(),
                    file_name: name.clone(),
                    card,
                    modified_ms,
                    columns,
                    group: None,
                });
            }
        }
        if any {
            slots += 1;
        }
    }
    regs
}

/// How many of the input tabular files are NOT represented in any registered
/// table — dropped by the per-ask table caps (MAX_TABLE_FILES / MAX_TABLES_
/// TOTAL) or unreadable. Drives an honest "analyzed N of M files" disclosure so
/// an analysis over a fraction of the vault's tables never reads as complete.
pub fn unregistered_count(files: &[(String, String, PathBuf)], regs: &[TableReg]) -> usize {
    use std::collections::HashSet;
    let mut represented: HashSet<&str> = HashSet::new();
    for r in regs {
        match &r.group {
            Some(g) => represented.extend(g.file_ids.iter().map(|s| s.as_str())),
            None => {
                represented.insert(r.file_id.as_str());
            }
        }
    }
    files
        .iter()
        .filter(|(id, name, _)| is_tabular(name) && !represented.contains(id.as_str()))
        .count()
}

/// Register one unioned table for a file family. CSV/TSV/Parquet union via
/// DataFusion multi-path reads; workbooks concatenate row matrices and infer
/// column types ONCE over the combined rows so a column's type can't drift
/// between members. None ⇒ caller falls back to per-file registration.
async fn register_group(
    ctx: &SessionContext,
    g: &UnionGroup,
    used: &mut Vec<String>,
) -> Option<TableReg> {
    let tname = unique_table_name(
        &sanitize_table_name(&format!("{}_all", g.stem)),
        used.as_slice(),
    );
    let paths: Vec<String> = g
        .members
        .iter()
        .map(|(_, _, abs)| abs.to_string_lossy().to_string())
        .collect();

    // How many leading (newest-first) members the table actually covers —
    // the card, references, and freshness stamp must describe exactly these.
    let mut covered = g.members.len();
    let ok = match g.ext.as_str() {
        "csv" | "tsv" => {
            let delim = if g.ext == "tsv" { b'\t' } else { b',' };
            let opts = CsvReadOptions::new().delimiter(delim);
            match ctx.read_csv(paths.clone(), opts).await {
                Ok(df) => ctx.register_table(&tname, df.into_view()).is_ok(),
                Err(_) => false,
            }
        }
        "parquet" => match ctx
            .read_parquet(paths.clone(), ParquetReadOptions::default())
            .await
        {
            Ok(df) => ctx.register_table(&tname, df.into_view()).is_ok(),
            Err(_) => false,
        },
        "xlsx" | "xlsm" | "xls" => {
            // Whole-sheet parsing is blocking work — keep it off the runtime.
            let members = g.members.clone();
            let parsed = tokio::task::spawn_blocking(move || workbook_union_matrix(&members))
                .await
                .ok()
                .flatten();
            match parsed {
                Some((schema, batch, included)) => {
                    covered = included;
                    MemTable::try_new(schema, vec![vec![batch]])
                        .ok()
                        .map(|mem| ctx.register_table(&tname, Arc::new(mem)).is_ok())
                        .unwrap_or(false)
                }
                None => false,
            }
        }
        _ => false,
    };
    if !ok {
        return None;
    }

    let (card, columns) = table_card(ctx, &tname).await?;
    used.push(tname.clone());
    let members = &g.members[..covered];
    let omitted = g.members.len() - covered;
    let newest_ms = members
        .iter()
        .filter_map(|(_, _, abs)| file_mtime_ms(abs))
        .max()
        .unwrap_or(0);
    let names: Vec<String> = members.iter().map(|(_, n, _)| n.clone()).collect();
    let label = format!("{}*.{}", g.stem, g.ext);
    // The union provenance must survive card clipping — lead with it, and
    // never claim coverage the row cap didn't deliver.
    let card = format!(
        "{} unions {} files ({}{}){}\n{}",
        tname,
        members.len(),
        names.iter().take(3).cloned().collect::<Vec<_>>().join(", "),
        if names.len() > 3 { ", …" } else { "" },
        if omitted > 0 {
            format!(" — row cap: {omitted} older file(s) NOT included")
        } else {
            String::new()
        },
        card
    );
    Some(TableReg {
        table: tname,
        file_id: members[0].0.clone(),
        file_name: label,
        card,
        modified_ms: Some(newest_ms),
        columns,
        group: Some(GroupMeta {
            file_ids: members.iter().map(|(id, _, _)| id.clone()).collect(),
            file_names: names,
            newest_ms,
        }),
    })
}

/// Build the combined batch for a workbook family (first sheet per member,
/// detected headers, whole-member appends only). Returns the schema+batch and
/// how many LEADING members were fully included: a member whose rows would
/// cross MAX_XLSX_ROWS is omitted entirely — a partially-summed month would
/// silently skew every aggregate while the card claims full coverage, so the
/// cap drops whole (oldest-first) members and the caller reports the count.
/// Pure and blocking (calamine parses whole sheets) — call via spawn_blocking.
#[allow(clippy::type_complexity)]
fn workbook_union_matrix(
    members: &[(String, String, PathBuf)],
) -> Option<(Arc<Schema>, RecordBatch, usize)> {
    use calamine::Reader;
    let mut headers: Option<Vec<String>> = None;
    let mut data: Vec<Vec<String>> = Vec::new();
    let mut included = 0usize;
    for (_, _, abs) in members {
        let Ok(mut wb) = calamine::open_workbook_auto(abs) else {
            return None;
        };
        let Some(sheet) = wb.sheet_names().first().cloned() else {
            return None;
        };
        let Ok(range) = wb.worksheet_range(&sheet) else {
            return None;
        };
        let all: Vec<Vec<String>> = range
            .rows()
            .take(MAX_XLSX_ROWS + HEADER_SCAN_ROWS)
            .map(|r| r.iter().map(crate::extract::cell_text).collect())
            .collect();
        if all.is_empty() {
            return None;
        }
        let h = detect_header_row(&all);
        let hdr: Vec<String> = all[h]
            .iter()
            .take(MAX_XLSX_COLS)
            .enumerate()
            .map(|(i, c)| {
                let s = sanitize_table_name(c);
                if s.is_empty() || s == "table" {
                    format!("col_{}", i + 1)
                } else {
                    s
                }
            })
            .collect();
        match &headers {
            None => headers = Some(hdr),
            // The catalog signature already matched, but headers are re-read
            // here from the live file — a drift since cataloging bails out.
            Some(existing) if *existing != hdr => return None,
            _ => {}
        }
        let member_rows = all.len().saturating_sub(h + 1);
        if data.len() + member_rows > MAX_XLSX_ROWS {
            if included == 0 {
                // Even the first (newest) member alone exceeds the cap: no
                // honest union exists — fall back to per-file registration.
                return None;
            }
            break; // whole-member omission; caller reports the shortfall
        }
        let width = headers.as_ref().map(Vec::len).unwrap_or(0);
        for r in &all[h + 1..] {
            data.push(
                (0..width)
                    .map(|i| r.get(i).cloned().unwrap_or_default())
                    .collect(),
            );
        }
        included += 1;
    }
    let headers = headers?;
    if headers.len() < 2 || data.len() < 2 || included < 2 {
        return None;
    }
    let (schema, batch) = table_from_matrix(&headers, &data)?;
    Some((schema, batch, included))
}

/// How many leading rows are scanned for a plausible header.
const HEADER_SCAN_ROWS: usize = 8;

/// Pick the header row within the first HEADER_SCAN_ROWS rows. Real headers
/// are wide, textual, and distinct; title rows have one cell, units/data rows
/// are mostly numeric. A row qualifies with ≥2 non-empty cells that are mostly
/// non-numeric; the score (textual + distinct counts) must STRICTLY beat every
/// earlier qualifier to move the header down (ties → earliest). Nothing
/// qualifies ⇒ row 0, exactly the pre-detection behavior.
pub(crate) fn detect_header_row(rows: &[Vec<String>]) -> usize {
    // Score = (all_textual, textual_count), compared lexicographically with
    // earliest-wins ties. A FULLY-textual row is the strongest header signal,
    // so a later, partly-numeric DATA row can never displace an earlier
    // all-textual header — which used to happen when the header carried a blank
    // or duplicate cell (score = textual + distinct let a wider data row win),
    // silently promoting the first data row to the header and dropping a record.
    let mut best: Option<((usize, usize), usize)> = None;
    for (i, row) in rows.iter().take(HEADER_SCAN_ROWS).enumerate() {
        let non_empty: Vec<&str> = row
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if non_empty.len() < 2 {
            continue;
        }
        let textual = non_empty
            .iter()
            .filter(|s| s.parse::<f64>().is_err())
            .count();
        if textual * 2 < non_empty.len() {
            continue; // mostly numbers — a data row, not a header
        }
        let score = ((textual == non_empty.len()) as usize, textual);
        if best.map(|(s, _)| score > s).unwrap_or(true) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| i).unwrap_or(0)
}

/// Reconstruct a PDF's confident, header-carrying grids from its text layer and
/// register each as an Arrow MemTable — the PDF analogue of `register_workbook`
/// (openspec: add-queryable-pdf-tables). Text-layer only (no OCR/vision); a PDF
/// with no queryable grid registers nothing, so a prose PDF costs a bounded
/// parse and no slot. The glyph pass is blocking and panic-guarded inside
/// `pdf_tables`, so it runs on `spawn_blocking`; the MemTable build stays here so
/// `ctx` never crosses threads. PARITY: Rust-only.
async fn register_pdf(ctx: &SessionContext, base: &str, abs: &PathBuf) -> Vec<String> {
    match std::fs::metadata(abs) {
        Ok(m) if m.len() <= MAX_PDF_BYTES => {}
        _ => return vec![],
    }
    let path = abs.clone();
    let grids = tokio::task::spawn_blocking(move || {
        std::fs::read(&path)
            .map(|buf| crate::pdf_tables::queryable_tables(&buf))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    // Cap the grids per PDF exactly as `register_workbook` caps sheets per book:
    // a pathological many-page PDF must not materialize dozens of MemTables when
    // MAX_TABLES_TOTAL only ever cards a handful. Cap before deciding `multi` so
    // the naming reflects what is actually registered.
    let grids: Vec<_> = grids.into_iter().take(MAX_SHEETS_PER_BOOK).collect();
    let multi = grids.len() > 1;
    let mut out = Vec::new();
    for (i, grid) in grids.iter().enumerate() {
        let tname = if multi { format!("{base}__{}", i + 1) } else { base.to_string() };
        if let Some(name) = register_grid(ctx, &tname, grid) {
            out.push(name);
        }
    }
    out
}

/// Build one reconstructed grid into a typed Arrow MemTable and register it —
/// the header sanitize + `table_from_matrix` typing shared with `register_
/// workbook`, factored out so the typing path is unit-testable over a synthetic
/// `Table` without a real PDF (the glyph pass is tested separately). Returns the
/// registered name, or None when the grid is too thin to type.
fn register_grid(ctx: &SessionContext, tname: &str, grid: &crate::pdf_tables::Table) -> Option<String> {
    let header = grid.rows.first()?;
    // Header sanitize identical to register_workbook so PDF column names line up
    // with spreadsheet conventions.
    let headers: Vec<String> = header
        .iter()
        .take(MAX_XLSX_COLS)
        .enumerate()
        .map(|(j, c)| {
            let s = sanitize_table_name(c);
            if s.is_empty() || s == "table" {
                format!("col_{}", j + 1)
            } else {
                s
            }
        })
        .collect();
    if headers.len() < 2 {
        return None;
    }
    let data: Vec<Vec<String>> = grid.rows[1..]
        .iter()
        .map(|r| (0..headers.len()).map(|k| r.get(k).cloned().unwrap_or_default()).collect())
        .collect();
    if data.len() < 2 {
        return None;
    }
    let (schema, batch) = table_from_matrix(&headers, &data)?;
    let mem = MemTable::try_new(schema, vec![vec![batch]]).ok()?;
    ctx.register_table(tname, Arc::new(mem)).ok()?;
    Some(tname.to_string())
}

/// calamine → Arrow MemTable per sheet (detected header; ≥80% numeric column →
/// Float64 with nulls, else Utf8). Returns the registered table names.
fn register_workbook(ctx: &SessionContext, base: &str, abs: &PathBuf) -> Vec<String> {
    use calamine::Reader;
    let Ok(mut wb) = calamine::open_workbook_auto(abs) else {
        return vec![];
    };
    let names: Vec<String> = wb.sheet_names().to_vec();
    let multi = names.len() > 1;
    let mut out = Vec::new();
    for sheet in names.into_iter().take(MAX_SHEETS_PER_BOOK) {
        let Ok(range) = wb.worksheet_range(&sheet) else {
            continue;
        };
        // Stringify once; real workbooks put titles/blank rows above the
        // header, so the header is detected, not assumed (row 0 fallback).
        let all: Vec<Vec<String>> = range
            .rows()
            .take(MAX_XLSX_ROWS + HEADER_SCAN_ROWS)
            .map(|r| r.iter().map(crate::extract::cell_text).collect())
            .collect();
        if all.is_empty() {
            continue;
        }
        let h = detect_header_row(&all);
        let headers: Vec<String> = all[h]
            .iter()
            .take(MAX_XLSX_COLS)
            .enumerate()
            .map(|(i, c)| {
                let s = sanitize_table_name(c);
                if s.is_empty() || s == "table" {
                    format!("col_{}", i + 1)
                } else {
                    s
                }
            })
            .collect();
        if headers.len() < 2 {
            continue;
        }
        let data: Vec<Vec<String>> = all[h + 1..]
            .iter()
            .take(MAX_XLSX_ROWS)
            .map(|r| {
                (0..headers.len())
                    .map(|i| r.get(i).cloned().unwrap_or_default())
                    .collect()
            })
            .collect();
        if data.len() < 2 {
            continue;
        }
        let Some((schema, batch)) = table_from_matrix(&headers, &data) else {
            continue;
        };
        let Ok(mem) = MemTable::try_new(schema, vec![vec![batch]]) else {
            continue;
        };
        let tname = if multi {
            format!("{base}__{}", sanitize_table_name(&sheet))
        } else {
            base.to_string()
        };
        if ctx.register_table(&tname, Arc::new(mem)).is_ok() {
            out.push(tname);
        }
    }
    out
}

/// Header names that suggest a date column — used only as a GUARD so a real
/// measure named "amount"/"total" is never mistaken for serial dates.
fn header_is_dateish(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "date",
        "day",
        "month",
        "time",
        "created",
        "updated",
        "modified",
        "dob",
        "birth",
        "expiry",
        "expire",
        "due",
        "_at",
        "timestamp",
        "datetime",
    ]
    .iter()
    .any(|t| n.contains(t))
}

/// Every non-empty value is a WHOLE number in the plausible Excel-serial DATE
/// range (~1954–2064): the fingerprint of date cells calamine handed back as
/// raw `Data::Float` (General-formatted cells / legacy .xls) rather than
/// `Data::DateTime`. Combined with a date-ish header this is a confident
/// "these are dates, not a measure" — everything else stays numeric.
fn looks_like_serial_dates(vals: &[&String]) -> bool {
    let mut any = false;
    for v in vals {
        let t = v.trim();
        if t.is_empty() {
            continue;
        }
        any = true;
        match t.parse::<f64>() {
            Ok(f) if f.fract() == 0.0 && (20_000.0..=60_000.0).contains(&f) => {}
            _ => return false,
        }
    }
    any
}

/// String matrix → typed Arrow batch (≥80% numeric column → Float64 with
/// nulls, else Utf8; a date-ish serial column → ISO Utf8). One inference over
/// ALL rows, so unioned members can't disagree on a column's type.
fn table_from_matrix(
    headers: &[String],
    data: &[Vec<String>],
) -> Option<(Arc<Schema>, RecordBatch)> {
    let mut fields: Vec<Field> = Vec::new();
    let mut cols: Vec<ArrayRef> = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        let vals: Vec<&String> = data.iter().map(|r| &r[i]).collect();
        let non_empty = vals.iter().filter(|v| !v.trim().is_empty()).count();
        let numeric = vals
            .iter()
            .filter(|v| !v.trim().is_empty() && v.trim().parse::<f64>().is_ok())
            .count();
        let is_num = non_empty > 0 && numeric as f64 >= non_empty as f64 * 0.8;
        if is_num && header_is_dateish(h) && looks_like_serial_dates(&vals) {
            // Excel date serials under a date-ish header: render ISO so month/
            // year GROUP BY (substr(date,1,7)) works instead of the serials
            // being summed into a meaningless "authoritative" number.
            let iso: Vec<String> = vals
                .iter()
                .map(|v| {
                    let t = v.trim();
                    match t.parse::<f64>() {
                        Ok(f) if f.fract() == 0.0 && (20_000.0..=60_000.0).contains(&f) => {
                            crate::extract::excel_serial_to_iso(f)
                        }
                        _ => t.to_string(),
                    }
                })
                .collect();
            fields.push(Field::new(h, DataType::Utf8, true));
            cols.push(Arc::new(StringArray::from(
                iso.iter().map(|s| s.as_str()).collect::<Vec<&str>>(),
            )));
        } else if is_num {
            fields.push(Field::new(h, DataType::Float64, true));
            cols.push(Arc::new(Float64Array::from(
                vals.iter()
                    // A recognized-but-non-finite sentinel (NaN / inf / Infinity,
                    // which Rust's f64 parser accepts) becomes NULL, not a value
                    // that poisons SUM/AVG to NaN — DataFusion then skips it like
                    // an empty cell. The column still types numeric (the count
                    // above accepts the sentinel), so a few NaNs don't flip it to
                    // text; they just don't corrupt the aggregate.
                    .map(|v| v.trim().parse::<f64>().ok().filter(|x| x.is_finite()))
                    .collect::<Vec<Option<f64>>>(),
            )));
        } else {
            fields.push(Field::new(h, DataType::Utf8, true));
            cols.push(Arc::new(StringArray::from(
                vals.iter().map(|v| v.as_str()).collect::<Vec<&str>>(),
            )));
        }
    }
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), cols).ok()?;
    Some((schema, batch))
}

/// Schema + row count + sample rows for the planning prompt (never the data),
/// plus the lowercased column names for deterministic join hints.
async fn table_card(ctx: &SessionContext, table: &str) -> Option<(String, Vec<String>)> {
    let df = ctx
        .sql(&format!("SELECT * FROM {table} LIMIT {SAMPLE_ROWS}"))
        .await
        .ok()?;
    let columns: Vec<String> = df
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().to_lowercase())
        .collect();
    let schema_line = df
        .schema()
        .fields()
        .iter()
        .map(|f| format!("{} {}", f.name(), f.data_type()))
        .collect::<Vec<_>>()
        .join(", ");
    let sample = df.collect().await.ok()?;
    let (sample_md, _, _) = batches_to_markdown(&sample, SAMPLE_ROWS, MAX_RESULT_COLS);
    let count = ctx
        .sql(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .await
        .ok()?
        .collect()
        .await
        .ok()?;
    let n = count
        .first()
        .and_then(|b| {
            b.column(0)
                .as_any()
                .downcast_ref::<datafusion::arrow::array::Int64Array>()
        })
        .map(|a| a.value(0))
        .unwrap_or(0);
    let card =
        format!("table {table} — {n} rows\ncolumns: {schema_line}\nsample rows:\n{sample_md}");
    // Wide sheets can render enormous sample rows; a card is a prompt block,
    // so clip it rather than let one table eat the local model's window.
    let card = if card.chars().count() > MAX_CARD_CHARS {
        let clipped: String = card.chars().take(MAX_CARD_CHARS).collect();
        format!("{clipped}…")
    } else {
        card
    };
    Some((card, columns))
}

/// Deterministic join hints: shared, non-generic column names across distinct
/// registered tables, rendered as one small prompt block (score 0). Hints
/// never force a join — the model may ignore them.
const GENERIC_JOIN_COLS: &[&str] = &[
    "id",
    "name",
    "date",
    "value",
    "amount",
    "total",
    "count",
    "n",
    // Enum/flag/free-text/temporal columns that two unrelated tables commonly
    // share but which are NOT trustworthy join keys — a hint on them can steer
    // the model into a wrong join (and a wrong number).
    "status",
    "type",
    "category",
    "notes",
    "note",
    "priority",
    "active",
    "description",
    "comment",
    "created_at",
    "updated_at",
    "month",
    "year",
    "quarter",
    "label",
    "key",
    "code",
];
const MAX_JOIN_HINTS: usize = 12;

/// A column too generic to be a trustworthy join key: the curated list above,
/// OR any auto-generated `col_N` placeholder (headerless files all share
/// `col_1…col_64`, so two unrelated matrices must not hint `col_3 = col_3`).
fn is_generic_join_col(c: &str) -> bool {
    GENERIC_JOIN_COLS.contains(&c)
        || c.strip_prefix("col_")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn join_hints(regs: &[TableReg]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    'outer: for i in 0..regs.len() {
        for j in i + 1..regs.len() {
            if regs[i].table == regs[j].table {
                continue;
            }
            for c in &regs[i].columns {
                if is_generic_join_col(c) {
                    continue;
                }
                if regs[j].columns.contains(c) {
                    lines.push(format!(
                        "- {t1}.{c} = {t2}.{c}",
                        t1 = regs[i].table,
                        t2 = regs[j].table
                    ));
                    if lines.len() >= MAX_JOIN_HINTS {
                        break 'outer;
                    }
                }
            }
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(format!(
            "Join hints (columns shared across tables — use when combining them):\n{}",
            lines.join("\n")
        ))
    }
}

// --- Freshness -------------------------------------------------------------------
//
// A field report of "analytics still appear to be outdated" turned out to be
// about the *file*, not the engine: every ask reads the current on-disk bytes
// (csv/parquet are registered by path, workbooks are opened at ask time), so
// stale numbers mean a stale file — cloud-sync lag, edits saved to a different
// copy, or unsaved changes in Excel. The footer below makes that visible in
// the answer itself instead of leaving the user to guess.

/// Epoch-ms mtime; None when the file or its timestamp can't be read.
fn file_mtime_ms(abs: &PathBuf) -> Option<i64> {
    let t = std::fs::metadata(abs).ok()?.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(d.as_millis()).ok()
}

/// Human age of the file's last save. Coarse on purpose — "2 hours ago"
/// answers "is this stale?" better than a UTC timestamp the user must convert.
pub fn saved_age_label(modified_ms: i64, now_ms: i64) -> String {
    let delta = now_ms - modified_ms;
    // Future mtimes happen (clock skew, cloud-sync stamping); read as fresh.
    if delta < 60_000 {
        return "just now".to_string();
    }
    const LADDER: &[(i64, &str)] = &[
        (60_000, "minute"),
        (3_600_000, "hour"),
        (86_400_000, "day"),
        (604_800_000, "week"),
        (2_592_000_000, "month"),
        (31_536_000_000, "year"),
    ];
    let (unit_ms, unit) = LADDER
        .iter()
        .rev()
        .find(|(ms, _)| delta >= *ms)
        .expect("delta >= one minute");
    let n = delta / unit_ms;
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

/// Word-boundary, case-insensitive "does this SQL reference that table" —
/// `sales` is not mentioned by `sales_2024` or `presales`.
pub fn sql_mentions_table(sql: &str, table: &str) -> bool {
    let hay = sql.to_lowercase();
    let needle = table.to_lowercase();
    if needle.is_empty() {
        return false;
    }
    let bytes = hay.as_bytes();
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut from = 0;
    while let Some(pos) = hay[from..].find(&needle) {
        let start = from + pos;
        let end = start + needle.len();
        if (start == 0 || !ident(bytes[start - 1])) && (end == bytes.len() || !ident(bytes[end])) {
            return true;
        }
        from = start + 1;
    }
    false
}

/// The deterministic footer line naming the files the query read and how
/// fresh each on-disk copy was at ask time, deduped by file (a workbook can
/// register several sheets). Only files whose tables the SQL actually
/// references are named; if none match (the model aliased beyond
/// recognition), listing every registered file is the honest fallback.
pub fn freshness_line(regs: &[TableReg], sql: &str, now_ms: i64) -> Option<String> {
    let hits: Vec<&TableReg> = regs
        .iter()
        .filter(|r| sql_mentions_table(sql, &r.table))
        .collect();
    let used: Vec<&TableReg> = if hits.is_empty() {
        regs.iter().collect()
    } else {
        hits
    };
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let parts: Vec<String> = used
        .iter()
        .filter(|r| seen.insert(r.file_id.as_str()))
        .map(|r| match (&r.group, r.modified_ms) {
            (Some(g), _) => format!(
                "“{}” ({} files, newest saved {})",
                r.file_name,
                g.file_ids.len(),
                saved_age_label(g.newest_ms, now_ms)
            ),
            (None, Some(ms)) => {
                format!("“{}” (saved {})", r.file_name, saved_age_label(ms, now_ms))
            }
            (None, None) => format!("“{}”", r.file_name),
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(format!("*Computed from:* {}\n", parts.join(", ")))
}

// --- SQL guard -------------------------------------------------------------------

/// Pull the SQL out of a model reply: fenced ```sql block if present, else the
/// text from the first SELECT/WITH onward. Strips trailing semicolons.
pub fn extract_sql(raw: &str) -> Option<String> {
    let cleaned = raw.trim();
    let body = if let Some(start) = cleaned.find("```") {
        let after = &cleaned[start + 3..];
        let after = after.strip_prefix("sql").unwrap_or(after);
        match after.find("```") {
            Some(end) => &after[..end],
            None => after,
        }
    } else {
        cleaned
    };
    let upper = body.to_uppercase();
    let at = upper
        .find("SELECT")
        .into_iter()
        .chain(upper.find("WITH"))
        .min()?;
    let sql = body[at..].trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        None
    } else {
        Some(sql)
    }
}

/// Read-only by construction: exactly one statement, and it must parse as a
/// plain query (SELECT / WITH…SELECT) that reads only. Everything else is
/// rejected up front. A structural `Query(_)` match is NOT enough — sqlparser
/// wraps `SELECT … INTO` (which DataFusion executes as a CreateMemoryTable DDL,
/// dodging the timeout + row cap) and data-modifying CTE/query bodies
/// (INSERT/UPDATE/… — only DataFusion's current non-support keeps them inert)
/// inside `Statement::Query`, so the body and every CTE are checked recursively.
pub fn guard_sql(sql: &str) -> Result<(), String> {
    use datafusion::sql::parser::{DFParser, Statement as DFStatement};
    use datafusion::sql::sqlparser::ast::Statement as SqlStatement;
    let stmts = DFParser::parse_sql(sql).map_err(|e| format!("SQL parse error: {e}"))?;
    if stmts.len() != 1 {
        return Err("expected exactly one SQL statement".into());
    }
    match stmts.front() {
        Some(DFStatement::Statement(s)) => match &**s {
            SqlStatement::Query(q) => query_is_read_only(q),
            _ => Err("only SELECT queries are allowed".into()),
        },
        _ => Err("only SELECT queries are allowed".into()),
    }
}

/// Recursively confirm a parsed query reads only: no `SELECT … INTO`, and no
/// data-modifying set-expression as a body or CTE. Whitelists the read-only
/// body shapes so a future sqlparser variant can't silently pass.
fn query_is_read_only(q: &datafusion::sql::sqlparser::ast::Query) -> Result<(), String> {
    if let Some(with) = &q.with {
        for cte in &with.cte_tables {
            query_is_read_only(&cte.query)?;
        }
    }
    set_expr_is_read_only(&q.body)
}

fn set_expr_is_read_only(body: &datafusion::sql::sqlparser::ast::SetExpr) -> Result<(), String> {
    use datafusion::sql::sqlparser::ast::SetExpr;
    match body {
        SetExpr::Select(s) => {
            if s.into.is_some() {
                return Err("SELECT ... INTO is not allowed".into());
            }
            Ok(())
        }
        SetExpr::Query(inner) => query_is_read_only(inner),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_read_only(left)?;
            set_expr_is_read_only(right)
        }
        SetExpr::Values(_) => Ok(()),
        // INSERT / UPDATE / TABLE / any modifying or unrecognized body.
        _ => Err("only read-only SELECT queries are allowed".into()),
    }
}

// --- Execution + rendering -------------------------------------------------------

/// A verified query result, ready for the narration prompt and the chat.
pub struct QueryResult {
    /// Markdown table FOR THE NARRATION PROMPT — capped to NARRATE_MAX_ROWS /
    /// NARRATE_MAX_CHARS with an explicit truncation note, so a wide/tall
    /// result can never blow the local model's context window (a 0.6.0 field
    /// report hit 12.6k prompt tokens against the 6144 window this way).
    pub markdown: String,
    /// Rows the engine computed into this result (up to the execution cap) —
    /// NOT the rows present in `markdown`, and NOT the true total when capped.
    pub shown: usize,
    pub truncated: bool,
    /// The query's TRUE total row count. `Some(shown)` when not truncated;
    /// when truncated, `Some(true_total)` from a one-shot `COUNT(*)` over the
    /// same guarded query, or `None` if that count failed/timed out — never a
    /// fabricated number. Drives the "first 200 of 12,431" honesty.
    pub total: Option<usize>,
    /// Engine-built chart spec JSON when the result is chartable (Phase C) —
    /// rendered by the UI from a ```lighthouse-chart fence. Never model text.
    pub chart: Option<String>,
    /// Digest of the FULL execution-capped result (not the narration-clipped
    /// render) — pin change detection compares this, so a change anywhere in
    /// the result alerts even past the narration caps.
    pub digest: String,
}

/// Run a guarded query with a hard timeout and result caps.
pub async fn run_query(ctx: &SessionContext, sql: &str) -> Result<QueryResult, String> {
    guard_sql(sql)?;
    let base_df = ctx.sql(sql).await.map_err(|e| e.to_string())?;
    // Post-plan cap: applied after ORDER BY/aggregation, so semantics hold. The
    // uncapped `base_df` is kept so an overflowed result can be counted below.
    let df = base_df
        .clone()
        .limit(0, Some(MAX_RESULT_ROWS + 1))
        .map_err(|e| e.to_string())?;
    let batches = tokio::time::timeout(Duration::from_secs(QUERY_TIMEOUT_SECS), df.collect())
        .await
        .map_err(|_| format!("query exceeded {QUERY_TIMEOUT_SECS}s"))?
        .map_err(|e| e.to_string())?;
    let (_, shown, truncated) = batches_to_markdown(&batches, MAX_RESULT_ROWS, MAX_RESULT_COLS);
    if shown == 0 {
        return Err("the query returned no rows".into());
    }
    // Truncation honesty: the 201-row probe only tells us the result overflowed,
    // not by how much — `shown` saturates at the cap. When truncated, count the
    // UNCAPPED plan once (same guarded query, one bounded aggregate) so the
    // answer and footer can say "first 200 of 12,431". A count failure/timeout
    // leaves the total unknown rather than fabricating one; a non-truncated
    // result's total is exactly `shown`.
    let total: Option<usize> = if truncated {
        match tokio::time::timeout(Duration::from_secs(QUERY_TIMEOUT_SECS), base_df.count()).await {
            Ok(Ok(n)) => Some(n),
            _ => None,
        }
    } else {
        Some(shown)
    };
    let (mut markdown, in_prompt, _) = batches_to_markdown(
        &batches,
        NARRATE_MAX_ROWS.min(MAX_RESULT_ROWS),
        MAX_RESULT_COLS,
    );
    if markdown.chars().count() > NARRATE_MAX_CHARS {
        // Cut whole lines from the end until it fits — a mid-row cut would
        // leave a mangled table for the model to misread.
        let mut kept = String::with_capacity(NARRATE_MAX_CHARS);
        for line in markdown.lines() {
            if kept.chars().count() + line.chars().count() + 1 > NARRATE_MAX_CHARS {
                break;
            }
            kept.push_str(line);
            kept.push('\n');
        }
        markdown = kept.trim_end().to_string();
    }
    if truncated || in_prompt < shown || markdown.lines().count().saturating_sub(2) < in_prompt {
        // Never claim the cap IS the total. Phrased NEUTRALLY (no "tell the
        // user …" imperative): the model-free run_direct path renders this same
        // markdown verbatim to a human (Edit-SQL / Save-CSV preview), so the
        // note must read as an honest caption, not a model instruction.
        let note = if truncated {
            match total {
                Some(t) => format!(
                    "showing the first {in_prompt} rows; this query matched {t} rows in total \
                     (the engine computed the first {shown})."
                ),
                None => format!(
                    "showing the first {in_prompt} rows; this query matched more than {shown} rows \
                     (only the first {shown} were computed)."
                ),
            }
        } else {
            format!("showing the first {in_prompt} of {shown} rows.")
        };
        markdown.push_str(&format!("\n\n({note})"));
    }
    // Column honesty: batches_to_markdown drops columns past MAX_RESULT_COLS
    // with no signal of its own. Neutral, human-safe wording (run_direct renders
    // this markdown verbatim), parallel to the row note.
    let total_cols = batches
        .iter()
        .find(|b| b.num_columns() > 0)
        .map_or(0, |b| b.num_columns());
    if total_cols > MAX_RESULT_COLS {
        markdown.push_str(&format!(
            "\n\n(showing {MAX_RESULT_COLS} of {total_cols} columns.)"
        ));
    }
    let chart = if truncated {
        None
    } else {
        chart_spec_from_batches(&batches)
    };
    let (digest_bytes, _) = batches_to_csv(&batches, MAX_RESULT_ROWS + 1);
    let digest: String = Sha1::digest(&digest_bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(QueryResult {
        markdown,
        shown,
        truncated,
        chart,
        digest,
        total,
    })
}

// --- Charts (Phase C) --------------------------------------------------------------
//
// Small group-by results become a chart spec the UI draws as SVG. Built from
// the engine's own record batches — deterministic, never model-generated. The
// shape must stay in lock-step with src/lib/chartSpec.ts (parseChartSpec).

const CHART_MAX_POINTS: usize = 24;
const CHART_MAX_SERIES: usize = 3;

/// Chartable = one label-ish first column + 1..=3 numeric columns, 2..=24
/// rows, at least 2 finite values per series. When the labels read as time
/// (dates / YYYY-MM / years): area for a single metric, line for several;
/// bar otherwise. None = "not a chart" — answers degrade to the table alone,
/// never to a wrong drawing.
///
/// Kinds are deliberately limited to bar / line / area. Stacked bar and
/// scatter are NOT emitted: stacking implies a part-of-whole SUM relationship
/// the engine can't safely infer from an arbitrary GROUP BY (stacking
/// independent metrics would state a falsehood), and scatter needs a numeric
/// x-axis, but this pipeline's x is always a categorical/temporal label. Both
/// would trade the "never draw a claim the data doesn't make" guarantee for a
/// visual — so grouped bar covers the multi-series case and the table carries
/// the rest.
pub fn chart_spec_from_batches(batches: &[RecordBatch]) -> Option<String> {
    let first = batches.iter().find(|b| b.num_columns() > 0)?;
    let schema = first.schema();
    let ncols = schema.fields().len();
    if !(2..=1 + CHART_MAX_SERIES).contains(&ncols) {
        return None;
    }
    if !schema
        .fields()
        .iter()
        .skip(1)
        .all(|f| f.data_type().is_numeric())
    {
        return None;
    }
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if !(2..=CHART_MAX_POINTS).contains(&rows) {
        return None;
    }

    let mut x: Vec<String> = Vec::with_capacity(rows);
    let mut series: Vec<(String, Vec<Option<f64>>)> = schema
        .fields()
        .iter()
        .skip(1)
        .map(|f| (f.name().clone(), Vec::with_capacity(rows)))
        .collect();
    for b in batches {
        for row in 0..b.num_rows() {
            let label = array_value_to_string(b.column(0), row).unwrap_or_default();
            if label.trim().is_empty() {
                return None; // unlabeled point — the table tells it better
            }
            x.push(label.chars().take(40).collect());
            for (c, (_, vals)) in series.iter_mut().enumerate() {
                let col = b.column(c + 1);
                if col.is_null(row) {
                    vals.push(None);
                } else {
                    let raw = array_value_to_string(col, row).unwrap_or_default();
                    match raw.trim().parse::<f64>() {
                        Ok(v) if v.is_finite() => vals.push(Some(v)),
                        _ => return None, // a non-numeric render ⇒ don't chart
                    }
                }
            }
        }
    }
    for (_, vals) in &series {
        if vals.iter().filter(|v| v.is_some()).count() < 2 {
            return None;
        }
    }

    // Time-series read best as a filled area when there's a single metric;
    // multiple series stay a line (overlapping fills would muddy them);
    // categorical stays a bar. Renderer accepts all three (chartSpec.ts).
    let temporal = x.iter().all(|l| looks_temporal(l));
    let kind = if temporal {
        if series.len() == 1 {
            "area"
        } else {
            "line"
        }
    } else {
        "bar"
    };
    let spec = serde_json::json!({
        "kind": kind,
        "x": x,
        "series": series
            .iter()
            .map(|(name, vals)| serde_json::json!({ "name": name, "values": vals }))
            .collect::<Vec<_>>(),
    });
    Some(spec.to_string())
}

/// Date-ish labels: 2024, 2024-07, 2024-07-08 (optional time tail), Q3 2024.
fn looks_temporal(label: &str) -> bool {
    let l = label.trim();
    let bytes = l.as_bytes();
    let all_digits = |s: &[u8]| !s.is_empty() && s.iter().all(|b| b.is_ascii_digit());
    if bytes.len() == 4 && all_digits(bytes) {
        return true; // bare year
    }
    if bytes.len() >= 7
        && all_digits(&bytes[..4])
        && bytes[4] == b'-'
        && all_digits(&bytes[5..7])
        && (bytes.len() == 7 || bytes[7] == b'-' || bytes[7] == b' ' || bytes[7] == b'T')
    {
        return true; // YYYY-MM…
    }
    let lower = l.to_lowercase();
    if let Some(rest) = lower.strip_prefix('q') {
        let mut parts = rest.splitn(2, ' ');
        if let (Some(q), Some(y)) = (parts.next(), parts.next()) {
            return all_digits(q.as_bytes()) && all_digits(y.as_bytes());
        }
    }
    false
}

/// Render record batches as a compact Markdown table (rows/cols/cell caps).
pub fn batches_to_markdown(
    batches: &[RecordBatch],
    max_rows: usize,
    max_cols: usize,
) -> (String, usize, bool) {
    let Some(first) = batches.iter().find(|b| b.num_columns() > 0) else {
        return (String::new(), 0, false);
    };
    let schema = first.schema();
    let ncols = schema.fields().len().min(max_cols);
    let cell = |s: String| -> String {
        let s = s.replace('|', "\\|").replace('\n', " ");
        if s.chars().count() > MAX_CELL_CHARS {
            format!(
                "{}…",
                s.chars().take(MAX_CELL_CHARS - 1).collect::<String>()
            )
        } else {
            s
        }
    };
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "| {} |",
        schema
            .fields()
            .iter()
            .take(ncols)
            .map(|f| cell(f.name().clone()))
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    lines.push(format!("|{}|", " --- |".repeat(ncols)));
    let mut shown = 0;
    let mut more = false;
    'outer: for b in batches {
        for row in 0..b.num_rows() {
            if shown >= max_rows {
                more = true;
                break 'outer;
            }
            let mut cells = Vec::with_capacity(ncols);
            for c in 0..ncols {
                let v = array_value_to_string(b.column(c), row).unwrap_or_default();
                cells.push(cell(v));
            }
            lines.push(format!("| {} |", cells.join(" | ")));
            shown += 1;
        }
    }
    (lines.join("\n"), shown, more)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_detects_aggregate_asks() {
        assert!(analytics_cue("What were total sales per region in 2017?"));
        assert!(analytics_cue("give me an analysis of the invoices"));
        assert!(analytics_cue("how many orders came from NE?"));
        assert!(analytics_cue("top 5 customers by revenue"));
        assert!(!analytics_cue(
            "what does the onboarding doc say about SSO?"
        ));
        assert!(!analytics_cue("when is the invoice due?"));
    }

    #[test]
    fn header_row_is_detected_not_assumed() {
        let rows = |rs: &[&[&str]]| -> Vec<Vec<String>> {
            rs.iter()
                .map(|r| r.iter().map(|s| s.to_string()).collect())
                .collect()
        };
        // Title row (one cell) above the real header.
        let sheet = rows(&[
            &["Q3 Ticket Report"],
            &[],
            &["date", "region", "amount"],
            &["2025-01-02", "NE", "100"],
        ]);
        assert_eq!(detect_header_row(&sheet), 2);
        // Plain sheet: header at row 0 wins ties against textual data rows.
        let plain = rows(&[&["name", "email"], &["alice", "alice@x.com"]]);
        assert_eq!(detect_header_row(&plain), 0);
        // Numeric preamble then header.
        let preamble = rows(&[&["1", "2", "3"], &["date", "region", "amount"]]);
        assert_eq!(detect_header_row(&preamble), 1);
        // Nothing qualifies (all-numeric sheet) → row 0 fallback.
        let numeric = rows(&[&["1", "2"], &["3", "4"]]);
        assert_eq!(detect_header_row(&numeric), 0);
        // Empty input stays at 0.
        assert_eq!(detect_header_row(&[]), 0);
        // A wider, more distinct header BELOW a narrow qualifier wins.
        let wide = rows(&[&["report", "2025"], &["date", "region", "amount", "rep"]]);
        assert_eq!(detect_header_row(&wide), 1);
    }

    #[test]
    fn table_names_sanitize() {
        assert_eq!(
            sanitize_table_name("Q3 Sales (final).xlsx"),
            "q3_sales_final"
        );
        assert_eq!(sanitize_table_name("2017.csv"), "t_2017");
        assert_eq!(sanitize_table_name("__.csv"), "table");
    }

    #[test]
    fn saved_age_labels_read_naturally() {
        let now = 1_700_000_000_000i64;
        assert_eq!(saved_age_label(now - 5_000, now), "just now");
        assert_eq!(saved_age_label(now + 120_000, now), "just now"); // future mtime = clock skew
        assert_eq!(saved_age_label(now - 90_000, now), "1 minute ago");
        assert_eq!(saved_age_label(now - 45 * 60_000, now), "45 minutes ago");
        assert_eq!(saved_age_label(now - 5 * 3_600_000, now), "5 hours ago");
        assert_eq!(saved_age_label(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(saved_age_label(now - 10 * 86_400_000, now), "1 week ago");
        assert_eq!(saved_age_label(now - 70 * 86_400_000, now), "2 months ago");
        assert_eq!(saved_age_label(now - 800 * 86_400_000, now), "2 years ago");
    }

    #[test]
    fn sql_table_mentions_respect_word_boundaries() {
        assert!(sql_mentions_table(
            "SELECT * FROM sales s JOIN reps r ON 1=1",
            "sales"
        ));
        assert!(sql_mentions_table("select sum(x) from SALES", "sales"));
        assert!(sql_mentions_table(
            "SELECT * FROM t JOIN orders ON 1=1",
            "orders"
        ));
        assert!(!sql_mentions_table("SELECT * FROM sales_2024", "sales"));
        assert!(!sql_mentions_table("SELECT presales FROM t", "sales"));
        assert!(!sql_mentions_table("SELECT 1", ""));
    }

    #[test]
    fn freshness_line_names_only_queried_files() {
        let now = 1_700_000_000_000i64;
        let reg = |table: &str, id: &str, name: &str, ms: Option<i64>| TableReg {
            table: table.into(),
            file_id: id.into(),
            file_name: name.into(),
            card: String::new(),
            modified_ms: ms,
            columns: vec![],
            group: None,
        };
        let regs = vec![
            reg("tickets", "f1", "Tickets.xlsx", Some(now - 2 * 3_600_000)),
            reg(
                "tickets__sheet2",
                "f1",
                "Tickets.xlsx",
                Some(now - 2 * 3_600_000),
            ),
            reg("regions", "f2", "regions.csv", Some(now - 400 * 86_400_000)),
        ];
        let line = freshness_line(&regs, "SELECT * FROM tickets", now).unwrap();
        assert!(
            line.contains("Tickets.xlsx") && line.contains("2 hours ago"),
            "{line}"
        );
        assert!(!line.contains("regions.csv"), "{line}");
        // Two sheets of one workbook = one mention (dedup by file id).
        assert_eq!(line.matches("Tickets.xlsx").count(), 1, "{line}");
        // Nothing matched (model aliased beyond recognition) → honest
        // fallback: every registered file.
        let all = freshness_line(&regs, "SELECT 1", now).unwrap();
        assert!(
            all.contains("Tickets.xlsx") && all.contains("regions.csv"),
            "{all}"
        );
        // Missing mtime → name only, no fabricated age.
        let l = freshness_line(&[reg("t", "f9", "x.csv", None)], "SELECT * FROM t", now).unwrap();
        assert!(l.contains("“x.csv”") && !l.contains("saved"), "{l}");
        assert!(freshness_line(&[], "SELECT 1", now).is_none());
    }

    #[test]
    fn sql_extraction_handles_fences_and_prose() {
        assert_eq!(
            extract_sql("Here you go:\n```sql\nSELECT a FROM t;\n```").as_deref(),
            Some("SELECT a FROM t")
        );
        assert_eq!(
            extract_sql("SELECT x FROM y WHERE z > 1").as_deref(),
            Some("SELECT x FROM y WHERE z > 1")
        );
        assert_eq!(
            extract_sql("with c as (select 1) select * from c").as_deref(),
            Some("with c as (select 1) select * from c")
        );
        assert_eq!(extract_sql("no query here"), None);
    }

    #[test]
    fn guard_rejects_writes_and_multi_statements() {
        assert!(guard_sql("SELECT 1").is_ok());
        assert!(guard_sql("WITH c AS (SELECT 1 AS a) SELECT a FROM c").is_ok());
        assert!(guard_sql("DROP TABLE t").is_err());
        assert!(guard_sql("UPDATE t SET a = 1").is_err());
        assert!(guard_sql("INSERT INTO t VALUES (1)").is_err());
        assert!(guard_sql("SELECT 1; SELECT 2").is_err());
        assert!(guard_sql("CREATE TABLE x AS SELECT 1").is_err());
    }

    #[test]
    fn every_fewshot_example_passes_the_guard() {
        for (q, sql) in SQL_FEWSHOTS {
            guard_sql(sql).unwrap_or_else(|e| panic!("few-shot for {q:?} rejected: {e}"));
            // And survives the fence extraction the real reply goes through.
            let fenced = format!("```sql\n{sql}\n```");
            assert_eq!(extract_sql(&fenced).as_deref(), Some(*sql), "{q}");
        }
        // All five ride in the prompt.
        let prompt = sql_question("top vendors by spend", None);
        for (_, sql) in SQL_FEWSHOTS {
            assert!(prompt.contains(sql));
        }
    }

    #[test]
    fn prior_query_rides_only_when_present() {
        let with = sql_question("same but monthly", Some("SELECT a FROM t"));
        assert!(
            with.contains("Previous query from this conversation"),
            "{with}"
        );
        assert!(with.contains("SELECT a FROM t"));
        let without = sql_question("total sales", None);
        assert!(!without.contains("Previous query"));
    }

    #[test]
    fn last_query_used_recovers_the_latest_fence() {
        let turn = |role: &str, content: &str| ChatTurn {
            role: role.into(),
            content: content.into(),
        };
        // No analytics yet.
        assert_eq!(
            last_query_used(&[turn("user", "hi"), turn("assistant", "hello")]),
            None
        );
        // The most recent fenced answer wins, even past a non-analytics turn.
        let history = vec![
            turn("user", "totals?"),
            turn(
                "assistant",
                "Totals below.\n\n*Query used:*\n```sql\nSELECT region, SUM(x) FROM t GROUP BY region\n```\n",
            ),
            turn("user", "what does the doc say?"),
            turn("assistant", "The doc says …"),
        ];
        assert_eq!(
            last_query_used(&history).as_deref(),
            Some("SELECT region, SUM(x) FROM t GROUP BY region")
        );
        // Multiple fences in one answer (multi-step) → the LAST fence.
        let multi = vec![turn(
            "assistant",
            "*Queries used (2):*\n```sql\nSELECT 1\n```\n```sql\nSELECT 2\n```\n",
        )];
        assert_eq!(last_query_used(&multi).as_deref(), Some("SELECT 2"));
        // Oversized prior clamps.
        let big = format!("*Query used:*\n```sql\nSELECT {}\n```", "x".repeat(2000));
        assert!(last_query_used(&[turn("assistant", &big)]).unwrap().len() <= 800);
    }

    #[test]
    fn multi_step_cue_needs_both_cues() {
        // Analytics + comparison/why ⇒ multi-step.
        for q in [
            "Compare total revenue Q3 vs Q4 and explain the drivers",
            "why did the total drop in november",
            "what caused the change between the quarterly totals",
            "difference in average order size versus last year",
        ] {
            assert!(multi_step_cue(q), "expected multi-step for {q:?}");
        }
        // Single-cue questions stay on the single-query path.
        for q in [
            "total sales by region",       // analytics only
            "compare the two contracts",   // comparison only, no analytics cue
            "summarize the meeting notes", // neither
            "top 10 customers by revenue", // analytics only
        ] {
            assert!(!multi_step_cue(q), "expected single-query for {q:?}");
        }
    }

    #[test]
    fn step_replies_parse_tolerantly() {
        assert_eq!(
            parse_step_reply(
                "NEXT_SQL:\n```sql\nSELECT region, SUM(x) FROM t GROUP BY region\n```"
            ),
            StepReply::Sql("SELECT region, SUM(x) FROM t GROUP BY region".to_string())
        );
        assert_eq!(
            parse_step_reply("SELECT a FROM b"),
            StepReply::Sql("SELECT a FROM b".to_string())
        );
        assert_eq!(parse_step_reply("DONE"), StepReply::Done);
        assert_eq!(parse_step_reply("done."), StepReply::Done);
        // Prose with no SQL ends the loop instead of derailing it.
        assert_eq!(
            parse_step_reply("The data already answers the question."),
            StepReply::Done
        );
    }

    #[test]
    fn step_prompt_stays_inside_budget() {
        // Maximal shape: 3 completed steps, each with a long SQL and a result
        // at the carry cap — the prompt must stay comfortably under ~8k chars.
        let steps: Vec<StepRecord> = (0..3)
            .map(|i| StepRecord {
                sql: format!(
                    "SELECT c{i}, SUM(v) FROM {} GROUP BY c{i} ORDER BY 2 DESC",
                    "t".repeat(120)
                ),
                result_markdown: "| a | b |\n| 1 | 2 |\n".repeat(200), // > cap, gets clipped
            })
            .collect();
        let q = step_question(&"compare everything and explain why ".repeat(8), &steps);
        assert!(
            q.chars().count() < 8_000,
            "prompt budget blown: {}",
            q.chars().count()
        );
        assert!(q.contains("Step 3 SQL"));
    }

    #[test]
    fn csv_writer_is_rfc4180() {
        // Quotes double, commas/newlines/unicode quote, NULLs render empty.
        let schema = Arc::new(Schema::new(vec![
            Field::new("name, quoted", DataType::Utf8, false),
            Field::new("total", DataType::Float64, true),
        ]));
        let b = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec!["say \"hi\"", "line\nbreak", "café"])),
                Arc::new(Float64Array::from(vec![Some(1.5), None, Some(3.0)])),
            ],
        )
        .unwrap();
        let (bytes, rows) = batches_to_csv(&[b.clone()], SAVE_MAX_ROWS);
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(rows, 3);
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("\"name, quoted\",total"));
        assert_eq!(lines.next(), Some("\"say \"\"hi\"\"\",1.5"));
        // The embedded newline keeps the quoted field on two physical lines.
        assert_eq!(lines.next(), Some("\"line"));
        assert_eq!(lines.next(), Some("break\","));
        assert_eq!(lines.next(), Some("café,3.0"));
        // The cap truncates data rows, never the header.
        let (bytes, rows) = batches_to_csv(&[b], 1);
        assert_eq!(rows, 1);
        assert_eq!(String::from_utf8(bytes).unwrap().lines().count(), 2);
    }

    fn batch(labels: &[&str], values: &[f64]) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("label", DataType::Utf8, false),
            Field::new("total", DataType::Float64, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(labels.to_vec())),
                Arc::new(Float64Array::from(values.to_vec())),
            ],
        )
        .unwrap()
    }

    #[test]
    fn chart_spec_from_group_by_results() {
        // Categorical labels → bar.
        let spec = chart_spec_from_batches(&[batch(&["NE", "NW", "SE"], &[150.0, 200.0, 300.0])])
            .expect("chartable");
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(v["kind"], "bar");
        assert_eq!(v["x"].as_array().unwrap().len(), 3);
        assert_eq!(v["series"][0]["name"], "total");
        assert_eq!(v["series"][0]["values"][2], 300.0);

        // Single-series month labels → area (a filled time-series).
        let spec =
            chart_spec_from_batches(&[batch(&["2024-01", "2024-02", "2024-03"], &[1.0, 2.0, 3.0])])
                .unwrap();
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(v["kind"], "area");

        // Multi-series time-series → line (overlapping fills would muddy it).
        let two_series = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("month", DataType::Utf8, false),
                Field::new("a", DataType::Float64, true),
                Field::new("b", DataType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["2024-01", "2024-02", "2024-03"])),
                Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])),
                Arc::new(Float64Array::from(vec![3.0, 2.0, 1.0])),
            ],
        )
        .unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[two_series]).unwrap()).unwrap();
        assert_eq!(v["kind"], "line");

        // One row is not a chart; neither is a non-numeric value column.
        assert!(chart_spec_from_batches(&[batch(&["only"], &[1.0])]).is_none());
        let two_text = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("a", DataType::Utf8, false),
                Field::new("b", DataType::Utf8, false),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["x", "y"])),
                Arc::new(StringArray::from(vec!["1", "2"])),
            ],
        )
        .unwrap();
        assert!(chart_spec_from_batches(&[two_text]).is_none());
    }

    #[test]
    fn temporal_labels_are_recognized() {
        for l in [
            "2024",
            "2024-07",
            "2024-07-08",
            "2024-07-08 12:00",
            "Q3 2024",
            "q1 2025",
        ] {
            assert!(looks_temporal(l), "{l}");
        }
        for l in ["NE", "widget-9000", "July", "20245", "2024-7"] {
            assert!(!looks_temporal(l), "{l}");
        }
    }

    #[tokio::test]
    async fn narration_markdown_is_capped_but_counts_stay_honest() {
        // 100-row result: execution keeps all rows (shown=100), but the
        // narration payload carries at most NARRATE_MAX_ROWS plus a note —
        // the overflow that blew a local 6144-token window in the field.
        let labels: Vec<String> = (0..100).map(|i| format!("row{i}")).collect();
        let values: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let schema = Arc::new(Schema::new(vec![
            Field::new("label", DataType::Utf8, false),
            Field::new("v", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(
                    labels.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
                Arc::new(Float64Array::from(values)),
            ],
        )
        .unwrap();
        let mem = MemTable::try_new(schema, vec![vec![batch]]).unwrap();
        let ctx = SessionContext::new();
        ctx.register_table("tall", Arc::new(mem)).unwrap();

        let res = run_query(&ctx, "SELECT label, v FROM tall ORDER BY v")
            .await
            .unwrap();
        assert_eq!(res.shown, 100);
        assert!(!res.truncated);
        assert_eq!(res.total, Some(100)); // not truncated ⇒ total is exact
                                          // Header + separator + ≤40 data rows + blank + note.
        let data_rows = res
            .markdown
            .lines()
            .filter(|l| l.starts_with("| row"))
            .count();
        assert!(data_rows <= 40, "narration carries {data_rows} rows");
        assert!(
            res.markdown.chars().count() <= 6_200,
            "{}",
            res.markdown.len()
        );
        assert!(res.markdown.contains("of 100 rows"), "{}", res.markdown);
    }

    #[tokio::test]
    async fn table_cards_are_clipped_for_wide_tables() {
        // 40 long-named text columns would render a card far past the prompt
        // budget; the card must clip instead.
        let n = 40usize;
        let fields: Vec<Field> = (0..n)
            .map(|i| {
                Field::new(
                    format!("very_long_column_name_number_{i}"),
                    DataType::Utf8,
                    false,
                )
            })
            .collect();
        let cols: Vec<ArrayRef> = (0..n)
            .map(|i| {
                Arc::new(StringArray::from(vec![
                    format!("some fairly long cell value {i} aaaaaaaaaaaaaaaaaaaaaaaa"),
                    format!("another fairly long cell value {i} bbbbbbbbbbbbbbbbbbbb"),
                    format!("third fairly long cell value {i} cccccccccccccccccccccc"),
                ])) as ArrayRef
            })
            .collect();
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
        let mem = MemTable::try_new(schema, vec![vec![batch]]).unwrap();
        let ctx = SessionContext::new();
        ctx.register_table("wide", Arc::new(mem)).unwrap();

        let (card, columns) = table_card(&ctx, "wide").await.expect("card");
        assert!(
            card.chars().count() <= super::MAX_CARD_CHARS + 1,
            "card is {} chars",
            card.chars().count()
        );
        assert_eq!(columns.len(), n, "join hints need every column name");
    }

    #[test]
    fn union_stems_collapse_digit_runs() {
        assert_eq!(union_stem("sales-2025-01.csv"), "sales");
        assert_eq!(union_stem("sales-2025-12.csv"), "sales");
        assert_eq!(union_stem("q3_sales.xlsx"), "q_sales");
        assert_eq!(union_stem("regions.csv"), "regions");
        assert_eq!(union_stem("2025.csv"), "");
    }

    fn file_cols(id: &str, name: &str, cols: &[&str], ms: i64) -> crate::catalog::FileColumns {
        crate::catalog::FileColumns {
            id: id.into(),
            name: name.into(),
            columns: cols
                .iter()
                .map(|c| crate::catalog::Column {
                    name: c.to_string(),
                    kind: crate::catalog::ColumnKind::Text,
                })
                .collect(),
            modified_ms: ms,
        }
    }

    #[test]
    fn union_groups_need_stem_and_signature() {
        let p = |n: &str| std::path::PathBuf::from(format!("/v/{n}"));
        let files: Vec<(String, String, std::path::PathBuf)> = vec![
            (
                "f1".into(),
                "sales-2025-01.csv".into(),
                p("sales-2025-01.csv"),
            ),
            (
                "f2".into(),
                "sales-2025-02.csv".into(),
                p("sales-2025-02.csv"),
            ),
            (
                "f3".into(),
                "sales-2025-03.csv".into(),
                p("sales-2025-03.csv"),
            ),
            ("f4".into(), "regions.csv".into(), p("regions.csv")),
            ("f5".into(), "vendors.csv".into(), p("vendors.csv")),
        ];
        let catalog = vec![
            file_cols("f1", "sales-2025-01.csv", &["date", "region", "amount"], 3),
            file_cols("f2", "sales-2025-02.csv", &["date", "region", "amount"], 2),
            // f3 drifted (renamed column) — must split from the family.
            file_cols("f3", "sales-2025-03.csv", &["date", "area", "amount"], 1),
            file_cols("f4", "regions.csv", &["region", "label"], 1),
            // vendors shares regions' SHAPE but not its stem — no grouping.
            file_cols("f5", "vendors.csv", &["region", "label"], 1),
        ];
        let (groups, singles) = union_groups(&files, &catalog);
        assert_eq!(groups.len(), 1, "only the matching monthlies group");
        assert_eq!(groups[0].stem, "sales");
        let member_ids: Vec<&str> = groups[0]
            .members
            .iter()
            .map(|(id, _, _)| id.as_str())
            .collect();
        assert_eq!(
            member_ids,
            vec!["f1", "f2"],
            "newest first, drifted member excluded"
        );
        let single_ids: Vec<&str> = singles.iter().map(|(id, _, _)| id.as_str()).collect();
        assert!(
            single_ids.contains(&"f3") && single_ids.contains(&"f4") && single_ids.contains(&"f5")
        );
    }

    #[test]
    fn join_hints_skip_generic_columns() {
        let reg = |table: &str, cols: &[&str]| TableReg {
            table: table.into(),
            file_id: table.into(),
            file_name: format!("{table}.csv"),
            card: String::new(),
            modified_ms: None,
            columns: cols.iter().map(|s| s.to_string()).collect(),
            group: None,
        };
        let regs = vec![
            reg("tickets", &["id", "region", "priority"]),
            reg("regions", &["id", "region", "label"]),
        ];
        let hints = join_hints(&regs).expect("shared non-generic column");
        assert!(hints.contains("tickets.region = regions.region"), "{hints}");
        assert!(
            !hints.contains(".id ="),
            "generic id must not hint: {hints}"
        );
        // No shared specific columns → no block at all.
        assert!(join_hints(&[reg("a", &["x"]), reg("b", &["y"])]).is_none());
    }

    #[tokio::test]
    async fn end_to_end_union_of_monthlies() {
        let dir = std::env::temp_dir().join(format!("lh-union-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut files: Vec<(String, String, std::path::PathBuf)> = Vec::new();
        for m in 1..=12 {
            let name = format!("sales-2025-{m:02}.csv");
            let path = dir.join(&name);
            // 2 rows per month, amount = month number each → total 2*78 = 156.
            std::fs::write(&path, format!("region,amount\nNE,{m}\nNW,{m}\n")).unwrap();
            files.push((format!("m{m}"), name, path));
        }
        let lookup = dir.join("regions.csv");
        std::fs::write(&lookup, "region,label\nNE,Northeast\nNW,Northwest\n").unwrap();
        files.push(("lk".into(), "regions.csv".into(), lookup));

        let ctx = SessionContext::new();
        let regs = register_tables(&ctx, &files).await;
        let union = regs
            .iter()
            .find(|r| r.group.is_some())
            .expect("union table registered");
        assert_eq!(union.table, "sales_all");
        assert_eq!(union.group.as_ref().unwrap().file_ids.len(), 12);
        assert!(union.card.contains("unions 12 files"), "{}", union.card);
        assert!(
            regs.iter().any(|r| r.group.is_none()),
            "lookup registers as a single"
        );

        // The whole year sums across all twelve files.
        let res = run_query(&ctx, "SELECT SUM(amount) AS total FROM sales_all")
            .await
            .unwrap();
        assert!(res.markdown.contains("156"), "{}", res.markdown);

        // Join hints connect the family to the lookup on `region`.
        let hints = join_hints(&regs).expect("hints");
        assert!(
            hints.contains("sales_all.region = regions.region"),
            "{hints}"
        );

        // Freshness renders the group form.
        let fresh = freshness_line(
            &regs,
            "SELECT SUM(amount) FROM sales_all",
            crate::config::now_ms(),
        )
        .unwrap();
        assert!(fresh.contains("(12 files, newest saved"), "{fresh}");
        assert!(fresh.contains("sales*.csv"), "{fresh}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn end_to_end_csv_query_and_join_with_parquet() {
        // Fixture CSV on disk (std temp is fine for a unit test).
        let dir = std::env::temp_dir().join(format!("lh-analytics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("sales.csv");
        std::fs::write(&csv, "region,amount\nNE,100.5\nNW,200\nNE,49.5\nSE,300\n").unwrap();
        let regions = dir.join("regions.csv");
        std::fs::write(
            &regions,
            "region,label\nNE,Northeast\nNW,Northwest\nSE,Southeast\n",
        )
        .unwrap();

        let ctx = SessionContext::new();
        let files = vec![
            ("f1".to_string(), "sales.csv".to_string(), csv.clone()),
            ("f2".to_string(), "regions.csv".to_string(), regions.clone()),
        ];
        let regs = register_tables(&ctx, &files).await;
        assert_eq!(regs.len(), 2);
        assert!(regs[0].card.contains("rows"));
        // Freshly written fixtures stamp as read-just-now.
        assert!(regs.iter().all(|r| r.modified_ms.is_some()));
        let fresh = freshness_line(&regs, "SELECT * FROM sales", crate::config::now_ms()).unwrap();
        assert!(
            fresh.contains("sales.csv") && fresh.contains("just now"),
            "{fresh}"
        );
        assert!(!fresh.contains("regions.csv"), "{fresh}");

        // Write one of them back out as parquet, register, and JOIN across formats.
        let pq = dir.join("sales.parquet");
        ctx.sql("SELECT * FROM sales")
            .await
            .unwrap()
            .write_parquet(
                pq.to_str().unwrap(),
                datafusion::dataframe::DataFrameWriteOptions::new(),
                None,
            )
            .await
            .unwrap();
        ctx.register_parquet(
            "sales_pq",
            pq.to_str().unwrap(),
            ParquetReadOptions::default(),
        )
        .await
        .unwrap();

        let res = run_query(
            &ctx,
            "SELECT r.label, SUM(s.amount) AS total FROM sales_pq s JOIN regions r ON s.region = r.region GROUP BY r.label ORDER BY total DESC",
        )
        .await
        .unwrap();
        assert_eq!(res.shown, 3);
        assert!(!res.truncated);
        assert!(
            res.markdown.contains("Southeast") && res.markdown.contains("300"),
            "{}",
            res.markdown
        );
        assert!(
            res.markdown.contains("Northeast") && res.markdown.contains("150"),
            "{}",
            res.markdown
        );
        // Three labeled numeric rows chart as a bar (Phase C).
        let chart: serde_json::Value =
            serde_json::from_str(res.chart.as_deref().expect("chartable result")).unwrap();
        assert_eq!(chart["kind"], "bar");
        assert_eq!(chart["series"][0]["name"], "total");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Few-shot examples for the SQL prompt (Phase C) — the cheapest accuracy
/// lift for the local 7B, covering the common ask shapes: top-N, trend,
/// month-over-month, share-of-total, and a join. Deliberately GENERIC table/
/// column names (the prompt says to adapt them); every example must pass
/// guard_sql — pinned by a unit test so a prompt edit can't ship an example
/// the engine itself would reject.
pub const SQL_FEWSHOTS: &[(&str, &str)] = &[
    (
        "top 5 customers by total revenue",
        "SELECT customer, SUM(amount) AS total FROM orders GROUP BY customer ORDER BY total DESC LIMIT 5",
    ),
    (
        "how did monthly sales trend in 2024?",
        "SELECT substr(order_date, 1, 7) AS month, SUM(amount) AS total FROM orders WHERE substr(order_date, 1, 4) = '2024' GROUP BY month ORDER BY month",
    ),
    (
        "month-over-month change in revenue",
        "WITH m AS (SELECT substr(order_date, 1, 7) AS month, SUM(amount) AS total FROM orders GROUP BY month) SELECT month, total, total - LAG(total) OVER (ORDER BY month) AS change FROM m ORDER BY month",
    ),
    (
        "what share of total units does each region hold?",
        "SELECT region, SUM(units) AS units, ROUND(100.0 * SUM(units) / SUM(SUM(units)) OVER (), 1) AS pct FROM sales GROUP BY region ORDER BY units DESC",
    ),
    (
        "average order value per rep with their team",
        "SELECT r.team, o.rep, AVG(o.amount) AS avg_order FROM orders o JOIN reps r ON o.rep = r.rep GROUP BY r.team, o.rep ORDER BY avg_order DESC",
    ),
];

/// Prior-query context is clamped — the local model's 6144-token window pays
/// for every char of it.
const PRIOR_SQL_MAX_CHARS: usize = 800;

/// The most recent executed query in this conversation, recovered from the
/// deterministic "Query used" fence the engine itself wrote into the last
/// analytics answer (the client round-trips history, so no storage and no
/// staleness across restarts). Multi-fence answers yield the LAST fence.
pub fn last_query_used(history: &[ChatTurn]) -> Option<String> {
    for t in history.iter().rev() {
        if t.role != "assistant" || !t.content.contains("Quer") {
            continue;
        }
        if !t.content.contains("Query used") && !t.content.contains("Queries used") {
            continue;
        }
        let mut last: Option<&str> = None;
        let mut rest = t.content.as_str();
        while let Some(start) = rest.find("```sql") {
            let after = &rest[start + 6..];
            let Some(end) = after.find("```") else { break };
            let sql = after[..end].trim();
            if !sql.is_empty() {
                last = Some(sql);
            }
            rest = &after[end + 3..];
        }
        if let Some(sql) = last {
            return Some(sql.chars().take(PRIOR_SQL_MAX_CHARS).collect());
        }
    }
    None
}

/// The SQL-writing ask handed to the model (schemas ride as context blocks).
/// The reply is post-processed by extract_sql + the guard, so stray prose or
/// citation markers from the grounded system prompt are tolerated. When the
/// conversation already produced a query, it rides along so refinements
/// ("same thing but monthly") adapt it instead of starting over.
pub fn sql_question(question: &str, prior_sql: Option<&str>) -> String {
    let examples = SQL_FEWSHOTS
        .iter()
        .map(|(q, sql)| format!("Q: {q}\nSQL: {sql}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prior = prior_sql
        .map(|s| {
            format!(
                "\nPrevious query from this conversation — if the question \
                 refines it, adapt this SQL instead of starting over:\n```sql\n{s}\n```\n"
            )
        })
        .unwrap_or_default();
    format!(
        "You are writing ONE SQL query for DataFusion (PostgreSQL-style syntax). \
         The numbered context blocks describe the available tables: their exact \
         table names, columns with types, row counts, and a few sample rows. \
         Write a single SELECT statement that answers the question below from \
         those tables (JOINs across tables are fine). Reply with ONLY the SQL \
         in a ```sql code block — no explanation. Use the exact table and \
         column names as given.\n\n\
         Examples with a GENERIC schema — adapt the table and column names to \
         the tables described in the context blocks:\n{examples}\n{prior}\n\
         Question: {question}"
    )
}

// --- Multi-step analytics (openspec: add-multi-step-analytics) --------------------
//
// Comparison/why questions on a keyed REMOTE provider may run up to three
// sequential verified queries. The cue below gates entry (multi-step costs
// latency and must be earned); the step prompt + reply parser keep every
// number engine-computed. Local models never enter — their 6144-token window
// can't carry multi-step context (synth.rs enforces the gate).

const MULTI_STEP_WORDS: &[&str] = &[
    "compare",
    "compared",
    "comparing",
    "versus",
    "vs",
    "difference",
    "differences",
    "why",
    "driver",
    "drivers",
    "explain",
    "explains",
    "explained",
];
const MULTI_STEP_PHRASES: &[&str] = &[
    "what caused",
    "change between",
    "breakdown of the change",
    "changed between",
];

/// Whether an analytics question ALSO reads as a comparison/explanation ask —
/// the entry gate for the bounded multi-step loop. Same normalization as
/// `analytics_cue`; single-cue questions keep the single-query path.
pub fn multi_step_cue(question: &str) -> bool {
    if !analytics_cue(question) {
        return false;
    }
    let lower = question.to_lowercase();
    let mut norm = String::with_capacity(lower.len());
    let mut last_space = true;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            norm.push(ch);
            last_space = false;
        } else if !last_space {
            norm.push(' ');
            last_space = true;
        }
    }
    let padded = format!(" {} ", norm.trim());
    for p in MULTI_STEP_PHRASES {
        if padded.contains(&format!(" {p} ")) {
            return true;
        }
    }
    padded.split(' ').any(|t| MULTI_STEP_WORDS.contains(&t))
}

/// One executed step: its SQL and the (narration-capped) verified result.
#[derive(Debug, Clone)]
pub struct StepRecord {
    pub sql: String,
    pub result_markdown: String,
}

/// The model's answer to "do you need another query?".
#[derive(Debug, PartialEq)]
pub enum StepReply {
    Sql(String),
    Done,
}

/// Parse a step reply: `NEXT_SQL:` + one SELECT (fenced or bare) ⇒ Sql;
/// an explicit DONE — or anything unparseable — ⇒ Done, so a confused model
/// ends the loop instead of derailing it.
pub fn parse_step_reply(raw: &str) -> StepReply {
    let cleaned = raw.trim();
    if cleaned.to_uppercase().starts_with("DONE") {
        return StepReply::Done;
    }
    match extract_sql(cleaned) {
        Some(sql) => StepReply::Sql(sql),
        None => StepReply::Done,
    }
}

/// Per prior step, chars of result carried into the next step's prompt.
const STEP_RESULT_CAP: usize = 1200;

/// The iterative step ask: original question + every completed step's SQL and
/// capped result. Schema cards ride as context blocks (not in this string).
/// Budget: ≤ ~8k chars at the 3-step maximum — comfortably inside every
/// remote window (unit-tested).
pub fn step_question(question: &str, steps: &[StepRecord]) -> String {
    let prior = if steps.is_empty() {
        " (none yet)".to_string()
    } else {
        let mut out = String::new();
        for (i, s) in steps.iter().enumerate() {
            let capped: String = s.result_markdown.chars().take(STEP_RESULT_CAP).collect();
            out.push_str(&format!(
                "\n\nStep {n} SQL:\n{sql}\nStep {n} result:\n{capped}",
                n = i + 1,
                sql = s.sql,
            ));
        }
        out
    };
    format!(
        "You are running a multi-step analysis over the user's tables to answer \
         one question. The table schemas are in the context blocks. You may run \
         up to 3 SQL queries total, one at a time.\n\
         Completed steps so far:{prior}\n\n\
         If one more query would materially improve the answer, reply with exactly:\n\
         NEXT_SQL:\n```sql\n<one single SELECT statement>\n```\n\
         Otherwise reply with exactly: DONE\n\n\
         Rules: one SELECT per step, no other statements; use the exact table and \
         column names from the context blocks; prefer a query that builds on what \
         the previous steps showed.\n\n\
         Question: {question}"
    )
}

/// Everything a deterministic re-execution answers with: the (narration-
/// capped) result table, the chart when chartable, and the standard
/// provenance footer. `result_digest` covers the FULL execution-capped
/// result — pin change detection compares it.
#[derive(Debug)]
pub struct DirectResult {
    pub markdown: String,
    pub chart: Option<String>,
    pub footer: String,
    pub result_digest: String,
}

/// Resolve an answer's file ids and register them as tables — the shared
/// front half of every direct (model-free) execution. Ids that are unknown,
/// no longer tabular, or NO LONGER VISIBLE TO AI are skipped and counted so
/// callers can note them in the footer: exclusion binds here exactly like it
/// does in the ask pipeline — a stale answer's meta (or a pin) can't keep
/// reading a file the user has since hidden.
async fn direct_tables(
    file_ids: &[String],
) -> Result<(SessionContext, Vec<TableReg>, usize), String> {
    let active: std::collections::HashSet<String> = crate::vault::active_included_file_ids()
        .into_iter()
        .collect();
    let mut files: Vec<(String, String, PathBuf)> = Vec::new();
    let mut skipped = 0usize;
    for id in file_ids {
        if !active.contains(id) {
            skipped += 1;
            continue;
        }
        match crate::vault::doc_path(id) {
            Some((name, abs)) if is_tabular(&name) || is_pdf(&name) => {
                files.push((id.clone(), name, abs))
            }
            _ => skipped += 1,
        }
    }
    if files.is_empty() {
        return Err("none of the answer's files are available anymore".to_string());
    }
    let ctx = SessionContext::new();
    let regs = register_tables(&ctx, &files).await;
    if regs.is_empty() {
        return Err("the files couldn't be registered as tables".to_string());
    }
    Ok((ctx, regs, skipped))
}

/// A grouped-thousands integer: 12431 → "12,431" — read-out friendly for the
/// truncation footer.
fn commafy(n: usize) -> String {
    let s = n.to_string();
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in b.iter().enumerate() {
        // (len - i) % 3 == 0 marks a thousands boundary. Not `.is_multiple_of`
        // (stabilized only in 1.87) so the crate builds on older CI toolchains.
        if i > 0 && (b.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out
}

/// Deterministic "first N of TOTAL rows" disclosure when a result was capped —
/// never model-generated. `None` when the result wasn't truncated. Drives the
/// answer + footer honesty on both the ask path and the model-free re-exec path.
pub fn truncation_footer(shown: usize, truncated: bool, total: Option<usize>) -> Option<String> {
    if !truncated {
        return None;
    }
    Some(match total {
        Some(t) => format!(
            "_Showing the first {} of {} rows._\n",
            commafy(shown),
            commafy(t)
        ),
        None => {
            format!(
                "_Showing the first {} rows; the full result is larger._\n",
                commafy(shown)
            )
        }
    })
}

fn direct_footer(sql: &str, regs: &[TableReg], skipped: usize, res: &QueryResult) -> String {
    let mut footer = format!("*Query used:*\n```sql\n{sql}\n```\n");
    if let Some(fresh) = freshness_line(regs, sql, crate::config::now_ms()) {
        footer.push_str(&fresh);
    }
    if let Some(trunc) = truncation_footer(res.shown, res.truncated, res.total) {
        footer.push_str(&trunc);
    }
    if skipped > 0 {
        footer.push_str(&format!(
            "_(skipped {skipped} file(s) no longer available to AI)_\n"
        ));
    }
    footer
}

/// Re-run an answer's SQL against exactly the files it read — the guarded,
/// model-free path behind Edit SQL, Save-as-CSV, and pin rechecks. Unknown /
/// no-longer-tabular ids are skipped and noted in the footer.
pub async fn run_direct(sql: &str, file_ids: &[String]) -> Result<DirectResult, String> {
    let (ctx, regs, skipped) = direct_tables(file_ids).await?;
    let res = run_query(&ctx, sql).await?;
    let footer = direct_footer(sql, &regs, skipped, &res);
    Ok(DirectResult {
        markdown: res.markdown,
        chart: res.chart,
        footer,
        result_digest: res.digest,
    })
}

/// Save-path row cap: full-fidelity export, bounded sanely (the narration
/// caps stay much smaller — openspec: add-answer-artifacts, design §1).
pub const SAVE_MAX_ROWS: usize = 100_000;

/// RFC-4180 CSV (quote-doubling, CRLF record separators) from record batches,
/// capped at `max_rows` data rows. Returns (bytes, data_row_count). NULLs
/// render empty.
pub fn batches_to_csv(batches: &[RecordBatch], max_rows: usize) -> (Vec<u8>, usize) {
    fn field(s: &str) -> String {
        if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    }
    let Some(first) = batches.iter().find(|b| b.num_columns() > 0) else {
        return (Vec::new(), 0);
    };
    let mut out = String::new();
    let header: Vec<String> = first
        .schema()
        .fields()
        .iter()
        .map(|f| field(f.name()))
        .collect();
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    let mut rows = 0usize;
    'outer: for b in batches {
        for row in 0..b.num_rows() {
            if rows >= max_rows {
                break 'outer;
            }
            let mut cells: Vec<String> = Vec::with_capacity(b.num_columns());
            for c in 0..b.num_columns() {
                let col = b.column(c);
                let v = if col.is_null(row) {
                    String::new()
                } else {
                    array_value_to_string(col, row).unwrap_or_default()
                };
                cells.push(field(&v));
            }
            out.push_str(&cells.join(","));
            out.push_str("\r\n");
            rows += 1;
        }
    }
    (out.into_bytes(), rows)
}

/// What "Save as CSV" wrote: an ordinary vault file the watcher ingests.
#[derive(Debug)]
pub struct SavedResult {
    pub id: String,
    pub name: String,
    pub rows: usize,
}

/// The save path behind "Save as CSV": one registration, then the normal
/// narration-capped preview PLUS a full-fidelity execution (SAVE_MAX_ROWS)
/// written as RFC-4180 CSV into `Lighthouse Results/` — where it becomes
/// queryable input like any other file. Never overwrites (collision suffix).
pub async fn run_direct_save(
    sql: &str,
    file_ids: &[String],
    name_hint: &str,
) -> Result<(DirectResult, SavedResult), String> {
    let (ctx, regs, skipped) = direct_tables(file_ids).await?;
    let res = run_query(&ctx, sql).await?; // guard + preview + chart
    let df = ctx.sql(sql).await.map_err(|e| e.to_string())?;
    let df = df
        .limit(0, Some(SAVE_MAX_ROWS))
        .map_err(|e| e.to_string())?;
    let batches = tokio::time::timeout(Duration::from_secs(QUERY_TIMEOUT_SECS), df.collect())
        .await
        .map_err(|_| format!("query exceeded {QUERY_TIMEOUT_SECS}s"))?
        .map_err(|e| e.to_string())?;
    let (bytes, rows) = batches_to_csv(&batches, SAVE_MAX_ROWS);
    if rows == 0 {
        return Err("the query returned no rows".into());
    }
    let hint = name_hint.to_string();
    let (id, name) = tokio::task::spawn_blocking(move || {
        crate::vault::write_artifact("Lighthouse Results", &hint, "csv", &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let footer = direct_footer(sql, &regs, skipped, &res);
    Ok((
        DirectResult {
            markdown: res.markdown,
            chart: res.chart,
            footer,
            result_digest: res.digest,
        },
        SavedResult { id, name, rows },
    ))
}

/// Regression tests for the Genie v3 correctness audit (openspec:
/// add-analytics-eval-floor). Each asserts a fix that fails without it.
#[cfg(test)]
mod g1_regression {
    use super::*;
    use datafusion::arrow::array::Array; // is_null / value on downcast arrays

    fn fc(
        id: &str,
        name: &str,
        cols: &[(&str, crate::catalog::ColumnKind)],
        ms: i64,
    ) -> crate::catalog::FileColumns {
        crate::catalog::FileColumns {
            id: id.into(),
            name: name.into(),
            columns: cols
                .iter()
                .map(|(n, k)| crate::catalog::Column {
                    name: (*n).to_string(),
                    kind: *k,
                })
                .collect(),
            modified_ms: ms,
        }
    }
    fn treg(table: &str, id: &str, cols: &[&str]) -> TableReg {
        TableReg {
            table: table.into(),
            file_id: id.into(),
            file_name: format!("{id}.csv"),
            card: String::new(),
            modified_ms: None,
            columns: cols.iter().map(|s| s.to_string()).collect(),
            group: None,
        }
    }

    // --- A1/A2: read-only guard closes SELECT INTO + modifying CTE ---
    #[test]
    fn guard_rejects_select_into_and_modifying_bodies() {
        // SELECT … INTO runs a CreateMemoryTable DDL (dodges timeout+cap).
        assert!(guard_sql("SELECT * INTO exfil FROM sales").is_err());
        assert!(guard_sql("SELECT a INTO t FROM x WHERE a > 1").is_err());
        // Data-modifying CTE / query body wrapped inside a Query.
        assert!(
            guard_sql("WITH t AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM t").is_err()
        );
        assert!(guard_sql("WITH x AS (SELECT 1) INSERT INTO t VALUES (1)").is_err());
        // Genuine read-only shapes still pass (no over-rejection).
        assert!(guard_sql("SELECT 1").is_ok());
        assert!(guard_sql("WITH c AS (SELECT 1 AS a) SELECT a FROM c").is_ok());
        assert!(guard_sql("SELECT 1 UNION ALL SELECT 2").is_ok());
        assert!(
            guard_sql("SELECT * FROM (SELECT region, SUM(x) AS s FROM t GROUP BY region) q")
                .is_ok()
        );
        assert!(guard_sql("SELECT * FROM t WHERE id IN (SELECT id FROM u)").is_ok());
    }

    // --- D1: a truncated result reports its TRUE total, not the cap ---
    #[tokio::test]
    async fn truncation_reports_true_total_not_the_cap() {
        let n = 250usize;
        let labels: Vec<String> = (0..n).map(|i| format!("r{i}")).collect();
        let schema = Arc::new(Schema::new(vec![
            Field::new("label", DataType::Utf8, false),
            Field::new("v", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(StringArray::from(
                    labels.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
                Arc::new(Float64Array::from(
                    (0..n).map(|i| i as f64).collect::<Vec<_>>(),
                )),
            ],
        )
        .unwrap();
        let ctx = SessionContext::new();
        ctx.register_table(
            "big",
            Arc::new(MemTable::try_new(schema, vec![vec![batch]]).unwrap()),
        )
        .unwrap();

        let res = run_query(&ctx, "SELECT label, v FROM big").await.unwrap();
        assert!(res.truncated);
        assert_eq!(res.shown, MAX_RESULT_ROWS);
        assert_eq!(res.total, Some(250)); // counted from the uncapped plan
        assert!(
            res.markdown.contains("250"),
            "note must name the true total: {}",
            res.markdown
        );
        assert!(!res.markdown.contains("200 total"));
        assert!(!res.markdown.contains("tell the user")); // neutral (human-visible)
        assert_eq!(
            truncation_footer(res.shown, res.truncated, res.total).as_deref(),
            Some("_Showing the first 200 of 250 rows._\n")
        );
        assert!(res.chart.is_none()); // never chart a truncated result
    }

    // --- D2: dropped columns past the 24-col cap are disclosed ---
    #[tokio::test]
    async fn wide_result_notes_dropped_columns() {
        let n = 30usize;
        let fields: Vec<Field> = (0..n)
            .map(|i| Field::new(format!("c{i}"), DataType::Float64, true))
            .collect();
        let cols: Vec<ArrayRef> = (0..n)
            .map(|_| Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])) as ArrayRef)
            .collect();
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
        let ctx = SessionContext::new();
        ctx.register_table(
            "wide",
            Arc::new(MemTable::try_new(schema, vec![vec![batch]]).unwrap()),
        )
        .unwrap();
        let res = run_query(&ctx, "SELECT * FROM wide").await.unwrap();
        assert!(
            res.markdown.contains("24 of 30 columns"),
            "{}",
            res.markdown
        );
    }

    // --- F2: a NaN/inf sentinel becomes NULL, not a poisoned aggregate ---
    #[test]
    fn nan_sentinel_becomes_null_keeps_column_numeric() {
        let headers = vec!["region".to_string(), "ratio".to_string()];
        let data = vec![
            vec!["NE".to_string(), "1.5".to_string()],
            vec!["NW".to_string(), "2.0".to_string()],
            vec!["SE".to_string(), "NaN".to_string()],
            vec!["NE".to_string(), "3.0".to_string()],
        ];
        let (schema, batch) = table_from_matrix(&headers, &data).unwrap();
        assert_eq!(schema.field(1).data_type(), &DataType::Float64);
        let col = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        assert!(col.is_null(2), "the NaN cell must be NULL");
        let sum: f64 = (0..col.len())
            .filter(|&i| !col.is_null(i))
            .map(|i| col.value(i))
            .sum();
        assert_eq!(sum, 6.5);
    }

    // --- F1: date-ish serial column → ISO; a measure in range stays numeric ---
    #[test]
    fn excel_serial_dates_render_iso_but_measures_stay_numeric() {
        let headers = vec!["order_date".to_string(), "amount".to_string()];
        let data = vec![
            vec!["45658".to_string(), "100".to_string()], // 2025-01-01
            vec!["45689".to_string(), "200".to_string()],
            vec!["45658".to_string(), "300".to_string()],
        ];
        let (schema, batch) = table_from_matrix(&headers, &data).unwrap();
        assert_eq!(
            schema.field(0).data_type(),
            &DataType::Utf8,
            "serial dates → text"
        );
        let d = batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        assert_eq!(d.value(0), "2025-01-01");
        assert_eq!(
            schema.field(1).data_type(),
            &DataType::Float64,
            "amount stays numeric"
        );

        // A money column of serial-range values under a NON-date header must
        // NOT be reinterpreted as dates.
        let h2 = vec!["salary".to_string(), "n".to_string()];
        let d2 = vec![
            vec!["45000".to_string(), "1".to_string()],
            vec!["52000".to_string(), "2".to_string()],
            vec!["48000".to_string(), "3".to_string()],
        ];
        let (s2, _) = table_from_matrix(&h2, &d2).unwrap();
        assert_eq!(
            s2.field(0).data_type(),
            &DataType::Float64,
            "money must stay numeric"
        );
    }

    // --- C3: table-name dedup can't overwrite a registered table ---
    #[test]
    fn unique_table_name_avoids_collisions() {
        assert_eq!(unique_table_name("foo", &[]), "foo");
        assert_eq!(unique_table_name("foo", &["foo".into()]), "foo_2");
        // The old `used.len()+1` guess would land on the existing foo_3.
        let used = vec!["foo".to_string(), "foo_2".to_string(), "foo_3".to_string()];
        assert_eq!(unique_table_name("foo", &used), "foo_4");
    }

    // --- C6: generic/enum/col_N columns don't emit join hints ---
    #[test]
    fn join_hints_skip_status_and_col_n() {
        let regs = vec![
            treg("orders", "orders", &["region", "status", "col_3"]),
            treg("emps", "emps", &["region", "status", "col_3"]),
        ];
        let hints = join_hints(&regs).unwrap();
        assert!(hints.contains("orders.region = emps.region"));
        assert!(!hints.contains("status"), "{hints}");
        assert!(!hints.contains("col_3"), "{hints}");
    }

    // --- C4: differing column kind, or a single-letter stem, split a family ---
    #[test]
    fn union_splits_on_kind_and_short_stem() {
        use crate::catalog::ColumnKind::{Numeric, Text};
        let p = |n: &str| PathBuf::from(format!("/v/{n}"));
        let files = vec![
            (
                "a".to_string(),
                "sales-01.csv".to_string(),
                p("sales-01.csv"),
            ),
            (
                "b".to_string(),
                "sales-02.csv".to_string(),
                p("sales-02.csv"),
            ),
        ];
        // Same names + same stem, but "amount" is numeric in one, text in the
        // other → different kind signature → must NOT union into one table.
        let catalog = vec![
            fc(
                "a",
                "sales-01.csv",
                &[("region", Text), ("amount", Numeric)],
                2,
            ),
            fc(
                "b",
                "sales-02.csv",
                &[("region", Text), ("amount", Text)],
                1,
            ),
        ];
        let (groups, singles) = union_groups(&files, &catalog);
        assert!(groups.is_empty(), "differing column kind must split");
        assert_eq!(singles.len(), 2);

        // Single-letter stem (q1/q2 → "q") never groups, even with identical sig.
        let qf = vec![
            ("x".to_string(), "q1.csv".to_string(), p("q1.csv")),
            ("y".to_string(), "q2.csv".to_string(), p("q2.csv")),
        ];
        let qc = vec![
            fc("x", "q1.csv", &[("id", Text), ("value", Numeric)], 1),
            fc("y", "q2.csv", &[("id", Text), ("value", Numeric)], 1),
        ];
        assert!(
            union_groups(&qf, &qc).0.is_empty(),
            "single-letter stem must not union"
        );
    }

    // --- C1: files dropped by the table caps are counted for disclosure ---
    #[test]
    fn unregistered_count_flags_capped_files() {
        let files = vec![
            (
                "a".to_string(),
                "a.csv".to_string(),
                PathBuf::from("/v/a.csv"),
            ),
            (
                "b".to_string(),
                "b.csv".to_string(),
                PathBuf::from("/v/b.csv"),
            ),
            (
                "c".to_string(),
                "c.csv".to_string(),
                PathBuf::from("/v/c.csv"),
            ),
        ];
        assert_eq!(unregistered_count(&files, &[treg("a", "a", &[])]), 2);
        // A grouped reg represents all its member ids.
        let grouped = vec![TableReg {
            group: Some(GroupMeta {
                file_ids: vec!["a".into(), "b".into(), "c".into()],
                file_names: vec![],
                newest_ms: 0,
            }),
            ..treg("all", "a", &[])
        }];
        assert_eq!(unregistered_count(&files, &grouped), 0);
    }

    // --- C2: a data row never displaces an earlier all-textual header ---
    #[test]
    fn header_detection_never_promotes_a_data_row() {
        let rows = |rs: &[&[&str]]| -> Vec<Vec<String>> {
            rs.iter()
                .map(|r| r.iter().map(|s| s.to_string()).collect())
                .collect()
        };
        // Real header with a trailing blank; the first data row is wider and
        // partly numeric — it used to win (score = textual + distinct), dropping
        // the first record and mislabeling every column.
        let sheet = rows(&[
            &["id", "name", ""],
            &["1", "Bob", "active"],
            &["2", "Sue", "off"],
        ]);
        assert_eq!(detect_header_row(&sheet), 0);
    }
}

// G3 — a PDF's confident text-layer grid becomes a real queryable table
// (openspec: add-queryable-pdf-tables). The glyph→grid geometry is proven in
// `pdf_tables`; here we prove the analytics half: that a reconstructed `Table`
// types and registers exactly like a spreadsheet sheet, so the model queries it
// with the same trust invariant (schema-only read, one SELECT, engine math).
#[cfg(test)]
mod g3_pdf_queryable {
    use super::*;
    use crate::pdf_tables::Table;

    fn grid(header_like: bool, rows: &[&[&str]]) -> Table {
        Table {
            header_like,
            rows: rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect(),
        }
    }

    // A reconstructed grid registers as a typed MemTable and the ENGINE — never
    // the model — computes the aggregate. Numeric columns type as Float64 so
    // SUM/AVG are real arithmetic, not string concatenation.
    #[tokio::test]
    async fn reconstructed_grid_is_queried_by_the_engine() {
        let g = grid(
            true,
            &[
                &["region", "q2", "q3"],
                &["ne", "120", "150"],
                &["se", "300", "480"],
                &["nw", "90", "110"],
            ],
        );
        let ctx = SessionContext::new();
        let name = register_grid(&ctx, "pdf_report", &g).expect("a 3×3 named grid registers");
        assert_eq!(name, "pdf_report");

        // q3 must be Float64 — otherwise the aggregate below is nonsense.
        let batches = ctx
            .sql("SELECT region, q3 FROM pdf_report")
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        assert_eq!(
            batches[0].schema().field_with_name("q3").unwrap().data_type(),
            &DataType::Float64,
            "an all-numeric column types as Float64, not text",
        );

        // The number in the answer is DataFusion's, computed over the grid.
        let res = run_query(&ctx, "SELECT SUM(q3) AS total FROM pdf_report").await.unwrap();
        assert!(res.markdown.contains("740"), "150+480+110=740: {}", res.markdown);
    }

    // The typing path enforces its own floor: a grid with a header but only one
    // data row (data.len() < 2) registers nothing, even if it slipped past the
    // upstream gate. Defense in depth against a degenerate reconstruction.
    #[test]
    fn a_single_data_row_grid_registers_nothing() {
        let g = grid(true, &[&["a", "b"], &["1", "2"]]);
        let ctx = SessionContext::new();
        assert!(register_grid(&ctx, "thin", &g).is_none());
    }

    // A one-column grid can't be registered: <2 headers after sanitize.
    #[test]
    fn a_single_column_grid_registers_nothing() {
        let g = grid(true, &[&["only"], &["x"], &["y"], &["z"]]);
        let ctx = SessionContext::new();
        assert!(register_grid(&ctx, "narrow", &g).is_none());
    }

    // End-to-end no-false-positive: prose / non-PDF bytes reconstruct no grid,
    // so a prose PDF costs a bounded parse and registers no table. This exercises
    // the real extract path (panic-guarded, lopdf rejects non-PDF input).
    #[test]
    fn prose_bytes_yield_no_queryable_table() {
        let tables = crate::pdf_tables::queryable_tables(b"not a pdf, just prose bytes");
        assert!(tables.is_empty(), "no grid from non-tabular bytes");
    }
}
