//! Ask-your-data analytics (docs/analytics-beam.md, Phase A).
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
    /// Rows actually registered when the source sheet holds MORE than the
    /// engine's row cap (materialized xlsx/xls sheets only — path-registered
    /// CSV/TSV/Parquet stream in full and never cap). None = full coverage.
    /// Drives the leading card note and the deterministic answer footer.
    /// Union-family omissions are whole-member drops disclosed via `group`
    /// (card note + coverage footer), so a grouped reg never sets this.
    pub capped_rows: Option<usize>,
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
pub(crate) fn unique_table_name(base: &str, used: &[String]) -> String {
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
    is_cloud: bool,
) -> Vec<TableReg> {
    // Belt-and-suspenders (openspec: add-local-only-marks) at the highest-
    // leakage path: schema cards carry column names, types, and three sample
    // rows straight into a cloud prompt. The analytics candidate gather already
    // passes only shareable ids, but re-drop any effectively-local-only file
    // HERE so a private table's columns/samples can never reach a vendor even if
    // a future caller forgets the gate. No-op on the device path (is_cloud
    // false) and for the model-free direct-SQL path, which sets it false.
    let filtered: Vec<(String, String, PathBuf)>;
    let files: &[(String, String, PathBuf)] = if is_cloud {
        let keep: std::collections::HashSet<String> = crate::vault::shareable_subset(
            &files.iter().map(|(id, _, _)| id.clone()).collect::<Vec<_>>(),
            true,
        )
        .into_iter()
        .collect();
        filtered = files.iter().filter(|(id, _, _)| keep.contains(id)).cloned().collect();
        &filtered
    } else {
        files
    };
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
        // (table name, rows registered when the sheet was row-capped). Only
        // materialized workbook sheets can cap; the streamed formats never do.
        let registered: Vec<(String, Option<usize>)> = if lower.ends_with(".csv")
            || lower.ends_with(".tsv")
        {
            let delim = if lower.ends_with(".tsv") { b'\t' } else { b',' };
            let opts = CsvReadOptions::new().delimiter(delim);
            match ctx.register_csv(&base, &path, opts).await {
                Ok(()) => vec![(base.clone(), None)],
                Err(_) => vec![],
            }
        } else if lower.ends_with(".parquet") {
            match ctx
                .register_parquet(&base, &path, ParquetReadOptions::default())
                .await
            {
                Ok(()) => vec![(base.clone(), None)],
                Err(_) => vec![],
            }
        } else if is_pdf(&lower) {
            register_pdf(ctx, &base, &abs)
                .await
                .into_iter()
                .map(|t| (t, None))
                .collect()
        } else {
            register_workbook(ctx, &base, &abs)
        };
        let mut any = false;
        for (table, capped_rows) in registered {
            if regs.len() >= MAX_TABLES_TOTAL {
                break;
            }
            if let Some((card, columns)) = table_card(ctx, &table).await {
                // A row-capped sheet must never read as the whole file: lead
                // the card with the cap (same survives-clipping rationale as
                // the union provenance line) so the model can't claim
                // full-file totals over a truncated registration.
                let card = match capped_rows {
                    Some(n) => format!(
                        "{table} — row cap: only the first {} rows of {name} are included\n{card}",
                        commafy(n)
                    ),
                    None => card,
                };
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
                    capped_rows,
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

// --- Saved views (openspec: add-shaped-views §2) -----------------------------------

/// One saved view registered into an ask's context, and the card the model
/// plans against. `source_file_ids` / `source_tables` are the view's
/// TRANSITIVE sources — every underlying file id, and the ambient table name
/// its covering registration carries — deduped, reads order: the freshness
/// expansion (`expand_views_for_freshness`) leans on `source_tables` so the
/// provenance footer keeps naming real files, never the view.
#[derive(Debug, Clone)]
pub struct ViewReg {
    pub name: String,
    /// View-marked table card (summary line + the standard schema/sample
    /// body), ready for a prompt block like `TableReg::card`.
    pub card: String,
    /// Lowercased column names of the view's result. NOT fed to `join_hints`
    /// (hints are file-level heuristics); carried for later surfaces.
    pub columns: Vec<String>,
    pub source_file_ids: Vec<String>,
    pub source_tables: Vec<String>,
    /// The stored one-line summary text (provenance label stays in the store).
    pub summary: String,
}

/// Register every ELIGIBLE saved view into `ctx` as a virtual table, AFTER
/// ordinary file registration (design.md "Virtual resolution at ask time").
/// Store (creation) order is the pass order — it IS topological for
/// view-over-view, because a definition can only reference views that already
/// existed at its save. A view registers when its transitive source files are
/// all covered by `regs`, every view it reads registered earlier THIS pass,
/// its stored name bindings resolve (aliasing the SAME provider under the
/// stored name when ambient registration named a source differently — files
/// and earlier registrations always win a collision), and a table slot
/// remains under the shared `MAX_TABLES_TOTAL` accounting. Execution is the
/// exact CSV-union primitive — re-`guard_sql`, `ctx.sql(&view.sql)`,
/// `register_table(name, df.into_view())` — so no rows ever land on disk and
/// results always reflect the sources' current bytes. On cloud asks an
/// effectively-local-only view is ineligible (transitive mark propagation).
/// ANY failure skips that view with a log line; an ask never fails because a
/// view is broken. Zero saved views ⇒ an empty return and a byte-identical
/// ask.
pub async fn register_views(
    ctx: &SessionContext,
    regs: &[TableReg],
    is_cloud: bool,
) -> Vec<ViewReg> {
    let mut out: Vec<ViewReg> = Vec::new();
    if regs.is_empty() {
        return out;
    }
    // The store read + per-file vault-state checks are blocking work — keep
    // them off the runtime thread (the catalog pass above sets the pattern).
    let views =
        tokio::task::spawn_blocking(move || crate::views::eligible_for_posture(is_cloud))
            .await
            .unwrap_or_default();
    if views.is_empty() {
        return out;
    }
    // A reg covers file X when it IS X or its union family includes X.
    let covering = |file_id: &str| -> Option<&TableReg> {
        regs.iter().find(|r| {
            r.file_id == file_id
                || r.group
                    .as_ref()
                    .is_some_and(|g| g.file_ids.iter().any(|id| id == file_id))
        })
    };
    // view id → its resolved transitive source files, for every view
    // registered THIS pass: a child's eligibility and provenance build on it.
    let mut registered: std::collections::HashMap<String, Vec<crate::views::FileRead>> =
        std::collections::HashMap::new();
    // Aliases this pass created: stored name → the ambient table it points at.
    let mut aliased: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    'views: for v in &views {
        // Slot cap: views share the file tables' MAX_TABLES_TOTAL accounting
        // (mirrors register_tables' guard). The cap can only stay hit, so the
        // remaining creation-order views all skip — never an error.
        if regs.len() + out.len() >= MAX_TABLES_TOTAL {
            eprintln!(
                "[views] table cap reached — skipping \"{}\" and any later views",
                v.name
            );
            break;
        }
        // Eligibility: every view it reads registered this pass (each parent
        // already carried ITS transitive files, so induction covers the whole
        // tree)…
        let mut files: Vec<crate::views::FileRead> = Vec::new();
        for f in &v.reads.files {
            if !files.iter().any(|k| k.file_id == f.file_id) {
                files.push(f.clone());
            }
        }
        for pid in &v.reads.views {
            let Some(parent_files) = registered.get(pid) else {
                eprintln!(
                    "[views] skipping \"{}\": a view it reads is not registered for this ask",
                    v.name
                );
                continue 'views;
            };
            for f in parent_files {
                if !files.iter().any(|k| k.file_id == f.file_id) {
                    files.push(f.clone());
                }
            }
        }
        // …and every transitive source file covered by a registration (this
        // composes with investigation scope and managed policy for free:
        // out-of-scope sources were never registered).
        if files.iter().any(|f| covering(&f.file_id).is_none()) {
            eprintln!(
                "[views] skipping \"{}\": a source file is not registered for this ask",
                v.name
            );
            continue;
        }
        // Files win a name collision: the view's own name must be free
        // (save-time refusal makes this rare, but ambient collisions happen).
        if ctx.table_exist(v.name.as_str()).unwrap_or(true) {
            eprintln!(
                "[views] skipping \"{}\": a table by that name is already registered",
                v.name
            );
            continue;
        }
        // Name bindings: the definition's SQL uses the table names pinned at
        // save. When ambient registration named a source differently, register
        // the SAME provider under the stored name; a stored name already bound
        // to a DIFFERENT table skips the view — files and earlier
        // registrations win.
        for f in &v.reads.files {
            let Some(reg) = covering(&f.file_id) else {
                continue; // unreachable — coverage checked above
            };
            if reg.table == f.table_name {
                continue;
            }
            match aliased.get(&f.table_name) {
                // An earlier view already aliased this name to the same table.
                Some(target) if *target == reg.table => continue,
                Some(_) => {
                    eprintln!(
                        "[views] skipping \"{}\": \"{}\" is already bound to another table",
                        v.name, f.table_name
                    );
                    continue 'views;
                }
                None => {}
            }
            if ctx.table_exist(f.table_name.as_str()).unwrap_or(true) {
                eprintln!(
                    "[views] skipping \"{}\": \"{}\" is already bound to another table",
                    v.name, f.table_name
                );
                continue 'views;
            }
            let provider = match ctx.table_provider(reg.table.as_str()).await {
                Ok(p) => p,
                Err(err) => {
                    eprintln!("[views] skipping \"{}\": {err}", v.name);
                    continue 'views;
                }
            };
            if let Err(err) = ctx.register_table(f.table_name.as_str(), provider) {
                eprintln!("[views] skipping \"{}\": {err}", v.name);
                continue 'views;
            }
            aliased.insert(f.table_name.clone(), reg.table.clone());
        }
        // Defense in depth: the SAME guard as save time, before every
        // execution — a hand-edited views.json can't smuggle a write.
        if let Err(err) = guard_sql(&v.sql) {
            eprintln!("[views] skipping \"{}\": {err}", v.name);
            continue;
        }
        // Execute the definition and register the result virtually — the
        // exact CSV-union primitive. Rows never materialize to disk.
        let df = match ctx.sql(&v.sql).await {
            Ok(df) => df,
            Err(err) => {
                eprintln!("[views] skipping \"{}\": {err}", v.name);
                continue;
            }
        };
        if let Err(err) = ctx.register_table(v.name.as_str(), df.into_view()) {
            eprintln!("[views] skipping \"{}\": {err}", v.name);
            continue;
        }
        let Some((body, columns)) = table_card(ctx, &v.name).await else {
            eprintln!(
                "[views] skipping \"{}\": could not build its table card",
                v.name
            );
            continue;
        };
        // The card leads with the view-ness and its meaning (survives-clipping
        // rationale, like the union provenance line), then the standard body.
        let summary = v.summary.text.trim();
        let card = if summary.is_empty() {
            format!("{} is a saved view\n{}", v.name, body)
        } else {
            format!("{} is a saved view — {}\n{}", v.name, summary, body)
        };
        let source_file_ids: Vec<String> = files.iter().map(|f| f.file_id.clone()).collect();
        let mut source_tables: Vec<String> = Vec::new();
        for f in &files {
            if let Some(reg) = covering(&f.file_id) {
                if !source_tables.iter().any(|t| t == &reg.table) {
                    source_tables.push(reg.table.clone());
                }
            }
        }
        registered.insert(v.id.clone(), files);
        out.push(ViewReg {
            name: v.name.clone(),
            card,
            columns,
            source_file_ids,
            source_tables,
            summary: v.summary.text.clone(),
        });
    }
    out
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
        // Union row-cap omissions drop whole members and are disclosed above
        // (card note) + by the coverage footer — never via `capped_rows`.
        capped_rows: None,
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
/// Float64 with nulls, else Utf8). Returns the registered table names, each
/// with `Some(rows_registered)` when the sheet held more data rows than
/// MAX_XLSX_ROWS — the caller turns that into the card note + answer footer,
/// so the cap is never silent.
fn register_workbook(
    ctx: &SessionContext,
    base: &str,
    abs: &PathBuf,
) -> Vec<(String, Option<usize>)> {
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
        // The sheet's full used-range row count — compared against what the
        // bounded reads below actually kept, to detect a row-capped sheet.
        let sheet_rows = range.height();
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
        // Row-capped iff the sheet holds more data rows (past the detected
        // header) than were registered — whether dropped by the `.take` above
        // or by the bounded scan itself. Recorded, never silent.
        let capped_rows = (sheet_rows.saturating_sub(h + 1) > data.len()).then_some(data.len());
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
            out.push((tname, capped_rows));
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
    join_hints_excluding(regs, &[])
}

/// `join_hints`, but skipping any table pair a curated semantic join hint
/// already names (openspec: add-semantic-layer §2.4). The curated hint WINS: it
/// renders in the business-definitions block (semantic.rs), so the heuristic
/// card must not also emit a line for that pair. `excluded` holds the
/// posture-eligible curated pairs from `semantic::curated_join_pairs` as
/// (table, table) — order-insensitive, lowercased. An EMPTY slice reproduces
/// `join_hints` byte-for-byte, so a zero-curated-hint vault leaves the prompt
/// unchanged. PARITY: Rust-only (the twin has no analytics branch).
pub fn join_hints_excluding(regs: &[TableReg], excluded: &[(String, String)]) -> Option<String> {
    let excluded: std::collections::HashSet<(String, String)> =
        excluded.iter().map(|(a, b)| norm_pair(a, b)).collect();
    let mut lines: Vec<String> = Vec::new();
    'outer: for i in 0..regs.len() {
        for j in i + 1..regs.len() {
            if regs[i].table == regs[j].table {
                continue;
            }
            // A curated hint already names this pair — it renders in the block,
            // and it wins, so drop the heuristic line entirely for the pair.
            if !excluded.is_empty() && excluded.contains(&norm_pair(&regs[i].table, &regs[j].table)) {
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

/// An unordered, lowercased table-name pair key (so `(a,b)` and `(b,a)` match).
fn norm_pair(a: &str, b: &str) -> (String, String) {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    if a <= b {
        (a, b)
    } else {
        (b, a)
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

/// Freshness companion for saved views (design decision: "provenance keeps
/// naming source files"). A query FROM a view mentions no file table, so
/// `freshness_line` would fall back to listing EVERY registered file — the
/// wrong emphasis. Appending one SQL comment naming each mentioned view's
/// transitive `source_tables` lets the existing word-boundary mention check
/// (`sql_mentions_table`) find the real files, so the footer names exactly
/// the sources the view reads, with their saved times. Returns `sql`
/// unchanged when `view_regs` is empty or none are mentioned — zero-view
/// asks stay byte-identical. Call sites wrap every `freshness_line` input;
/// the expanded string never renders anywhere else.
pub fn expand_views_for_freshness(sql: &str, view_regs: &[ViewReg]) -> String {
    let mut tables: Vec<&str> = Vec::new();
    for vr in view_regs {
        if !sql_mentions_table(sql, &vr.name) {
            continue;
        }
        for t in &vr.source_tables {
            if !tables.iter().any(|x| x == t) {
                tables.push(t);
            }
        }
    }
    if tables.is_empty() {
        return sql.to_string();
    }
    format!("{sql} /* reads {} */", tables.join(" "))
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

/// Placeholder projection alias for a synthesized metric definition. The guard
/// and the `reads` walk don't depend on the alias, so a fixed identifier keeps
/// `guard_metric_expression` a pure `(expression, entity)` function; §4's
/// re-run rebuilds the SELECT with the metric's real name.
const METRIC_ALIAS: &str = "metric_value";

/// Guard a semantic-layer metric definition (openspec: add-semantic-layer
/// §1.3). Synthesize the canonical single statement
/// `SELECT <expression> AS metric_value FROM <entity>`, run the SAME read-only
/// [`guard_sql`] every executed query passes (so a saved metric is always a
/// re-runnable read-only SELECT — what §4 leans on), and return the table
/// names the definition references via the `views::collect_table_names` AST
/// walk (the SAME parser, so the guard and the reads derivation can never
/// disagree). `Err` with a human-readable reason for an expression that does
/// not parse or is not read-only; nothing is persisted by this pure function.
/// The caller (`semantic::create_metric`) resolves the returned names to a
/// metric's `reads`, refusing an unknown entity. PARITY: the TS twin
/// (semantic.ts) guards textually via `views.ts::guardViewSql` and scans
/// FROM/JOIN via `collectTableNames` — analytics/DataFusion is Rust-only.
pub fn guard_metric_expression(expression: &str, entity: &str) -> Result<Vec<String>, String> {
    let sql = format!("SELECT {expression} AS {METRIC_ALIAS} FROM {entity}");
    guard_sql(&sql)?;
    crate::views::collect_table_names(&sql)
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
    /// The execution-capped record batches themselves (≤ MAX_RESULT_ROWS+1
    /// rows, in-process only) — what the chart directive is validated against
    /// and materialized from (openspec: add-chart-directive). Never serialized.
    pub batches: Vec<RecordBatch>,
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
        batches,
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
/// Kinds: bar / line / area, plus (G4) scatter and stacked bar under STRICT,
/// self-provable conditions that keep the "never draw a claim the data doesn't
/// make" guarantee:
///   - SCATTER only when the first column is genuinely CONTINUOUS (a floating-
///     point column) and its labels do not read as time — a real (x, y)
///     relationship. Integer keys (ratings, codes) stay bars; temporal labels
///     (bare years) still route to area/line, byte-for-byte as before.
///   - STACKED bar only when, for every category, the cross-series values sum to
///     the SAME constant whole within epsilon (≈100 or ≈1.0) — a part-of-whole
///     relationship the batches themselves prove. Otherwise grouped. The renderer
///     never prints a stack total, so even a mis-hinted stack states no number.
/// Every default bar/line/area output stays byte-identical (the new keys are
/// emitted only on the new paths). None = "not a chart" — answers degrade to the
/// table alone, never to a wrong drawing.
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
    // Fewer than 2 rows is never a chart. MORE than CHART_MAX_POINTS is no
    // longer an outright decline: a CATEGORICAL shape gets top-N + “Other”
    // bucketing below (charts by default, 0.12.1); temporal and scatter
    // shapes beyond the cap still decline, in their own paths.
    if rows < 2 {
        return None;
    }
    // Identifier labels (add-chart-directive): a label column NAMED like an
    // identifier (id/sku/code, bare or _-prefixed, singular or plural) is a
    // key, not a category — a bar per identifier states nothing. The heuristic
    // declines; a valid directive can still chart it deliberately.
    if id_like_label(schema.field(0).name()) {
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

    let temporal = x.iter().all(|l| looks_temporal(l));

    // Beyond the point cap, TEMPORAL shapes keep declining exactly as before:
    // top-N bucketing ranks rows by value, and ranking a time axis by value
    // would destroy it. (Categorical shapes are bucketed further down.)
    if rows > CHART_MAX_POINTS && temporal {
        return None;
    }

    // Scatter (G4): a genuinely CONTINUOUS first column is a real (x, y)
    // relationship, not a category axis. Gated to a FLOATING-POINT first column
    // (not merely numeric): small-integer keys — star ratings 1–5, status codes,
    // enum ids — are usually categorical and read wrong as a continuous scatter,
    // so integer-keyed group-bys stay bars. Temporal labels (bare years) fall
    // through to area/line, byte-for-byte as before.
    let x_continuous = matches!(
        schema.field(0).data_type(),
        DataType::Float16 | DataType::Float32 | DataType::Float64
    );
    if ncols == 2 && x_continuous && !temporal {
        let mut x_values: Vec<Option<f64>> = Vec::with_capacity(rows);
        for b in batches {
            let col = b.column(0);
            for row in 0..b.num_rows() {
                if col.is_null(row) {
                    x_values.push(None);
                } else {
                    let raw = array_value_to_string(col, row).unwrap_or_default();
                    match raw.trim().parse::<f64>() {
                        Ok(v) if v.is_finite() => x_values.push(Some(v)),
                        _ => return None, // a non-numeric x render ⇒ don't chart
                    }
                }
            }
        }
        // Integral-valued float keys (1.0, 2.0, 3.0) are float-ENCODED
        // categories (exports often type integer codes as floats); like the
        // integer-key rule above they read wrong as a continuous scatter
        // (add-chart-directive). Scatter stays only for a GENUINELY continuous
        // x — at least one fractional value; integral keys fall through to the
        // categorical bar below.
        if x_values.iter().flatten().any(|v| v.fract() != 0.0) {
            // Beyond the point cap a SCATTER keeps declining exactly as
            // before: ranking a continuous x by the y value would destroy
            // the (x, y) relationship, so no top-N bucketing applies here.
            if rows > CHART_MAX_POINTS {
                return None;
            }
            // Need ≥2 points where BOTH x and y are finite, else the scatter
            // is too sparse to read — degrade to the table.
            let ys = &series[0].1;
            if x_values.iter().zip(ys).filter(|(xv, yv)| xv.is_some() && yv.is_some()).count() < 2 {
                return None;
            }
            let spec = serde_json::json!({
                "kind": "scatter",
                "x": x,
                "xValues": x_values,
                "series": [serde_json::json!({ "name": series[0].0, "values": ys })],
            });
            return Some(spec.to_string());
        }
    }

    // Time-series read best as a filled area when there's a single metric;
    // multiple series stay a line (overlapping fills would muddy them);
    // categorical stays a bar. Renderer accepts all four (chartSpec.ts).
    let kind = if temporal {
        if series.len() == 1 {
            "area"
        } else {
            "line"
        }
    } else {
        "bar"
    };
    // Top-N + “Other” bucketing (charts by default, 0.12.1): a CATEGORICAL
    // shape beyond the point cap is still comparable — rank rows descending
    // by the first series and fold the tail into one honest “Other” row.
    // Temporal and scatter shapes never reach here beyond the cap (both
    // declined above). The disclosing subtitle is engine-computed and rides
    // the spec ONLY when bucketing happened, so every ≤24-row output stays
    // byte-identical to before.
    let mut subtitle: Option<String> = None;
    if rows > CHART_MAX_POINTS {
        subtitle = Some(bucket_top_n(&mut x, &mut series));
        // Re-check the per-series floor on the bucketed view: a series whose
        // finite values all landed in “Other” would render a single point,
        // which the renderer (rightly) rejects — degrade to the table.
        for (_, vals) in &series {
            if vals.iter().filter(|v| v.is_some()).count() < 2 {
                return None;
            }
        }
    }
    let series_json = series
        .iter()
        .map(|(name, vals)| serde_json::json!({ "name": name, "values": vals }))
        .collect::<Vec<_>>();
    // Stacked bar (G4): only when the batches PROVE part-of-whole — every
    // category's series values sum to the same constant whole. Otherwise the
    // object is byte-identical to before (no `stacked` key → grouped).
    let mut spec = if kind == "bar" && is_stackable(&series) {
        serde_json::json!({
            "kind": "bar",
            "x": x,
            "series": series_json,
            "stacked": true,
        })
    } else {
        serde_json::json!({
            "kind": kind,
            "x": x,
            "series": series_json,
        })
    };
    if let Some(s) = &subtitle {
        spec["subtitle"] = serde_json::json!(s);
    }
    Some(spec.to_string())
}

/// Fold a beyond-cap CATEGORICAL result into the top CHART_MAX_POINTS-1 rows
/// plus one final “Other” row: rows are ranked DESCENDING by the FIRST
/// series' value (missing values last; stable, so ties keep result order,
/// mirroring the directed sort), and EVERY remaining row is aggregated into
/// “Other” as per-series sums (SQL SUM semantics: nulls are skipped; a series
/// with no finite tail value stays null). Returns the engine-computed
/// subtitle disclosing exactly what was folded. Callers guarantee
/// `x.len() > CHART_MAX_POINTS` and non-temporal labels.
fn bucket_top_n(x: &mut Vec<String>, series: &mut Vec<(String, Vec<Option<f64>>)>) -> String {
    let n = x.len();
    let keep = CHART_MAX_POINTS - 1;
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        use std::cmp::Ordering;
        match (series[0].1[a], series[0].1[b]) {
            (Some(va), Some(vb)) => vb.partial_cmp(&va).unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    });
    let mut new_x: Vec<String> = order[..keep].iter().map(|&i| x[i].clone()).collect();
    new_x.push("Other".to_string());
    for (_, vals) in series.iter_mut() {
        let mut kept: Vec<Option<f64>> = order[..keep].iter().map(|&i| vals[i]).collect();
        let mut tail_sum: Option<f64> = None;
        for &i in &order[keep..] {
            if let Some(v) = vals[i] {
                tail_sum = Some(tail_sum.unwrap_or(0.0) + v);
            }
        }
        kept.push(tail_sum);
        *vals = kept;
    }
    *x = new_x;
    // KEEP IN SYNC: src/lib/chartFromTable.ts builds this same subtitle for
    // the client-side “Chart it” heuristic; a unit test on each side pins it.
    format!(
        "Top {keep} of {n} by {} — {} smaller rows grouped as “Other”",
        series[0].0,
        n - keep
    )
}

/// Largest cross-series epsilon (absolute) for the ~100 whole, and the relative
/// epsilon for the ~1.0 whole — a stack is only drawn when every category's
/// parts sum to the SAME whole this tightly.
const STACK_EPS_ABS: f64 = 0.5;
const STACK_EPS_REL: f64 = 0.01;

/// True when the series are a provable part-of-whole decomposition: ≥2 series,
/// every value present (a null breaks a stack) and non-negative, and every
/// category's cross-series sum equals the same constant whole (≈100 or ≈1.0)
/// within epsilon. This is the ONLY stacking relationship provable from the
/// batches alone — it never asserts a sum the data doesn't already make.
fn is_stackable(series: &[(String, Vec<Option<f64>>)]) -> bool {
    if series.len() < 2 {
        return false;
    }
    let rows = series[0].1.len();
    if rows == 0 {
        return false;
    }
    let mut sums = Vec::with_capacity(rows);
    for i in 0..rows {
        let mut s = 0.0;
        for (_, vals) in series {
            match vals.get(i) {
                Some(Some(v)) if *v >= 0.0 => s += v,
                _ => return false, // a null/negative part can't stack honestly
            }
        }
        sums.push(s);
    }
    let whole = sums[0];
    // Reject a degenerate all-zero "whole" and pick the tolerance by scale.
    if whole <= f64::EPSILON {
        return false;
    }
    let is_hundred = (whole - 100.0).abs() <= STACK_EPS_ABS;
    let is_one = (whole - 1.0).abs() <= STACK_EPS_REL;
    if !is_hundred && !is_one {
        return false; // only the two canonical wholes read as "share of total"
    }
    let tol = if is_hundred { STACK_EPS_ABS } else { STACK_EPS_REL };
    sums.iter().all(|s| (s - whole).abs() <= tol)
}

/// Date-ish labels: 2024, 2024-07, 2024-07-08 (optional time tail), Q3 2024.
fn looks_temporal(label: &str) -> bool {
    let l = label.trim();
    let bytes = l.as_bytes();
    let all_digits = |s: &[u8]| !s.is_empty() && s.iter().all(|b| b.is_ascii_digit());
    if bytes.len() == 4 && all_digits(bytes) {
        // A bare 4-digit integer reads as a YEAR only in a plausible range —
        // outside it, it's an identifier (store 1001, SKU 4520), and charting
        // identifiers as a time axis was a known misfire (add-chart-directive).
        let year: u16 = l.parse().unwrap_or(0);
        return (1900..=2100).contains(&year);
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

/// Identifier-named column: matches `(?i)(^|_)(id|sku|code)s?$` without a
/// regex dependency — "id", "store_id", "SKUs", "zip_code", … but never
/// "grid" or "period" (the id/sku/code stem must begin the name or follow an
/// underscore).
fn id_like_label(name: &str) -> bool {
    let lower = name.to_lowercase();
    let stem = lower.strip_suffix('s').unwrap_or(&lower);
    for suffix in ["id", "sku", "code"] {
        if let Some(prefix) = stem.strip_suffix(suffix) {
            if prefix.is_empty() || prefix.ends_with('_') {
                return true;
            }
        }
    }
    false
}

// --- Chart directive (openspec: add-chart-directive) -------------------------------
//
// The narrating model may STEER the chart — never its numbers — through one
// plain-text fenced block, the same mechanism for all seven providers (no
// per-provider function calling; the local 7B's tool-calling is unreliable and
// chart data must keep coming from engine batches). The engine teaches the
// syntax via a compact card (`chart_card`), scrubs the fence from displayed
// prose (`DirectiveScrubber`), validates every named column against the real
// batch schema, and materializes the spec FROM the batches
// (`chart_spec_from_batches_directed`). Anything invalid falls back to the
// unchanged heuristic; `"none"` is advisory only — the engine decides
// chartability, so a "none" lands on the heuristic like any absent directive.

/// The directive fence opener. PARITY: src/lib/chartSpec.ts::CHART_DIRECTIVE_FENCE.
pub const CHART_DIRECTIVE_FENCE: &str = "```lighthouse-chart-request";
/// The ONE directive string that reaches the spec — display copy, never data.
/// PARITY: src/lib/chartSpec.ts::MAX_TITLE_CHARS.
const CHART_TITLE_MAX_CHARS: usize = 80;

/// What the model asked for. `None` = "I think nothing here compares" — an
/// advisory the engine records but no longer obeys: since charts-by-default
/// (0.12.1) a "none" lands on the heuristic exactly like an absent directive
/// (the heuristic already declines genuinely non-chartable shapes itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartDirectiveKind {
    Bar,
    Line,
    Area,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartSort {
    Asc,
    Desc,
}

/// A parsed chart directive. Only these five fields are ever read from the
/// fenced JSON — extra keys (fabricated `x`/`values`/anything) are ignored
/// wholesale, so a directive can never smuggle data into a chart.
#[derive(Debug, Clone, PartialEq)]
pub struct ChartDirective {
    pub kind: ChartDirectiveKind,
    /// Must name a real result column (exact, case-sensitive). Empty for "none".
    pub label_column: String,
    /// 1..=3 names; each must exist and be numeric (validated, not trusted).
    pub series_columns: Vec<String>,
    /// Optional display title — capped and control-stripped at materialization.
    pub title: Option<String>,
    pub sort: Option<ChartSort>,
}

/// Parse the FIRST `lighthouse-chart-request` fence out of a narration (later
/// ones are ignored). Returns `None` for no fence, an unterminated fence, or
/// any grammar violation (non-JSON body, unknown kind, wrong field types, a
/// sort outside asc|desc) — all of which fall back to the heuristic. PARITY:
/// src/lib/chartSpec.ts::parseChartDirective.
pub fn parse_chart_directive(text: &str) -> Option<ChartDirective> {
    let start = text.find(CHART_DIRECTIVE_FENCE)?;
    let after = &text[start + CHART_DIRECTIVE_FENCE.len()..];
    let end = after.find("```")?;
    let body = after[..end].trim();
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let obj = v.as_object()?;
    let kind = match obj.get("kind")?.as_str()? {
        "bar" => ChartDirectiveKind::Bar,
        "line" => ChartDirectiveKind::Line,
        "area" => ChartDirectiveKind::Area,
        "none" => {
            return Some(ChartDirective {
                kind: ChartDirectiveKind::None,
                label_column: String::new(),
                series_columns: Vec::new(),
                title: None,
                sort: None,
            })
        }
        _ => return None,
    };
    let label_column = obj.get("label_column")?.as_str()?.to_string();
    let series_columns: Vec<String> = obj
        .get("series_columns")?
        .as_array()?
        .iter()
        .map(|s| s.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    let title = match obj.get("title") {
        Some(t) => Some(t.as_str()?.to_string()),
        None => None,
    };
    let sort = match obj.get("sort") {
        Some(s) => match s.as_str()? {
            "asc" => Some(ChartSort::Asc),
            "desc" => Some(ChartSort::Desc),
            _ => return None,
        },
        None => None,
    };
    Some(ChartDirective {
        kind,
        label_column,
        series_columns,
        title,
        sort,
    })
}

/// The result schema a directive is validated against: (column name, numeric).
pub fn chart_columns(batches: &[RecordBatch]) -> Vec<(String, bool)> {
    let Some(first) = batches.iter().find(|b| b.num_columns() > 0) else {
        return Vec::new();
    };
    first
        .schema()
        .fields()
        .iter()
        .map(|f| (f.name().clone(), f.data_type().is_numeric()))
        .collect()
}

/// Validate a directive against the ACTUAL result columns: the label column
/// must exist (exact match), series must name 1..=3 existing numeric columns.
/// Error strings are shared fixtures with the TS twin's tests. PARITY:
/// src/lib/chartSpec.ts::validateDirective.
pub fn validate_directive(
    d: &ChartDirective,
    columns: &[(String, bool)],
) -> Result<(), String> {
    if d.kind == ChartDirectiveKind::None {
        return Ok(());
    }
    if !columns.iter().any(|(n, _)| *n == d.label_column) {
        return Err(format!("unknown label_column {:?}", d.label_column));
    }
    if d.series_columns.is_empty() || d.series_columns.len() > CHART_MAX_SERIES {
        return Err(format!(
            "series_columns must name 1-{CHART_MAX_SERIES} columns"
        ));
    }
    for s in &d.series_columns {
        match columns.iter().find(|(n, _)| n == s) {
            Some((_, true)) => {}
            Some((_, false)) => return Err(format!("series column {s:?} is not numeric")),
            None => return Err(format!("unknown series column {s:?}")),
        }
    }
    Ok(())
}

/// Cap + sanitize the one directive string that reaches the spec. Control
/// characters are stripped, whitespace trimmed, length capped; an empty
/// residue drops the title entirely.
fn sanitize_title(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(CHART_TITLE_MAX_CHARS).collect())
}

/// The DIRECTED variant of `chart_spec_from_batches`: the directive's choices
/// (label/series/sort/title) are parameters; every value is read from the
/// batches exactly as the heuristic reads them — a directive can steer, never
/// supply, a number. Returns `None` on any violation (callers fall back to
/// the heuristic): unknown columns, non-numeric series, out-of-range rows,
/// unlabeled points, a series with <2 finite values.
pub fn chart_spec_from_batches_directed(
    batches: &[RecordBatch],
    d: &ChartDirective,
) -> Option<String> {
    let kind = match d.kind {
        ChartDirectiveKind::Bar => "bar",
        ChartDirectiveKind::Line => "line",
        ChartDirectiveKind::Area => "area",
        ChartDirectiveKind::None => return None,
    };
    let columns = chart_columns(batches);
    validate_directive(d, &columns).ok()?;
    let first = batches.iter().find(|b| b.num_columns() > 0)?;
    let schema = first.schema();
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    // Beyond the point cap the DIRECTED path declines and decide_chart's
    // existing `.or_else` lands on the heuristic, whose top-N + “Other”
    // bucketing (charts by default, 0.12.1) takes over — one bucketing
    // implementation, not two. (The chart card only rides ≤24-row results,
    // so a beyond-cap directive is a spontaneous one anyway.)
    if !(2..=CHART_MAX_POINTS).contains(&rows) {
        return None;
    }
    let label_idx = schema.index_of(&d.label_column).ok()?;
    let series_idx: Vec<usize> = d
        .series_columns
        .iter()
        .map(|s| schema.index_of(s).ok())
        .collect::<Option<Vec<_>>>()?;

    let mut x: Vec<String> = Vec::with_capacity(rows);
    let mut series: Vec<(String, Vec<Option<f64>>)> = d
        .series_columns
        .iter()
        .map(|s| (s.clone(), Vec::with_capacity(rows)))
        .collect();
    for b in batches {
        for row in 0..b.num_rows() {
            let label = array_value_to_string(b.column(label_idx), row).unwrap_or_default();
            if label.trim().is_empty() {
                return None; // unlabeled point — the table tells it better
            }
            x.push(label.chars().take(40).collect());
            for (k, idx) in series_idx.iter().enumerate() {
                let col = b.column(*idx);
                if col.is_null(row) {
                    series[k].1.push(None);
                } else {
                    let raw = array_value_to_string(col, row).unwrap_or_default();
                    match raw.trim().parse::<f64>() {
                        Ok(v) if v.is_finite() => series[k].1.push(Some(v)),
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

    // Engine-side sort by the FIRST series column (missing values last in
    // either direction); stable, so tied categories keep result order.
    if let Some(sort) = d.sort {
        let mut order: Vec<usize> = (0..x.len()).collect();
        order.sort_by(|&a, &b| {
            use std::cmp::Ordering;
            match (series[0].1[a], series[0].1[b]) {
                (Some(va), Some(vb)) => {
                    let ord = va.partial_cmp(&vb).unwrap_or(Ordering::Equal);
                    if sort == ChartSort::Desc {
                        ord.reverse()
                    } else {
                        ord
                    }
                }
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            }
        });
        x = order.iter().map(|&i| x[i].clone()).collect();
        for (_, vals) in &mut series {
            *vals = order.iter().map(|&i| vals[i]).collect();
        }
    }

    let series_json = series
        .iter()
        .map(|(name, vals)| serde_json::json!({ "name": name, "values": vals }))
        .collect::<Vec<_>>();
    let mut spec = serde_json::json!({
        "kind": kind,
        "x": x,
        "series": series_json,
    });
    // The existing stacked behavior applied to the directed selection: only a
    // batch-PROVEN part-of-whole stacks, so a directed share table isn't worse
    // than the heuristic's drawing of it.
    if kind == "bar" && is_stackable(&series) {
        spec["stacked"] = serde_json::json!(true);
    }
    // `title` is emitted ONLY on the directed path — heuristic specs stay
    // byte-identical to today.
    if let Some(t) = d.title.as_deref().and_then(sanitize_title) {
        spec["title"] = serde_json::json!(t);
    }
    Some(spec.to_string())
}

/// The chart decision for a completed narration — the single point synth.rs
/// consults after streaming (the deterministic emission point made
/// directive-aware). Charts by default (0.12.1): the ENGINE decides
/// chartability; a directive REFINES the chart (kind/columns/title/sort) but
/// may no longer suppress a chartable result. A "none" directive behaves
/// exactly like no directive — the heuristic still runs, and it already
/// declines the genuinely non-chartable shapes by itself (single value,
/// single row, no numeric series, id-like labels). A valid directive
/// materializes from the batches; anything else (absent, malformed, invalid,
/// or a directed build that fails on the data) lands on the unchanged
/// heuristic. Truncated results are gated by the CALLER (they never reach
/// this point), matching run_query's own gate.
pub fn decide_chart(batches: &[RecordBatch], narration: &str) -> Option<String> {
    match parse_chart_directive(narration) {
        // "none" is advisory only: fall through to the heuristic, exactly as
        // if no directive had been written.
        Some(d) if d.kind == ChartDirectiveKind::None => chart_spec_from_batches(batches),
        Some(d) => chart_spec_from_batches_directed(batches, &d)
            .or_else(|| chart_spec_from_batches(batches)),
        None => chart_spec_from_batches(batches),
    }
}

// --- Chart card ---------------------------------------------------------------------

/// Version stamp for the chart card. The full text is snapshot-pinned in a
/// unit test, so any edit (and the version bump that should ride with a
/// behavioral one) is a reviewed diff.
pub const CHART_CARD_VERSION: &str = "v2";
/// Card budget: ~215 tokens (v2's advisory "none" line bought ~56 chars).
/// Asserted by `chart_card_stays_inside_budget` and re-checked by the
/// chart_eval floor.
pub const CHART_CARD_MAX_CHARS: usize = 860;
/// Cap on the interpolated column list — a 24-column result must not blow the
/// card budget; the full header already rides in the result block itself.
const CHART_CARD_COLS_CHARS: usize = 96;

/// A few-shot the card teaches: a tiny result shape and the directive that
/// fits it. Every example is validated by the engine's OWN validator against
/// its example columns (`every_chart_card_example_validates`), so the card
/// can never teach syntax the engine rejects.
pub struct ChartCardExample {
    /// The example table shape as shown in the card, e.g. "(month, total)".
    pub what: &'static str,
    /// The example table's columns: (name, numeric).
    pub columns: &'static [(&'static str, bool)],
    /// The taught directive JSON, exactly as it appears in the card.
    pub directive: &'static str,
}

pub const CHART_CARD_EXAMPLES: &[ChartCardExample] = &[
    ChartCardExample {
        what: "(month, total)",
        columns: &[("month", false), ("total", true)],
        directive: r#"{"kind":"area","label_column":"month","series_columns":["total"]}"#,
    },
    ChartCardExample {
        what: "(region, revenue)",
        columns: &[("region", false), ("revenue", true)],
        directive: r#"{"kind":"bar","label_column":"region","series_columns":["revenue"],"title":"Revenue by region","sort":"desc"}"#,
    },
    ChartCardExample {
        what: "(store_id, revenue)",
        columns: &[("store_id", true), ("revenue", true)],
        directive: r#"{"kind":"none"}"#,
    },
];

/// The chart card — the compact prompt block that teaches the narrating model
/// the kinds, when none fits, this result's ACTUAL columns, and the directive
/// syntax. `None` when the result shape can't chart at all (loose gate:
/// 2..=24 rows, ≥1 numeric column) — then the ~200 tokens are not spent and
/// no doomed directive is invited. Injected by synth.rs ONLY on untruncated
/// analytics results.
pub fn chart_card(batches: &[RecordBatch]) -> Option<String> {
    let columns = chart_columns(batches);
    if !columns.iter().any(|(_, numeric)| *numeric) {
        return None;
    }
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    if !(2..=CHART_MAX_POINTS).contains(&rows) {
        return None;
    }
    let mut listed = String::new();
    for (name, numeric) in &columns {
        let sep = if listed.is_empty() { "" } else { ", " };
        let entry = format!("{sep}{name} ({})", if *numeric { "numeric" } else { "text" });
        if listed.chars().count() + entry.chars().count() > CHART_CARD_COLS_CHARS {
            listed.push_str(", …");
            break;
        }
        listed.push_str(&entry);
    }
    Some(format!(
        "Chart options ({CHART_CARD_VERSION}) — result columns: {listed}.\n\
         End the answer with at most ONE fenced request to choose this answer's chart; \
         the app builds it from the verified result (a request can never supply values):\n\
         {CHART_DIRECTIVE_FENCE}\n{}\n```\n\
         kind: bar = categories; line = trend, 2-3 series; area = trend, 1 series; \
         none = you think nothing here is comparable (single number, id/SKU/code labels) — \
         the app still charts results whose shape fits. \
         series_columns: 1-3 numeric columns; title and sort (asc|desc, by first series) optional.\n\
         Examples: {} → {} · {} → {}",
        CHART_CARD_EXAMPLES[1].directive,
        CHART_CARD_EXAMPLES[0].what,
        CHART_CARD_EXAMPLES[0].directive,
        CHART_CARD_EXAMPLES[2].what,
        CHART_CARD_EXAMPLES[2].directive,
    ))
}

// --- Directive stream scrubbing -----------------------------------------------------

/// Withholds `lighthouse-chart-request` fences from forwarded narration
/// deltas while accumulating the FULL narration for directive parsing at
/// completion. Hold-back is minimal: prose is forwarded as it streams except
/// a tail that could still become the fence opener; if it turns out not to be
/// the fence, `push`/`finish` flush it. Fence bytes themselves (opener, body,
/// closer) are never forwarded — the belt-and-braces UI strip is a second
/// net, not the mechanism.
#[derive(Default)]
pub struct DirectiveScrubber {
    full: String,
    pending: String,
    in_fence: bool,
}

impl DirectiveScrubber {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one streamed delta; returns the prose safe to forward now.
    pub fn push(&mut self, delta: &str) -> String {
        self.full.push_str(delta);
        self.pending.push_str(delta);
        let mut out = String::new();
        loop {
            if self.in_fence {
                // Swallow through the closing fence (plus one newline so the
                // removal leaves no blank hole in the prose).
                let Some(pos) = self.pending.find("```") else {
                    return out; // fence still open — hold everything
                };
                let mut rest = self.pending.split_off(pos + 3);
                if rest.starts_with('\n') {
                    rest.remove(0);
                }
                self.pending = rest;
                self.in_fence = false;
                continue;
            }
            if let Some(pos) = self.pending.find(CHART_DIRECTIVE_FENCE) {
                out.push_str(&self.pending[..pos]);
                self.pending.drain(..pos + CHART_DIRECTIVE_FENCE.len());
                self.in_fence = true;
                continue;
            }
            // No opener yet: forward all but the longest tail that is still a
            // prefix of the opener (it may complete in the next delta).
            let keep = longest_opener_prefix_suffix(&self.pending);
            let cut = self.pending.len() - keep;
            out.push_str(&self.pending[..cut]);
            self.pending.drain(..cut);
            return out;
        }
    }

    /// Stream finished: flush held prose that turned out not to be a fence.
    /// An unterminated fence is directive text, not prose — it stays withheld
    /// (and parses as malformed, so the chart falls back to the heuristic).
    pub fn finish(&mut self) -> String {
        if self.in_fence {
            self.pending.clear();
            return String::new();
        }
        std::mem::take(&mut self.pending)
    }

    /// Everything the model wrote, fences included — what the directive
    /// parser reads at completion.
    pub fn full_text(&self) -> &str {
        &self.full
    }
}

/// Length of the longest suffix of `hay` that is a proper prefix of the fence
/// opener. Byte-wise: the opener is ASCII, so a matching suffix always ends
/// on a char boundary.
fn longest_opener_prefix_suffix(hay: &str) -> usize {
    let hay = hay.as_bytes();
    let needle = CHART_DIRECTIVE_FENCE.as_bytes();
    let max = hay.len().min(needle.len() - 1);
    for k in (1..=max).rev() {
        if hay[hay.len() - k..] == needle[..k] {
            return k;
        }
    }
    0
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
            capped_rows: None,
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

    // openspec: add-shaped-views §2 — the freshness expansion keeps the
    // provenance footer naming SOURCE files for a query FROM a saved view.
    #[test]
    fn view_freshness_expansion_names_source_tables_only_when_mentioned() {
        let vr = |name: &str, tables: &[&str]| ViewReg {
            name: name.into(),
            card: String::new(),
            columns: vec![],
            source_file_ids: vec![],
            source_tables: tables.iter().map(|t| t.to_string()).collect(),
            summary: String::new(),
        };

        // Empty registry ⇒ the IDENTICAL string (zero-view asks byte-stable).
        assert_eq!(
            expand_views_for_freshness("SELECT * FROM sales", &[]),
            "SELECT * FROM sales"
        );
        // An unmentioned view changes nothing either.
        let clean = vr("clean_sales", &["sales"]);
        assert_eq!(
            expand_views_for_freshness("SELECT * FROM orders", &[clean.clone()]),
            "SELECT * FROM orders"
        );
        // Word boundaries hold: clean_sales_2 does not mention clean_sales.
        assert_eq!(
            expand_views_for_freshness("SELECT * FROM clean_sales_2", &[clean.clone()]),
            "SELECT * FROM clean_sales_2"
        );
        // A mentioned view appends ONE comment naming its source tables…
        assert_eq!(
            expand_views_for_freshness("SELECT SUM(amount) FROM clean_sales", &[clean.clone()]),
            "SELECT SUM(amount) FROM clean_sales /* reads sales */"
        );
        // …which makes freshness_line pick out exactly the source files.
        let now = 1_700_000_000_000i64;
        let reg = |table: &str, id: &str, name: &str| TableReg {
            table: table.into(),
            file_id: id.into(),
            file_name: name.into(),
            card: String::new(),
            modified_ms: Some(now - 2 * 3_600_000),
            columns: vec![],
            group: None,
            capped_rows: None,
        };
        let regs = vec![reg("sales", "f1", "sales.csv"), reg("costs", "f2", "costs.csv")];
        let sql = "SELECT SUM(amount) FROM clean_sales";
        let line = freshness_line(
            &regs,
            &expand_views_for_freshness(sql, &[clean.clone()]),
            now,
        )
        .unwrap();
        assert!(line.contains("sales.csv"), "{line}");
        assert!(!line.contains("costs.csv"), "footer names the view's sources only: {line}");
        // Without the expansion the fallback lists everything — the wrong
        // emphasis this helper exists to fix.
        let fallback = freshness_line(&regs, sql, now).unwrap();
        assert!(fallback.contains("costs.csv"), "{fallback}");

        // Two mentioned views merge into one comment, deduped, reads order.
        let joined = vr("joined_view", &["sales", "regions"]);
        assert_eq!(
            expand_views_for_freshness(
                "SELECT * FROM clean_sales JOIN joined_view ON true",
                &[clean, joined]
            ),
            "SELECT * FROM clean_sales JOIN joined_view ON true /* reads sales regions */"
        );
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
        // Maximal shape under the Beam budget (openspec: add-beam-loop §2): the
        // planning prompt for the last step carries every prior step's SQL and
        // its result clipped to STEP_RESULT_CAP. At the configurable ceiling (12
        // steps, settings::BEAM_MAX_STEPS_CEILING) that is 11 prior steps — the
        // prompt grows past the old hardcoded-3 bound but stays a tiny fraction
        // of any remote window (the loop is remote-gated for exactly this
        // reason). 24k chars ≈ 6k tokens — comfortably inside every remote model.
        let steps: Vec<StepRecord> = (0..11)
            .map(|i| StepRecord {
                sql: format!(
                    "SELECT c{i}, SUM(v) FROM {} GROUP BY c{i} ORDER BY 2 DESC",
                    "t".repeat(120)
                ),
                result_markdown: "| a | b |\n| 1 | 2 |\n".repeat(200), // > cap, gets clipped
            })
            .collect();
        let q = step_question(&"compare everything and explain why ".repeat(8), &steps, 12);
        assert!(
            q.chars().count() < 24_000,
            "prompt budget blown: {}",
            q.chars().count()
        );
        assert!(q.contains("Step 11 SQL"));
        assert!(q.contains("up to 12 SQL queries total"));
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

    // G4: the categorical-bar and temporal-area default outputs must stay
    // byte-identical — the wire fixtures the smoke test and the renderer pin.
    #[test]
    fn default_chart_outputs_are_byte_locked() {
        let bar = chart_spec_from_batches(&[batch(&["NE", "NW"], &[150.0, 200.0])]).unwrap();
        assert_eq!(
            bar,
            r#"{"kind":"bar","series":[{"name":"total","values":[150.0,200.0]}],"x":["NE","NW"]}"#
        );
        let area =
            chart_spec_from_batches(&[batch(&["2024-01", "2024-02"], &[1.0, 2.0])]).unwrap();
        assert_eq!(
            area,
            r#"{"kind":"area","series":[{"name":"total","values":[1.0,2.0]}],"x":["2024-01","2024-02"]}"#
        );
    }

    // Charts by default (0.12.1): a beyond-cap CATEGORICAL result folds into
    // top-23 + “Other” instead of declining; the disclosing subtitle is
    // pinned byte-for-byte (KEEP IN SYNC: src/lib/chartFromTable.ts mirrors
    // both the fold and this exact string).
    #[test]
    fn beyond_cap_categorical_buckets_into_top_n_plus_other() {
        let labels: Vec<String> = (1..=40).map(|i| format!("cat{i:02}")).collect();
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let values: Vec<f64> = (1..=40).map(|i| (i as f64) * 10.0).collect();
        let spec = chart_spec_from_batches(&[batch(&refs, &values)]).expect("bucketed chart");
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(v["kind"], "bar");
        let x = v["x"].as_array().unwrap();
        assert_eq!(x.len(), CHART_MAX_POINTS);
        assert_eq!(x[0], "cat40", "ranked descending by the first series");
        assert_eq!(x[22], "cat18");
        assert_eq!(x[23], "Other");
        let vals = v["series"][0]["values"].as_array().unwrap();
        assert_eq!(vals.len(), CHART_MAX_POINTS);
        assert_eq!(vals[0], 400.0);
        // “Other” = the exact engine-computed sum of the 17 smallest rows:
        // 10 + 20 + … + 170 = 1530.
        assert_eq!(vals[23], 1530.0);
        assert_eq!(
            v["subtitle"],
            "Top 23 of 40 by total — 17 smaller rows grouped as “Other”"
        );
        // ≤24-row outputs stay byte-identical: no subtitle key at all.
        let small = chart_spec_from_batches(&[batch(&["NE", "NW"], &[1.0, 2.0])]).unwrap();
        assert!(!small.contains("subtitle"));

        // Boundary: 25 rows folds exactly the 2 smallest into “Other”.
        let labels: Vec<String> = (1..=25).map(|i| format!("c{i:02}")).collect();
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let values: Vec<f64> = (1..=25).map(|i| i as f64).collect();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[batch(&refs, &values)]).unwrap())
                .unwrap();
        assert_eq!(v["x"].as_array().unwrap().len(), CHART_MAX_POINTS);
        assert_eq!(v["x"][23], "Other");
        assert_eq!(v["series"][0]["values"][23], 3.0); // 1 + 2
        assert_eq!(
            v["subtitle"],
            "Top 23 of 25 by total — 2 smaller rows grouped as “Other”"
        );
    }

    #[test]
    fn beyond_cap_temporal_and_scatter_still_decline() {
        // 25 months: top-N ranking would destroy the time axis — decline,
        // exactly as before the bucketing change.
        let labels: Vec<String> = (0..25)
            .map(|i| format!("{}-{:02}", 2020 + i / 12, i % 12 + 1))
            .collect();
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let values: Vec<f64> = (0..25).map(|i| i as f64).collect();
        assert!(chart_spec_from_batches(&[batch(&refs, &values)]).is_none());

        // 25 genuinely continuous x points: a value-ranked scatter is no
        // scatter — decline, exactly as before.
        let xs: Vec<f64> = (0..25).map(|i| i as f64 + 0.5).collect();
        let ys: Vec<f64> = (0..25).map(|i| i as f64).collect();
        assert!(chart_spec_from_batches(&[num_batch(&xs, &ys)]).is_none());
    }

    #[test]
    fn bucketing_declines_when_a_folded_series_loses_its_points() {
        // Second series finite ONLY in tail rows: after folding, its kept
        // view is all-null plus one “Other” sum — a single point the renderer
        // rejects — so the engine degrades to the table instead.
        let n = 30usize;
        let schema = Arc::new(Schema::new(vec![
            Field::new("label", DataType::Utf8, false),
            Field::new("a", DataType::Float64, true),
            Field::new("b", DataType::Float64, true),
        ]));
        let labels: Vec<String> = (0..n).map(|i| format!("r{i:02}")).collect();
        let a: Vec<f64> = (0..n).map(|i| (n - i) as f64).collect(); // descending
        let b: Vec<Option<f64>> = (0..n)
            .map(|i| if i >= n - 2 { Some(1.0) } else { None })
            .collect();
        let sparse = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(
                    labels.iter().map(String::as_str).collect::<Vec<_>>(),
                )),
                Arc::new(Float64Array::from(a)),
                Arc::new(Float64Array::from(b)),
            ],
        )
        .unwrap();
        assert!(chart_spec_from_batches(&[sparse]).is_none());
    }

    fn num_batch(xs: &[f64], ys: &[f64]) -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("weight", DataType::Float64, false),
                Field::new("price", DataType::Float64, true),
            ])),
            vec![
                Arc::new(Float64Array::from(xs.to_vec())),
                Arc::new(Float64Array::from(ys.to_vec())),
            ],
        )
        .unwrap()
    }

    #[test]
    fn scatter_is_emitted_for_numeric_nontemporal_x() {
        // A numeric first column that isn't a year → scatter with aligned xValues.
        let spec = chart_spec_from_batches(&[num_batch(&[10.5, 22.0, 30.0], &[1.0, 4.0, 9.0])])
            .expect("chartable");
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(v["kind"], "scatter");
        assert_eq!(v["xValues"].as_array().unwrap().len(), 3);
        assert_eq!(v["xValues"][1], 22.0);
        assert_eq!(v["series"].as_array().unwrap().len(), 1, "scatter is single-series");
        assert_eq!(v["series"][0]["values"][2], 9.0);
    }

    #[test]
    fn integer_keyed_group_by_stays_a_bar_not_scatter() {
        // "count by star-rating (1..5)" — an Int key is categorical, not a
        // continuous x; it must stay a bar, not become a scatter.
        let ratings = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("rating", DataType::Int64, false),
                Field::new("count", DataType::Float64, true),
            ])),
            vec![
                Arc::new(datafusion::arrow::array::Int64Array::from(vec![1, 2, 3, 4, 5])),
                Arc::new(Float64Array::from(vec![3.0, 8.0, 20.0, 40.0, 12.0])),
            ],
        )
        .unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[ratings]).unwrap()).unwrap();
        assert_eq!(v["kind"], "bar", "an integer key is categorical, not a scatter x");
        assert!(v.get("xValues").is_none());
    }

    #[test]
    fn bare_year_x_stays_area_not_scatter() {
        // Numeric but temporal (years) → still area, byte-compatible with before.
        let years = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("yr", DataType::Int32, false),
                Field::new("total", DataType::Float64, true),
            ])),
            vec![
                Arc::new(datafusion::arrow::array::Int32Array::from(vec![2019, 2020, 2021])),
                Arc::new(Float64Array::from(vec![5.0, 6.0, 7.0])),
            ],
        )
        .unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[years]).unwrap()).unwrap();
        assert_eq!(v["kind"], "area", "bare years read as time, not a scatter x");
        assert!(v.get("xValues").is_none());
    }

    fn share_batch(a: &[f64], b: &[f64]) -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("region", DataType::Utf8, false),
                Field::new("share_a", DataType::Float64, true),
                Field::new("share_b", DataType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["NE", "NW", "SE"])),
                Arc::new(Float64Array::from(a.to_vec())),
                Arc::new(Float64Array::from(b.to_vec())),
            ],
        )
        .unwrap()
    }

    #[test]
    fn stacked_only_when_parts_sum_to_a_constant_whole() {
        // Every category's two shares sum to 100 → provable part-of-whole → stacked.
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches(&[share_batch(&[60.0, 40.0, 55.0], &[40.0, 60.0, 45.0])])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v["kind"], "bar");
        assert_eq!(v["stacked"], true);

        // Independent metrics that don't sum to a constant → grouped (no key).
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches(&[share_batch(&[10.0, 200.0, 3.0], &[7.0, 1.0, 90.0])])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v["kind"], "bar");
        assert!(v.get("stacked").is_none(), "unproven whole must not stack");

        // A null part disqualifies stacking even where the rest would sum. Uses
        // 3 rows so series b keeps ≥2 finite values (the chart gate) while one
        // category has a hole in the stack.
        let with_null = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("region", DataType::Utf8, false),
                Field::new("a", DataType::Float64, true),
                Field::new("b", DataType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["NE", "NW", "SE"])),
                Arc::new(Float64Array::from(vec![60.0, 40.0, 55.0])),
                Arc::new(Float64Array::from(vec![Some(40.0), None, Some(45.0)])),
            ],
        )
        .unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[with_null]).unwrap()).unwrap();
        assert!(v.get("stacked").is_none(), "a null part can't stack honestly");
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

    // --- Chart directive (openspec: add-chart-directive) ---------------------------

    #[test]
    fn bare_year_range_gates_temporal_labels() {
        // Plausible years still read as time…
        for l in ["1900", "1999", "2024", "2100"] {
            assert!(looks_temporal(l), "{l}");
        }
        // …but 4-digit identifiers (store 1001, SKU 4520) no longer do.
        for l in ["0001", "1001", "1899", "2101", "4520", "9999"] {
            assert!(!looks_temporal(l), "{l}");
        }
    }

    #[test]
    fn four_digit_id_values_stop_charting_as_time() {
        // "revenue by store" with stores 1001..1004 used to draw a TIME series.
        // The year-range gate makes them categorical keys → bar.
        let stores = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("store", DataType::Int64, false),
                Field::new("revenue", DataType::Float64, true),
            ])),
            vec![
                Arc::new(datafusion::arrow::array::Int64Array::from(vec![
                    1001, 1002, 1003, 1004,
                ])),
                Arc::new(Float64Array::from(vec![5.0, 6.0, 7.0, 8.0])),
            ],
        )
        .unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[stores]).unwrap()).unwrap();
        assert_eq!(v["kind"], "bar", "4-digit ids are not a time axis");
    }

    #[test]
    fn id_named_label_columns_decline() {
        assert!(id_like_label("id"));
        assert!(id_like_label("ids"));
        assert!(id_like_label("store_id"));
        assert!(id_like_label("Store_IDs"));
        assert!(id_like_label("SKU"));
        assert!(id_like_label("item_skus"));
        assert!(id_like_label("code"));
        assert!(id_like_label("zip_codes"));
        assert!(!id_like_label("grid"));
        assert!(!id_like_label("period"));
        assert!(!id_like_label("postcode")); // no ^|_ boundary before "code"
        assert!(!id_like_label("region"));
        assert!(!id_like_label("store"));

        // A meaningless bar-per-identifier is declined outright…
        let ids = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("store_id", DataType::Int64, false),
                Field::new("revenue", DataType::Float64, true),
            ])),
            vec![
                Arc::new(datafusion::arrow::array::Int64Array::from(vec![
                    1001, 1002, 1003,
                ])),
                Arc::new(Float64Array::from(vec![5.0, 6.0, 7.0])),
            ],
        )
        .unwrap();
        assert!(chart_spec_from_batches(&[ids.clone()]).is_none());
        // …while a deliberate directive can still chart it as a bar.
        let d = parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"store_id\",\"series_columns\":[\"revenue\"]}\n```",
        )
        .unwrap();
        let spec = chart_spec_from_batches_directed(&[ids], &d).expect("directed id bar");
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(v["kind"], "bar");
        assert_eq!(v["series"][0]["values"][2], 7.0);
    }

    #[test]
    fn integral_float_keys_stay_bar_not_scatter() {
        // Float-ENCODED categories (1.0..5.0) read wrong as a continuous
        // scatter — they are keys, exactly like the Int64 rating case.
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches(&[num_batch(
                &[1.0, 2.0, 3.0, 4.0, 5.0],
                &[3.0, 8.0, 20.0, 40.0, 12.0],
            )])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["kind"], "bar", "integral floats are categorical keys");
        assert!(v.get("xValues").is_none());
        // A genuinely continuous x (some fractional value) still scatters.
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches(&[num_batch(&[10.5, 22.0, 30.0], &[1.0, 4.0, 9.0])]).unwrap(),
        )
        .unwrap();
        assert_eq!(v["kind"], "scatter");
    }

    #[test]
    fn directive_parses_first_fence_and_ignores_fabricated_values() {
        // Prose around the fence; fabricated x/values keys are never read;
        // a SECOND fence is ignored entirely.
        let narration = "NW leads [1].\n\n```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"region\",\"series_columns\":[\"total\"],\"x\":[\"fake\"],\"values\":[999]}\n```\ntail\n```lighthouse-chart-request\n{\"kind\":\"none\"}\n```";
        let d = parse_chart_directive(narration).expect("first fence parses");
        assert_eq!(d.kind, ChartDirectiveKind::Bar);
        assert_eq!(d.label_column, "region");
        assert_eq!(d.series_columns, vec!["total".to_string()]);
        assert_eq!(d.title, None);
        assert_eq!(d.sort, None);

        // "none" is an explicit, well-formed choice.
        let none = parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"none\"}\n```",
        )
        .unwrap();
        assert_eq!(none.kind, ChartDirectiveKind::None);

        // title + sort ride when present and typed correctly.
        let full = parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"line\",\"label_column\":\"month\",\"series_columns\":[\"a\",\"b\"],\"title\":\"Trend\",\"sort\":\"asc\"}\n```",
        )
        .unwrap();
        assert_eq!(full.kind, ChartDirectiveKind::Line);
        assert_eq!(full.title.as_deref(), Some("Trend"));
        assert_eq!(full.sort, Some(ChartSort::Asc));
    }

    #[test]
    fn directive_grammar_rejects_malformed() {
        // No fence at all.
        assert!(parse_chart_directive("plain prose, no request").is_none());
        // Unterminated fence.
        assert!(parse_chart_directive("```lighthouse-chart-request\n{\"kind\":\"bar\"").is_none());
        // Non-JSON body.
        assert!(
            parse_chart_directive("```lighthouse-chart-request\nbar of region\n```").is_none()
        );
        // Unknown kind.
        assert!(parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"pie\",\"label_column\":\"a\",\"series_columns\":[\"b\"]}\n```"
        )
        .is_none());
        // Missing label_column.
        assert!(parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"series_columns\":[\"b\"]}\n```"
        )
        .is_none());
        // series_columns not an array of strings.
        assert!(parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"a\",\"series_columns\":[1]}\n```"
        )
        .is_none());
        // sort outside the whitelist.
        assert!(parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"a\",\"series_columns\":[\"b\"],\"sort\":\"sideways\"}\n```"
        )
        .is_none());
        // Non-string title.
        assert!(parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"a\",\"series_columns\":[\"b\"],\"title\":7}\n```"
        )
        .is_none());
    }

    /// Shared validator fixtures — mirrored byte-for-byte by the node tests in
    /// test/chartSpec.test.mjs (PARITY).
    fn parity_columns() -> Vec<(String, bool)> {
        vec![
            ("region".to_string(), false),
            ("total".to_string(), true),
            ("pct".to_string(), true),
            ("note".to_string(), false),
        ]
    }

    #[test]
    fn directive_validation_rules() {
        let cols = parity_columns();
        let d = |kind: ChartDirectiveKind, label: &str, series: &[&str]| ChartDirective {
            kind,
            label_column: label.to_string(),
            series_columns: series.iter().map(|s| s.to_string()).collect(),
            title: None,
            sort: None,
        };
        // Happy path: real label, 1-2 numeric series.
        assert!(validate_directive(&d(ChartDirectiveKind::Bar, "region", &["total"]), &cols).is_ok());
        assert!(
            validate_directive(&d(ChartDirectiveKind::Line, "region", &["total", "pct"]), &cols)
                .is_ok()
        );
        // "none" is trivially valid.
        assert!(validate_directive(&d(ChartDirectiveKind::None, "", &[]), &cols).is_ok());
        // Unknown label column (exact, case-sensitive).
        assert_eq!(
            validate_directive(&d(ChartDirectiveKind::Bar, "Region", &["total"]), &cols)
                .unwrap_err(),
            "unknown label_column \"Region\""
        );
        // Over-limit series.
        assert_eq!(
            validate_directive(
                &d(ChartDirectiveKind::Bar, "region", &["total", "pct", "total", "pct"]),
                &cols
            )
            .unwrap_err(),
            "series_columns must name 1-3 columns"
        );
        // Empty series.
        assert!(validate_directive(&d(ChartDirectiveKind::Bar, "region", &[]), &cols).is_err());
        // Unknown series column.
        assert_eq!(
            validate_directive(&d(ChartDirectiveKind::Bar, "region", &["revenue"]), &cols)
                .unwrap_err(),
            "unknown series column \"revenue\""
        );
        // Non-numeric series column.
        assert_eq!(
            validate_directive(&d(ChartDirectiveKind::Bar, "region", &["note"]), &cols)
                .unwrap_err(),
            "series column \"note\" is not numeric"
        );
    }

    #[test]
    fn directed_spec_reads_numbers_from_batches_only() {
        let b = batch(&["NE", "NW", "SE"], &[150.0, 300.0, 200.0]);
        // Fabricated values in the directive change NOTHING — the spec's
        // numbers are the batches' numbers, byte-for-byte.
        let d = parse_chart_directive(
            "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"label\",\"series_columns\":[\"total\"],\"values\":[1,2,3],\"x\":[\"a\"]}\n```",
        )
        .unwrap();
        let spec = chart_spec_from_batches_directed(&[b.clone()], &d).unwrap();
        assert_eq!(
            spec,
            r#"{"kind":"bar","series":[{"name":"total","values":[150.0,300.0,200.0]}],"x":["NE","NW","SE"]}"#
        );

        // sort=desc reorders rows engine-side by the first series column.
        let sorted = ChartDirective { sort: Some(ChartSort::Desc), ..d.clone() };
        assert_eq!(
            chart_spec_from_batches_directed(&[b.clone()], &sorted).unwrap(),
            r#"{"kind":"bar","series":[{"name":"total","values":[300.0,200.0,150.0]}],"x":["NW","SE","NE"]}"#
        );
        let asc = ChartDirective { sort: Some(ChartSort::Asc), ..d.clone() };
        assert_eq!(
            chart_spec_from_batches_directed(&[b.clone()], &asc).unwrap(),
            r#"{"kind":"bar","series":[{"name":"total","values":[150.0,200.0,300.0]}],"x":["NE","SE","NW"]}"#
        );

        // The title is capped (~80 chars), control-stripped display copy —
        // and the ONLY directive string that ever reaches the spec.
        let titled = ChartDirective {
            title: Some(format!("  Rev\u{7}enue {}  ", "x".repeat(100))),
            ..d.clone()
        };
        let spec = chart_spec_from_batches_directed(&[b.clone()], &titled).unwrap();
        let v: serde_json::Value = serde_json::from_str(&spec).unwrap();
        let title = v["title"].as_str().unwrap();
        assert_eq!(title.chars().count(), 80);
        assert!(title.starts_with("Revenue x"));
        assert!(!title.contains('\u{7}'));

        // Whitespace-only titles drop the key entirely.
        let blank = ChartDirective { title: Some("  \u{7} ".to_string()), ..d.clone() };
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches_directed(&[b.clone()], &blank).unwrap(),
        )
        .unwrap();
        assert!(v.get("title").is_none());

        // A directed share table still gets the PROVEN stacked treatment.
        let shares = share_batch(&[60.0, 40.0, 55.0], &[40.0, 60.0, 45.0]);
        let two = ChartDirective {
            kind: ChartDirectiveKind::Bar,
            label_column: "region".to_string(),
            series_columns: vec!["share_a".to_string(), "share_b".to_string()],
            title: None,
            sort: None,
        };
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches_directed(&[shares], &two).unwrap(),
        )
        .unwrap();
        assert_eq!(v["stacked"], true);

        // Data-level failures return None (caller falls back): one row…
        let one = batch(&["only"], &[1.0]);
        assert!(chart_spec_from_batches_directed(&[one], &d).is_none());
        // …or an invalid directive (unknown column) against real batches.
        let bad = ChartDirective {
            label_column: "nope".to_string(),
            ..d.clone()
        };
        assert!(chart_spec_from_batches_directed(&[b], &bad).is_none());
    }

    #[test]
    fn directed_matches_heuristic_bytes_for_the_same_choice() {
        // When the directive picks exactly what the heuristic would (no
        // title, no sort), the emitted spec is byte-identical — one emitter,
        // parameterized, not two.
        let b = batch(&["NE", "NW"], &[150.0, 200.0]);
        let d = ChartDirective {
            kind: ChartDirectiveKind::Bar,
            label_column: "label".to_string(),
            series_columns: vec!["total".to_string()],
            title: None,
            sort: None,
        };
        assert_eq!(
            chart_spec_from_batches_directed(&[b.clone()], &d).unwrap(),
            chart_spec_from_batches(&[b]).unwrap()
        );
    }

    #[test]
    fn decide_chart_honors_valid_falls_back_and_never_suppresses() {
        let b = batch(&["NE", "NW"], &[150.0, 200.0]);
        let heuristic =
            r#"{"kind":"bar","series":[{"name":"total","values":[150.0,200.0]}],"x":["NE","NW"]}"#;

        // Valid directive → the directed spec (here byte-equal to the
        // heuristic since it names the same columns).
        let valid = "Done.\n```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"label\",\"series_columns\":[\"total\"]}\n```";
        assert_eq!(decide_chart(&[b.clone()], valid).as_deref(), Some(heuristic));

        // Unknown column → today's heuristic, byte-identical.
        let invalid = "Done.\n```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"regionn\",\"series_columns\":[\"total\"]}\n```";
        assert_eq!(decide_chart(&[b.clone()], invalid).as_deref(), Some(heuristic));

        // Malformed JSON → heuristic.
        let malformed = "Done.\n```lighthouse-chart-request\nnot json\n```";
        assert_eq!(decide_chart(&[b.clone()], malformed).as_deref(), Some(heuristic));

        // No fence at all → heuristic.
        assert_eq!(decide_chart(&[b.clone()], "Done.").as_deref(), Some(heuristic));

        // Charts by default (0.12.1): "none" no longer suppresses a chartable
        // result — it behaves exactly like no directive (heuristic, byte-
        // identical to the undirected spec).
        let none = "Done.\n```lighthouse-chart-request\n{\"kind\":\"none\"}\n```";
        assert_eq!(decide_chart(&[b.clone()], none).as_deref(), Some(heuristic));

        // …while a genuinely non-chartable shape stays uncharted under a
        // "none" too — the heuristic itself declines a single row.
        let single = batch(&["only"], &[1.0]);
        assert!(decide_chart(&[single], none).is_none());
    }

    #[test]
    fn chart_card_rides_only_chartable_shapes() {
        // Chartable (2..=24 rows, ≥1 numeric column) → card with the ACTUAL
        // columns, typed.
        let card = chart_card(&[batch(&["NE", "NW"], &[150.0, 200.0])]).expect("card");
        assert!(card.contains(CHART_CARD_VERSION));
        assert!(card.contains("label (text)"), "{card}");
        assert!(card.contains("total (numeric)"), "{card}");
        assert!(card.contains("```lighthouse-chart-request"), "{card}");

        // A single row is not chartable — no card, no invited directive.
        assert!(chart_card(&[batch(&["only"], &[1.0])]).is_none());
        // 25 rows exceed the point cap.
        let labels: Vec<String> = (0..25).map(|i| format!("r{i}")).collect();
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let values: Vec<f64> = (0..25).map(|i| i as f64).collect();
        assert!(chart_card(&[batch(&refs, &values)]).is_none());
        // No numeric column → no card.
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
        assert!(chart_card(&[two_text]).is_none());
    }

    // The card is PROMPT COPY: pin the full text so any edit is a reviewed
    // diff (bump CHART_CARD_VERSION alongside behavioral changes).
    #[test]
    fn chart_card_snapshot_is_pinned() {
        let card = chart_card(&[batch(&["NE", "NW"], &[150.0, 200.0])]).unwrap();
        let expected = "Chart options (v2) — result columns: label (text), total (numeric).\n\
            End the answer with at most ONE fenced request to choose this answer's chart; the app builds it from the verified result (a request can never supply values):\n\
            ```lighthouse-chart-request\n\
            {\"kind\":\"bar\",\"label_column\":\"region\",\"series_columns\":[\"revenue\"],\"title\":\"Revenue by region\",\"sort\":\"desc\"}\n\
            ```\n\
            kind: bar = categories; line = trend, 2-3 series; area = trend, 1 series; none = you think nothing here is comparable (single number, id/SKU/code labels) — the app still charts results whose shape fits. series_columns: 1-3 numeric columns; title and sort (asc|desc, by first series) optional.\n\
            Examples: (month, total) → {\"kind\":\"area\",\"label_column\":\"month\",\"series_columns\":[\"total\"]} · (store_id, revenue) → {\"kind\":\"none\"}";
        assert_eq!(card, expected);
    }

    #[test]
    fn chart_card_stays_inside_budget() {
        // Maximal shape: 24 long-named columns (list must clip, not overflow)
        // over a full 24-row result — the card must stay inside its ~200-token
        // budget in the worst case, not just the snapshot's.
        let n = 24usize;
        let fields: Vec<Field> = std::iter::once(Field::new(
            "quite_long_label_column_name",
            DataType::Utf8,
            false,
        ))
        .chain((1..n).map(|i| {
            Field::new(
                format!("very_long_numeric_column_name_{i}"),
                DataType::Float64,
                true,
            )
        }))
        .collect();
        let mut cols: Vec<ArrayRef> = vec![Arc::new(StringArray::from(
            (0..24).map(|i| format!("row{i}")).collect::<Vec<_>>(),
        ))];
        for _ in 1..n {
            cols.push(Arc::new(Float64Array::from(
                (0..24).map(|i| i as f64).collect::<Vec<_>>(),
            )));
        }
        let wide = RecordBatch::try_new(Arc::new(Schema::new(fields)), cols).unwrap();
        let card = chart_card(&[wide]).expect("card");
        assert!(
            card.chars().count() <= CHART_CARD_MAX_CHARS,
            "card budget blown: {} chars\n{card}",
            card.chars().count()
        );
        assert!(card.contains(", …"), "long column lists must clip: {card}");
    }

    // Few-shot integrity (copies every_fewshot_example_passes_the_guard):
    // every example the card teaches must parse through the REAL parser and be
    // ACCEPTED by the engine's own validator against its example table — a
    // card edit can't teach syntax the engine rejects.
    #[test]
    fn every_chart_card_example_validates() {
        let card = chart_card(&[batch(&["NE", "NW"], &[150.0, 200.0])]).unwrap();
        for ex in CHART_CARD_EXAMPLES {
            let fenced = format!("```lighthouse-chart-request\n{}\n```", ex.directive);
            let d = parse_chart_directive(&fenced)
                .unwrap_or_else(|| panic!("card example {} does not parse", ex.what));
            let cols: Vec<(String, bool)> = ex
                .columns
                .iter()
                .map(|(n, num)| (n.to_string(), *num))
                .collect();
            validate_directive(&d, &cols)
                .unwrap_or_else(|e| panic!("card example {} rejected: {e}", ex.what));
            // And each example actually rides in the rendered card.
            assert!(
                card.contains(ex.directive),
                "card example {} missing from the card text",
                ex.what
            );
        }
    }

    #[test]
    fn directive_scrubber_withholds_fences_and_flushes_prose() {
        // The fence split across deltas never reaches the forwarded prose.
        let mut s = DirectiveScrubber::new();
        let mut out = String::new();
        for d in [
            "NW leads [1].\n\n```lighthouse-",
            "chart-request\n{\"kind\":\"none\"}",
            "\n```\nDone.",
        ] {
            out.push_str(&s.push(d));
        }
        out.push_str(&s.finish());
        assert_eq!(out, "NW leads [1].\n\nDone.");
        assert!(s.full_text().contains("```lighthouse-chart-request"));

        // Ordinary fences pass through untouched.
        let mut s = DirectiveScrubber::new();
        let mut out = s.push("Look:\n```sql\nSELECT 1\n```\nend");
        out.push_str(&s.finish());
        assert_eq!(out, "Look:\n```sql\nSELECT 1\n```\nend");

        // A tail that LOOKED like the opener but wasn't flushes intact.
        let mut s = DirectiveScrubber::new();
        let mut out = s.push("see ```lighthouse-chart");
        out.push_str(&s.push(" fences"));
        out.push_str(&s.finish());
        assert_eq!(out, "see ```lighthouse-chart fences");

        // A held partial opener at end-of-stream flushes on finish.
        let mut s = DirectiveScrubber::new();
        let mut out = s.push("ends with ```lighthouse-chart");
        out.push_str(&s.finish());
        assert_eq!(out, "ends with ```lighthouse-chart");

        // An UNTERMINATED fence is directive text, not prose — withheld.
        let mut s = DirectiveScrubber::new();
        let mut out = s.push("prose ```lighthouse-chart-request\n{\"kind\":");
        out.push_str(&s.finish());
        assert_eq!(out, "prose ");
    }

    // E2E (model-free): scripted narration deltas drive the exact synth flow —
    // scrub the stream, then decide the chart from the FULL text + batches.
    #[test]
    fn directive_stream_end_to_end() {
        let batches = vec![batch(&["NE", "NW"], &[150.0, 200.0])];
        let heuristic =
            r#"{"kind":"bar","series":[{"name":"total","values":[150.0,200.0]}],"x":["NE","NW"]}"#;
        let run = |deltas: &[&str]| -> (String, Option<String>) {
            let mut s = DirectiveScrubber::new();
            let mut prose = String::new();
            for d in deltas {
                prose.push_str(&s.push(d));
            }
            prose.push_str(&s.finish());
            (prose, decide_chart(&batches, s.full_text()))
        };

        // (a) A valid directive → that chart, numbers byte-identical to the
        //     batches (the same bytes the byte-lock test pins).
        let (prose, chart) = run(&[
            "NW leads with 200 [1].",
            "\n\n```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"label\",",
            "\"series_columns\":[\"total\"]}\n```\n",
        ]);
        assert_eq!(chart.as_deref(), Some(heuristic));
        assert!(!prose.contains("lighthouse-chart-request"), "{prose}");
        assert!(!prose.contains("```"), "{prose}");
        assert_eq!(prose, "NW leads with 200 [1].\n\n");

        // (b) An invalid directive (unknown column) → today's heuristic.
        let (prose, chart) = run(&[
            "NW leads [1].\n```lighthouse-chart-request\n",
            "{\"kind\":\"bar\",\"label_column\":\"nope\",\"series_columns\":[\"total\"]}\n```",
        ]);
        assert_eq!(chart.as_deref(), Some(heuristic));
        assert!(!prose.contains("lighthouse-chart-request"), "{prose}");

        // (c) "none" over a chartable result → the heuristic chart anyway
        //     (charts by default, 0.12.1): the fence is still scrubbed from
        //     prose, but the engine — not the model — decides chartability.
        let (prose, chart) = run(&[
            "The total is a single figure [1].\n",
            "```lighthouse-chart-request\n{\"kind\":\"none\"}\n```",
        ]);
        assert_eq!(chart.as_deref(), Some(heuristic));
        assert!(!prose.contains("lighthouse-chart-request"), "{prose}");
    }

    // Golden misfire fixtures (openspec: add-chart-directive §4.1): the known
    // misfire classes assert kind-or-none for the heuristic AND what a
    // deliberate directive may do. The chart_eval example runs these same
    // shapes through the real executor as the CI floor.
    #[test]
    fn golden_misfire_fixtures_choose_kind_or_none() {
        // Date-ish labels: months stay a single-series AREA…
        let months = batch(&["2024-01", "2024-02", "2024-03"], &[1.0, 2.0, 3.0]);
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[months.clone()]).unwrap()).unwrap();
        assert_eq!(v["kind"], "area");
        // …and a directive may deliberately restyle the SAME numbers as line.
        let line = ChartDirective {
            kind: ChartDirectiveKind::Line,
            label_column: "label".to_string(),
            series_columns: vec!["total".to_string()],
            title: None,
            sort: None,
        };
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches_directed(&[months], &line).unwrap(),
        )
        .unwrap();
        assert_eq!(v["kind"], "line");
        assert_eq!(v["series"][0]["values"][2], 3.0);

        // Top-N candidates: categorical bar; a directed desc sort presents
        // the ranking without touching a number.
        let topn = batch(
            &["acme", "globex", "initech", "umbrella", "wayne"],
            &[50.0, 900.0, 300.0, 120.0, 700.0],
        );
        let v: serde_json::Value =
            serde_json::from_str(&chart_spec_from_batches(&[topn.clone()]).unwrap()).unwrap();
        assert_eq!(v["kind"], "bar");
        let ranked = ChartDirective {
            kind: ChartDirectiveKind::Bar,
            label_column: "label".to_string(),
            series_columns: vec!["total".to_string()],
            title: None,
            sort: Some(ChartSort::Desc),
        };
        let v: serde_json::Value = serde_json::from_str(
            &chart_spec_from_batches_directed(&[topn], &ranked).unwrap(),
        )
        .unwrap();
        assert_eq!(v["x"][0], "globex");
        assert_eq!(v["series"][0]["values"][0], 900.0);

        // A single-value result is never a chart — heuristic declines, and a
        // directive cannot rescue it (decide falls back → still nothing).
        let single = batch(&["total"], &[385.0]);
        assert!(chart_spec_from_batches(&[single.clone()]).is_none());
        let forced = "```lighthouse-chart-request\n{\"kind\":\"bar\",\"label_column\":\"label\",\"series_columns\":[\"total\"]}\n```";
        assert!(decide_chart(&[single], forced).is_none());

        // Identifier columns: 4-digit ids in an id-NAMED column draw nothing
        // by default (covered above for the directed rescue).
        let ids = RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("store_id", DataType::Int64, false),
                Field::new("revenue", DataType::Float64, true),
            ])),
            vec![
                Arc::new(datafusion::arrow::array::Int64Array::from(vec![
                    1001, 1002, 1003, 1004,
                ])),
                Arc::new(Float64Array::from(vec![5.0, 6.0, 7.0, 8.0])),
            ],
        )
        .unwrap();
        assert!(chart_spec_from_batches(&[ids]).is_none());
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
            capped_rows: None,
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

    #[test]
    fn join_hints_excluding_wins_the_pair_and_is_byte_identical_when_empty() {
        // openspec: add-semantic-layer §2.4 — a curated hint over the (orders,
        // reps) pair suppresses the heuristic line for that pair, while other
        // pairs still hint. An EMPTY exclusion set reproduces `join_hints`.
        let reg = |table: &str, cols: &[&str]| TableReg {
            table: table.into(),
            file_id: table.into(),
            file_name: format!("{table}.csv"),
            card: String::new(),
            modified_ms: None,
            columns: cols.iter().map(|s| s.to_string()).collect(),
            group: None,
            capped_rows: None,
        };
        let regs = vec![
            reg("orders", &["rep", "region"]),
            reg("reps", &["rep", "team"]),
            reg("regions", &["region", "label"]),
        ];
        // Baseline: both shared-column pairs hint.
        let base = join_hints(&regs).expect("hints");
        assert!(base.contains("- orders.rep = reps.rep"), "{base}");
        assert!(base.contains("- orders.region = regions.region"), "{base}");
        // The empty exclusion is byte-identical to `join_hints`.
        assert_eq!(join_hints_excluding(&regs, &[]), Some(base.clone()));

        // Excluding (orders, reps) drops ONLY that pair's line; order-insensitive.
        let merged = join_hints_excluding(&regs, &[("reps".into(), "orders".into())]).expect("hints");
        assert!(!merged.contains("orders.rep = reps.rep"), "curated pair suppressed: {merged}");
        assert!(merged.contains("- orders.region = regions.region"), "other pairs remain: {merged}");

        // Excluding every hinted pair collapses the card to None.
        assert!(join_hints_excluding(
            &regs,
            &[("orders".into(), "reps".into()), ("orders".into(), "regions".into())],
        )
        .is_none());
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
        let regs = register_tables(&ctx, &files, false).await;
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
        let regs = register_tables(&ctx, &files, false).await;
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
/// `max_steps` is the Beam loop's configured step budget (openspec:
/// add-beam-loop §2.3) — the former hardcoded "3" now reads the budget so the
/// prompt matches the loop's actual bound. Budget: ~8k chars per completed step
/// at the STEP_RESULT_CAP carry, comfortably inside every remote window at the
/// default budget (unit-tested).
pub fn step_question(question: &str, steps: &[StepRecord], max_steps: usize) -> String {
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
         up to {max_steps} SQL queries total, one at a time.\n\
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
) -> Result<(SessionContext, Vec<TableReg>, Vec<ViewReg>, usize), String> {
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
    // Direct SQL re-execution is model-free (no cloud egress of columns/rows),
    // so local-only is inert here — exclusion already bound via the active set
    // above. Pass is_cloud=false to keep the belt-and-suspenders filter off.
    let regs = register_tables(&ctx, &files, false).await;
    if regs.is_empty() {
        return Err("the files couldn't be registered as tables".to_string());
    }
    // Saved views resolve here too (openspec: add-shaped-views §2), so a
    // re-executed query naming one still runs. Model-free like the rest of
    // the direct path — local-only is inert by design, mirroring the
    // is_cloud=false above.
    let view_regs = register_views(&ctx, &regs, false).await;
    Ok((ctx, regs, view_regs, skipped))
}

/// A grouped-thousands integer: 12431 → "12,431" — read-out friendly for the
/// truncation footer.
pub(crate) fn commafy(n: usize) -> String {
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

/// Deterministic disclosure when a single workbook registered only its
/// leading rows (`TableReg::capped_rows`): the answer must say the analysis
/// reads the first N rows, never the whole file. One line per capped file
/// (deduped — a multi-sheet book can cap several sheets), engine text only.
/// Union-family omissions never fire here: they drop whole members and are
/// disclosed via the group card note + the coverage footer instead. `None`
/// when nothing was capped — the untruncated path stays byte-identical.
pub fn row_cap_footer(regs: &[TableReg]) -> Option<String> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out = String::new();
    for r in regs {
        if r.group.is_some() {
            continue; // group drops are disclosed by the coverage footer
        }
        let Some(n) = r.capped_rows else { continue };
        if !seen.insert(r.file_id.as_str()) {
            continue;
        }
        out.push_str(&format!(
            "_“{}” analyzed to its first {} rows (workbook row cap)._\n",
            r.file_name,
            commafy(n)
        ));
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn direct_footer(
    sql: &str,
    regs: &[TableReg],
    view_regs: &[ViewReg],
    skipped: usize,
    res: &QueryResult,
) -> String {
    let mut footer = format!("*Query used:*\n```sql\n{sql}\n```\n");
    // A query FROM a saved view still names its SOURCE files here — the
    // expansion is freshness-only and never renders (openspec:
    // add-shaped-views §2).
    if let Some(fresh) = freshness_line(
        regs,
        &expand_views_for_freshness(sql, view_regs),
        crate::config::now_ms(),
    ) {
        footer.push_str(&fresh);
    }
    if let Some(trunc) = truncation_footer(res.shown, res.truncated, res.total) {
        footer.push_str(&trunc);
    }
    // The same row-cap honesty as the ask path: a re-executed query over a
    // capped workbook must not read as covering the whole file.
    if let Some(cap) = row_cap_footer(regs) {
        footer.push_str(&cap);
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
    let (ctx, regs, view_regs, skipped) = direct_tables(file_ids).await?;
    let res = run_query(&ctx, sql).await?;
    let footer = direct_footer(sql, &regs, &view_regs, skipped, &res);
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
    let (ctx, regs, view_regs, skipped) = direct_tables(file_ids).await?;
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
    let footer = direct_footer(sql, &regs, &view_regs, skipped, &res);
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

/// Regression tests for the Beam v3 correctness audit (openspec:
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
            capped_rows: None,
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

// Registration-caps audit (docs/beam-caps-audit.md): the two fixture pairs the
// audit demanded. Path-registered formats (CSV/TSV/Parquet) STREAM — the
// workbook row cap must never touch them, and their aggregates cover every
// row with no cap wording anywhere. Materialized workbooks (xlsx/xls) DO cap
// at MAX_XLSX_ROWS — kept for memory, but never silently: the registration
// records it, the schema card leads with it, and `row_cap_footer` names the
// file in engine text.
#[cfg(test)]
mod row_cap_disclosure {
    use super::*;
    use std::io::Write as _;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lh-rowcap-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Minimal single-sheet .xlsx (the same zip-of-OOXML-parts pattern the
    /// extraction tests use for .docx): header `id,amount` + `data_rows`
    /// numeric rows with amount = 1 each.
    fn write_xlsx(path: &std::path::Path, data_rows: usize) {
        let mut sheet = String::with_capacity(64 * (data_rows + 2));
        sheet.push_str(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
        );
        sheet.push_str(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>amount</t></is></c></row>"#,
        );
        for i in 0..data_rows {
            let r = i + 2;
            sheet.push_str(&format!(
                r#"<row r="{r}"><c r="A{r}"><v>{}</v></c><c r="B{r}"><v>1</v></c></row>"#,
                i + 1
            ));
        }
        sheet.push_str("</sheetData></worksheet>");

        let parts: &[(&str, String)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#
                    .to_string(),
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
                    .to_string(),
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#
                    .to_string(),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#
                    .to_string(),
            ),
            ("xl/worksheets/sheet1.xml", sheet),
        ];
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, body) in parts {
            zip.start_file::<_, ()>(*name, Default::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    // Fixture A — guards streaming: a CSV bigger than the workbook row cap
    // registers by path, DataFusion streams it, and the aggregate covers ALL
    // rows exactly (sum 1..=120000 — a silently capped read cannot produce
    // this number). No truncation/cap wording anywhere: not on the card, not
    // in the result markdown, and neither honesty footer fires.
    #[tokio::test]
    async fn big_csv_streams_every_row_with_no_cap_note() {
        let dir = temp_dir("csv");
        let n = 120_000usize; // comfortably past MAX_XLSX_ROWS
        let mut csv = String::with_capacity(16 * (n + 1));
        csv.push_str("id,amount\n");
        for i in 1..=n {
            csv.push_str(&format!("{i},{i}\n"));
        }
        let path = dir.join("ledger.csv");
        std::fs::write(&path, csv).unwrap();

        let ctx = SessionContext::new();
        let files = vec![("f1".to_string(), "ledger.csv".to_string(), path)];
        let regs = register_tables(&ctx, &files, false).await;
        assert_eq!(regs.len(), 1);
        assert!(
            regs[0].capped_rows.is_none(),
            "a path-registered CSV must never row-cap"
        );
        assert!(!regs[0].card.contains("row cap"), "{}", regs[0].card);

        let res = run_query(
            &ctx,
            "SELECT SUM(amount) AS total, COUNT(*) AS n FROM ledger",
        )
        .await
        .unwrap();
        assert!(
            res.markdown.contains("7200060000"),
            "sum must cover all 120k rows: {}",
            res.markdown
        );
        assert!(res.markdown.contains("120000"), "{}", res.markdown);
        assert!(!res.truncated);
        assert!(truncation_footer(res.shown, res.truncated, res.total).is_none());
        assert!(
            row_cap_footer(&regs).is_none(),
            "no workbook-cap footer for a streamed format"
        );
        assert!(
            !res.markdown.to_lowercase().contains("cap"),
            "{}",
            res.markdown
        );
        assert_eq!(unregistered_count(&files, &regs), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Fixture B — the audit's one real gap, now closed: a single workbook
    // with more data rows than MAX_XLSX_ROWS registers capped AND discloses
    // it — `capped_rows` recorded, the schema card LEADS with the row-cap
    // note (model-facing, survives clipping), and `row_cap_footer` names the
    // file deterministically (user-facing). Before this change the same
    // registration truncated silently.
    #[tokio::test]
    async fn oversize_workbook_caps_with_card_note_and_footer() {
        let dir = temp_dir("xlsx");
        let path = dir.join("big.xlsx");
        write_xlsx(&path, MAX_XLSX_ROWS + 1);

        let ctx = SessionContext::new();
        let files = vec![("f1".to_string(), "big.xlsx".to_string(), path)];
        let regs = register_tables(&ctx, &files, false).await;
        assert_eq!(regs.len(), 1);
        let reg = &regs[0];
        assert_eq!(
            reg.capped_rows,
            Some(MAX_XLSX_ROWS),
            "registration must record the cap"
        );
        // Model-facing: the cap leads the card, so clipping can't hide it and
        // the model can't claim full-file totals.
        assert!(
            reg.card
                .starts_with("big — row cap: only the first 100,000 rows of big.xlsx are included"),
            "{}",
            reg.card
        );
        // The registered table holds exactly the cap.
        let res = run_query(&ctx, "SELECT COUNT(*) AS n FROM big").await.unwrap();
        assert!(res.markdown.contains("100000"), "{}", res.markdown);
        // User-facing: deterministic engine footer naming the file.
        assert_eq!(
            row_cap_footer(&regs).as_deref(),
            Some("_“big.xlsx” analyzed to its first 100,000 rows (workbook row cap)._\n")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A union family's row-cap omissions drop WHOLE members and are disclosed
    // via the group card note + the coverage footer — the per-file row-cap
    // footer must never double-fire for them.
    #[test]
    fn union_drops_never_fire_the_row_cap_footer() {
        let grouped = TableReg {
            table: "sales_all".into(),
            file_id: "a".into(),
            file_name: "sales*.xlsx".into(),
            card: "sales_all unions 2 files (a.xlsx, b.xlsx) — row cap: 1 older file(s) NOT included\n…".into(),
            modified_ms: None,
            columns: vec![],
            group: Some(GroupMeta {
                file_ids: vec!["a".into(), "b".into()],
                file_names: vec!["a.xlsx".into(), "b.xlsx".into()],
                newest_ms: 0,
            }),
            capped_rows: None,
        };
        assert!(row_cap_footer(&[grouped]).is_none());
    }
}
