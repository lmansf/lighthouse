//! Meta-answers: deterministic, model-free answers to questions ABOUT the
//! corpus — "what's new this week?", "what spreadsheets do I have?",
//! "which files have an employee id column?" (openspec: add-vault-meta-answers;
//! re-pointed at a conversation's attachments by refocus-chat-attachments).
//!
//! The synthesis pipeline consults `meta_intent` before its analytics branch;
//! a `Some` intent renders instantly from attachment metadata (names, kinds,
//! mtimes) and — for column questions — the column catalog, with real
//! references.
//! Cues are ANCHORED phrase patterns, not keywords: a question that merely
//! mentions files ("what's new in the Q3 report?") never lands here. Any
//! renderer error falls through to the normal pipeline with nothing emitted.
//!
//! KEEP IN SYNC with src/server/meta.ts (cue table + WhatsNew/ListFiles
//! renderers; FindColumn and suggested asks are Rust-engine-only — the
//! catalog has no TS twin, PARITY).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use datafusion::arrow::array::{ArrayRef, Float64Array, StringArray};
use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::record_batch::RecordBatch;
use serde::Serialize;

use crate::analytics::{is_tabular, sanitize_table_name, saved_age_label};
use crate::catalog::{self, ColumnKind};
use crate::contracts::RagReference;

/// Most files a WhatsNew answer lists.
const WHATS_NEW_MAX: usize = 15;
/// Most names a ListFiles answer spells out (counts cover the rest).
const LIST_FILES_MAX: usize = 10;
/// Recent tabular files consulted for suggested asks.
const SUGGEST_FILES: usize = 3;
/// Most suggestions returned.
const SUGGEST_MAX: usize = 4;

// --- Intent ----------------------------------------------------------------------

/// A recognized corpus-meta question. Fields are pre-parsed so renderers stay
/// pure.
#[derive(Debug, Clone, PartialEq)]
pub enum MetaIntent {
    /// "what's new [this week]" — recently modified included files. The window
    /// is relative to now; `None` means "just show the newest".
    WhatsNew { window_ms: Option<i64> },
    /// "what files/spreadsheets do I have", "list my …" — inventory by kind.
    ListFiles { kind: Option<KindFilter> },
    /// "which files have a column X" — column membership from the catalog.
    FindColumn { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindFilter {
    Spreadsheets,
    Documents,
    Pdfs,
}

/// Lowercase, collapse runs of whitespace, trim, and drop trailing punctuation
/// so cue matching sees a canonical question.
fn norm(question: &str) -> String {
    let lower = question.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut last_space = true;
    for ch in lower.chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim_end_matches(['?', '!', '.', ' ']).trim().to_string()
}

/// The words a WhatsNew tail may contain. Anything else means the question is
/// scoped to something we can't verify (usually a document name) → not meta.
/// KEEP IN SYNC with src/server/meta.ts.
const WHATS_NEW_TAIL_WORDS: &[&str] = &[
    "in", "to", "with", "my", "the", "chat", "here", "attached", "vault", "files", "file",
    "documents", "docs",
    "today", "yesterday", "this", "past", "last", "week", "month", "recently", "lately",
];

const WHATS_NEW_FRAMES: &[&str] = &[
    "what's new",
    "whats new",
    "what is new",
    "what's changed",
    "whats changed",
    "what changed",
    "what has changed",
    "what did i add",
    "what have i added",
    "anything new",
];

const DAY_MS: i64 = 86_400_000;

/// Match `q` against an anchored frame; `Some(tail)` only when the frame ends
/// on a word boundary ("what's newest" must not match "what's new").
fn frame_tail<'a>(q: &'a str, frame: &str) -> Option<&'a str> {
    let rest = q.strip_prefix(frame)?;
    if rest.is_empty() {
        return Some("");
    }
    rest.strip_prefix(' ')
}

fn whats_new_intent(q: &str) -> Option<MetaIntent> {
    let tail = WHATS_NEW_FRAMES.iter().find_map(|f| frame_tail(q, f))?;
    // Document-name guard: every tail word must be from the allow-list.
    if !tail.split(' ').filter(|w| !w.is_empty()).all(|w| WHATS_NEW_TAIL_WORDS.contains(&w)) {
        return None;
    }
    let window_ms = if tail.contains("today") {
        Some(DAY_MS)
    } else if tail.contains("yesterday") {
        Some(2 * DAY_MS)
    } else if tail.contains("week") {
        Some(7 * DAY_MS)
    } else if tail.contains("month") {
        Some(31 * DAY_MS)
    } else if tail.contains("recently") || tail.contains("lately") {
        Some(7 * DAY_MS)
    } else {
        None
    };
    Some(MetaIntent::WhatsNew { window_ms })
}

/// Kind nouns a ListFiles cue can name. KEEP IN SYNC with src/server/meta.ts.
fn kind_of_word(w: &str) -> Option<Option<KindFilter>> {
    match w {
        "files" => Some(None),
        "spreadsheets" | "tables" | "csvs" => Some(Some(KindFilter::Spreadsheets)),
        "documents" | "docs" => Some(Some(KindFilter::Documents)),
        "pdfs" => Some(Some(KindFilter::Pdfs)),
        _ => None,
    }
}

/// A ListFiles tail may only point back at THIS corpus ("in this chat", "here").
/// "vault" survives as a legacy alias so a returning user's phrasing still
/// lands. KEEP IN SYNC with src/server/meta.ts::corpusTailOk.
fn corpus_tail_ok(tail: &str) -> bool {
    tail.split(' ')
        .filter(|w| !w.is_empty())
        .all(|w| matches!(w, "in" | "my" | "the" | "this" | "chat" | "here" | "attached" | "vault"))
}

fn list_files_intent(q: &str) -> Option<MetaIntent> {
    // "what|which|how many <kind> do i have [in this chat]" — "how many" is the
    // count phrasing that §2 answers with a stat tile. KEEP IN SYNC with meta.ts.
    for lead in ["what ", "which ", "how many "] {
        if let Some(rest) = q.strip_prefix(lead) {
            let (kind_word, after) = rest.split_once(' ').unwrap_or((rest, ""));
            if let Some(kind) = kind_of_word(kind_word) {
                if let Some(tail) = frame_tail(after, "do i have") {
                    if corpus_tail_ok(tail) {
                        return Some(MetaIntent::ListFiles { kind });
                    }
                }
            }
        }
    }
    // "list|show me [all] [of] my <kind>"
    for lead in ["list ", "show me ", "show "] {
        if let Some(rest) = q.strip_prefix(lead) {
            let rest = rest.strip_prefix("all ").unwrap_or(rest);
            let rest = rest.strip_prefix("of ").unwrap_or(rest);
            let rest = rest.strip_prefix("my ").unwrap_or(rest);
            let (kind_word, after) = rest.split_once(' ').unwrap_or((rest, ""));
            if let Some(kind) = kind_of_word(kind_word) {
                if corpus_tail_ok(after) {
                    return Some(MetaIntent::ListFiles { kind });
                }
            }
        }
    }
    None
}

fn find_column_intent(q: &str) -> Option<MetaIntent> {
    const LEADS: &[&str] = &[
        "which files have",
        "which files contain",
        "what files have",
        "what files contain",
        "which of my files have",
        "which of my files contain",
        "who has",
    ];
    let rest = LEADS.iter().find_map(|l| frame_tail(q, l))?;
    if rest.is_empty() {
        return None;
    }
    // "… a column <name>" | "… a column called|named <name>"
    for lead in ["a column ", "an column ", "the column ", "column "] {
        if let Some(name) = rest.strip_prefix(lead) {
            let name = name.strip_prefix("called ").or_else(|| name.strip_prefix("named ")).unwrap_or(name);
            return column_name_intent(name);
        }
    }
    // "… a <name> column" | "… an <name> column"
    if let Some(middle) = rest.strip_suffix(" column").or_else(|| rest.strip_suffix(" columns")) {
        let middle = middle
            .strip_prefix("a ")
            .or_else(|| middle.strip_prefix("an "))
            .or_else(|| middle.strip_prefix("the "))
            .unwrap_or(middle);
        return column_name_intent(middle);
    }
    None
}

fn column_name_intent(raw: &str) -> Option<MetaIntent> {
    let name = raw.trim().trim_matches(['"', '“', '”', '\'', '`']).trim().to_string();
    // A column name is a short noun phrase; a long tail means the question is
    // about content, not schema.
    if name.is_empty() || name.split(' ').count() > 4 || name.len() > 48 {
        return None;
    }
    Some(MetaIntent::FindColumn { name })
}

/// The anchored cue gate. `None` = not a vault-meta question — the normal
/// pipeline runs. Pure and cheap (string scans, no IO).
pub fn meta_intent(question: &str) -> Option<MetaIntent> {
    let q = norm(question);
    if q.is_empty() {
        return None;
    }
    whats_new_intent(&q)
        .or_else(|| list_files_intent(&q))
        .or_else(|| find_column_intent(&q))
}

// --- Renderers -------------------------------------------------------------------

/// A fully rendered meta-answer: markdown plus the references it cites.
pub struct MetaAnswer {
    pub markdown: String,
    pub references: Vec<RagReference>,
}

/// Included **and available** files with mtimes, newest first. The inclusion
/// set is intersected with the engine's active walk exactly like the
/// analytics branch, so a stale client id can't resurrect an excluded file.
fn included_files_with_mtime(
    conversation_id: &str,
    included: &[String],
) -> Vec<(String, String, PathBuf, i64)> {
    // Since 0.15.0 these are a conversation's ATTACHMENTS: attaching is the
    // consent, so there is no shareable-set intersection left to do — an id
    // either resolves in the manifest or it is gone. An EMPTY list means the
    // whole conversation, the same rule `Corpus::candidates` and
    // `workspace::retrieve` follow, so an ask that names no subset still has a
    // corpus to answer meta questions about.
    let all: Vec<String>;
    let included = if included.is_empty() {
        all = crate::workspace::list(conversation_id).into_iter().map(|f| f.id).collect();
        &all[..]
    } else {
        included
    };
    let mut out: Vec<(String, String, PathBuf, i64)> = Vec::new();
    for id in included {
        if let Some((name, abs)) = crate::workspace::resolve(conversation_id, id) {
            let ms = std::fs::metadata(&abs)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push((id.clone(), name, abs, ms));
        }
    }
    out.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.1.cmp(&b.1)));
    out
}

/// Coarse kind label from the extension — display taxonomy, not MIME truth.
fn kind_label(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "csv" | "tsv" | "xlsx" | "xlsm" | "xls" | "parquet" => "spreadsheet",
        "pdf" => "PDF",
        "doc" | "docx" | "rtf" | "odt" | "md" | "txt" | "html" | "htm" => "document",
        _ => "file",
    }
}

fn matches_filter(name: &str, filter: KindFilter) -> bool {
    match filter {
        KindFilter::Spreadsheets => kind_label(name) == "spreadsheet",
        KindFilter::Documents => kind_label(name) == "document",
        KindFilter::Pdfs => kind_label(name) == "PDF",
    }
}

fn reference(id: &str, name: &str, snippet: String, rank: usize) -> RagReference {
    RagReference {
        file_id: id.to_string(),
        name: name.to_string(),
        snippet,
        // Descending with list order so any score-sorted rendering preserves it.
        score: (1.0 - rank as f64 * 0.02).max(0.5),
        kind: crate::retrieval::source_kind_of(id),
    }
}

fn whats_new(
    conversation_id: &str,
    included: &[String],
    window_ms: Option<i64>,
    now_ms: i64,
) -> Result<MetaAnswer, String> {
    let files = included_files_with_mtime(conversation_id, included);
    if files.is_empty() {
        return Err("no included files".into());
    }
    let scoped: Vec<_> = match window_ms {
        Some(w) => files.iter().filter(|f| f.3 >= now_ms - w).collect(),
        None => files.iter().collect(),
    };
    let window_label = match window_ms {
        Some(w) if w <= DAY_MS => "in the last day",
        Some(w) if w <= 2 * DAY_MS => "in the last two days",
        Some(w) if w <= 7 * DAY_MS => "in the last week",
        Some(_) => "in the last month",
        None => "",
    };
    if scoped.is_empty() {
        // Honest empty window — still deterministic, still cite the newest file.
        let (id, name, _, ms) = &files[0];
        let age = saved_age_label(*ms, now_ms);
        return Ok(MetaAnswer {
            markdown: format!(
                "Nothing visible to AI changed {window_label}. The most recent file is **{name}** (saved {age})."
            ),
            references: vec![reference(id, name, format!("{} · saved {age}", kind_label(name)), 0)],
        });
    }
    let heading = if window_label.is_empty() {
        "Your most recently updated files visible to AI:".to_string()
    } else {
        format!(
            "{} file{} visible to AI changed {window_label}:",
            scoped.len(),
            if scoped.len() == 1 { "" } else { "s" }
        )
    };
    let mut lines = vec![heading, String::new()];
    let mut references = Vec::new();
    for (i, (id, name, _, ms)) in scoped.iter().take(WHATS_NEW_MAX).enumerate() {
        let age = saved_age_label(*ms, now_ms);
        lines.push(format!("- **{name}** — {}, saved {age}", kind_label(name)));
        references.push(reference(id, name, format!("{} · saved {age}", kind_label(name)), i));
    }
    if scoped.len() > WHATS_NEW_MAX {
        lines.push(format!("- …and {} more.", scoped.len() - WHATS_NEW_MAX));
    }
    Ok(MetaAnswer { markdown: lines.join("\n"), references })
}

fn list_files(
    conversation_id: &str,
    included: &[String],
    kind: Option<KindFilter>,
    now_ms: i64,
) -> Result<MetaAnswer, String> {
    let files = included_files_with_mtime(conversation_id, included);
    if files.is_empty() {
        return Err("no included files".into());
    }
    let scoped: Vec<_> = match kind {
        Some(f) => files.iter().filter(|x| matches_filter(&x.1, f)).collect(),
        None => files.iter().collect(),
    };
    let noun = match kind {
        Some(KindFilter::Spreadsheets) => "spreadsheet",
        Some(KindFilter::Documents) => "document",
        Some(KindFilter::Pdfs) => "PDF",
        None => "file",
    };
    if scoped.is_empty() {
        // Zero of the asked-for kind: say so, with the overall counts for scent.
        return Ok(MetaAnswer {
            markdown: format!(
                "No {noun}s are visible to AI right now ({} file{} total: {}).",
                files.len(),
                if files.len() == 1 { "" } else { "s" },
                count_line(&files)
            ),
            references: Vec::new(),
        });
    }
    let mut lines = vec![
        if kind.is_some() {
            format!(
                "**{} {noun}{}** visible to AI:",
                scoped.len(),
                if scoped.len() == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "**{} file{}** visible to AI — {}:",
                scoped.len(),
                if scoped.len() == 1 { "" } else { "s" },
                count_line(&files)
            )
        },
        String::new(),
    ];
    let mut references = Vec::new();
    for (i, (id, name, _, ms)) in scoped.iter().take(LIST_FILES_MAX).enumerate() {
        let age = saved_age_label(*ms, now_ms);
        lines.push(format!("- **{name}** — {}, saved {age}", kind_label(name)));
        references.push(reference(id, name, format!("{} · saved {age}", kind_label(name)), i));
    }
    if scoped.len() > LIST_FILES_MAX {
        lines.push(format!("- …and {} more.", scoped.len() - LIST_FILES_MAX));
    }
    // §2 visual-first: the count IS engine-verified quantitative data, so it
    // renders a visual by default — a single kind's count as a stat tile, the
    // whole-vault breakdown as a compact bar. Built from the structured file
    // inventory (kind counts), never from the prose count line.
    let mut markdown = lines.join("\n");
    if let Some(visual) = list_files_visual(kind, scoped.len(), &files, noun) {
        markdown.push_str("\n\n");
        markdown.push_str(&visual);
    }
    Ok(MetaAnswer { markdown, references })
}

/// Kind counts (spreadsheet / document / PDF / file) over the inventory, biggest
/// first — the structured form both `count_line` and the §2 count visual read.
fn kind_counts(files: &[(String, String, PathBuf, i64)]) -> Vec<(&'static str, usize)> {
    let mut counts: Vec<(&'static str, usize)> = Vec::new();
    for (_, name, _, _) in files {
        let label = kind_label(name);
        match counts.iter_mut().find(|(l, _)| *l == label) {
            Some((_, n)) => *n += 1,
            None => counts.push((label, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts
}

/// "5 spreadsheets, 3 documents, 2 PDFs" — only non-zero buckets, biggest first.
fn count_line(files: &[(String, String, PathBuf, i64)]) -> String {
    kind_counts(files)
        .iter()
        .map(|&(label, n)| plural(label, n))
        .collect::<Vec<_>>()
        .join(", ")
}

/// "1 PDF" / "3 PDFs" — the count line's own pluralization, reused for the
/// visual labels so the tile/bar reads exactly like the prose. KEEP IN SYNC
/// with meta.ts (`plural`).
fn plural(label: &str, n: usize) -> String {
    let s = if n == 1 { "" } else { "s" };
    format!("{n} {label}{s}")
}

/// The bare plural noun ("PDFs", "spreadsheets") for a bar x-label / a stat
/// caption — the count-prefixed form is `plural`. KEEP IN SYNC with meta.ts.
fn plural_noun(label: &str, n: usize) -> String {
    if n == 1 { label.to_string() } else { format!("{label}s") }
}

/// A `lighthouse-stat` fence: an inline stat tile carrying ONE engine number and
/// its caption (StatValue shape). Fixed key order for byte-parity with the TS
/// twin; the caption is an engine noun, so no escaping is needed. KEEP IN SYNC
/// with meta.ts (`statFence`).
fn stat_fence(value: usize, label: &str) -> String {
    format!("```lighthouse-stat\n{{\"raw\":\"{value}\",\"value\":{value},\"label\":\"{label}\"}}\n```")
}

/// The by-kind counts as a bar chart spec, or None with fewer than two kinds
/// (a single number is a tile, not a bar). Routed through the SAME emitter the
/// analytics path uses — a two-column `RecordBatch` (kind label × count) fed to
/// `chart_spec_from_batches` — so the visual is provably built from catalog
/// counts, never from prose. PARITY: meta.ts::countsBarSpec mirrors the
/// decision (JSON differs only in float formatting).
pub fn counts_bar_spec(counts: &[(&str, usize)]) -> Option<String> {
    if counts.len() < 2 {
        return None;
    }
    let labels: Vec<String> = counts.iter().map(|&(l, n)| plural_noun(l, n)).collect();
    let values: Vec<f64> = counts.iter().map(|&(_, n)| n as f64).collect();
    let schema = Arc::new(Schema::new(vec![
        Field::new("kind", DataType::Utf8, false),
        Field::new("files", DataType::Float64, true),
    ]));
    let columns: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(
            labels.iter().map(|s| s.as_str()).collect::<Vec<&str>>(),
        )),
        Arc::new(Float64Array::from(values)),
    ];
    let batch = RecordBatch::try_new(schema, columns).ok()?;
    crate::analytics::chart_spec_from_batches(&[batch])
}

/// The visual a ListFiles answer carries by default: a single kind's count as a
/// stat tile, the whole-vault composition as a compact bar (falling back to a
/// total tile when there is only one kind). None only when there is genuinely
/// nothing to show. KEEP IN SYNC with meta.ts (`listFilesVisual`).
fn list_files_visual(
    kind: Option<KindFilter>,
    scoped_len: usize,
    files: &[(String, String, PathBuf, i64)],
    noun: &str,
) -> Option<String> {
    match kind {
        // A single asked-for kind → one number → a stat tile.
        Some(_) => Some(stat_fence(scoped_len, &plural_noun(noun, scoped_len))),
        // The whole vault → the by-kind breakdown as a bar, else a total tile.
        None => {
            let counts = kind_counts(files);
            counts_bar_spec(&counts)
                .map(|spec| format!("```lighthouse-chart\n{spec}\n```"))
                .or_else(|| Some(stat_fence(files.len(), &plural_noun("file", files.len()))))
        }
    }
}

fn find_column(conversation_id: &str, included: &[String], raw_name: &str) -> Result<MetaAnswer, String> {
    let want = sanitize_table_name(raw_name);
    if want.is_empty() || want == "table" {
        return Err("unusable column name".into());
    }
    let tabular: Vec<(String, String, PathBuf)> = included_files_with_mtime(conversation_id, included)
        .into_iter()
        .filter(|(_, name, _, _)| is_tabular(name))
        .map(|(id, name, abs, _)| (id, name, abs))
        .collect();
    if tabular.is_empty() {
        return Ok(MetaAnswer {
            markdown: format!(
                "None of the files visible to AI are spreadsheets, so there's nothing to check for a “{raw_name}” column."
            ),
            references: Vec::new(),
        });
    }
    let checked = tabular.len();
    let cols = catalog::columns_for(&tabular);
    let mut matches: Vec<(String, String, String, ColumnKind)> = Vec::new();
    for fc in &cols {
        if let Some(c) = fc
            .columns
            .iter()
            .find(|c| c.name == want)
            .or_else(|| fc.columns.iter().find(|c| c.name.contains(&want)))
        {
            matches.push((fc.id.clone(), fc.name.clone(), c.name.clone(), c.kind));
        }
    }
    if matches.is_empty() {
        return Ok(MetaAnswer {
            markdown: format!(
                "No column like “{raw_name}” in the {checked} spreadsheet{} visible to AI.",
                if checked == 1 { "" } else { "s" }
            ),
            references: Vec::new(),
        });
    }
    let mut lines = vec![
        format!(
            "**{} file{}** ha{} a column like “{raw_name}”:",
            matches.len(),
            if matches.len() == 1 { "" } else { "s" },
            if matches.len() == 1 { "s" } else { "ve" }
        ),
        String::new(),
    ];
    let mut references = Vec::new();
    for (i, (id, name, col, kind)) in matches.iter().enumerate() {
        let kind = match kind {
            ColumnKind::Numeric => "numeric",
            ColumnKind::Date => "date",
            ColumnKind::Text => "text",
        };
        lines.push(format!("- **{name}** — `{col}` ({kind})"));
        references.push(reference(id, name, format!("column `{col}` · {kind}"), i));
    }
    Ok(MetaAnswer { markdown: lines.join("\n"), references })
}

/// Dispatch an intent to its renderer. `Err` = fall through to the normal
/// pipeline (the caller MUST emit nothing on Err — no partial meta output).
pub fn render_meta(
    conversation_id: &str,
    intent: &MetaIntent,
    included: &[String],
    now_ms: i64,
) -> Result<MetaAnswer, String> {
    match intent {
        MetaIntent::WhatsNew { window_ms } => whats_new(conversation_id, included, *window_ms, now_ms),
        MetaIntent::ListFiles { kind } => list_files(conversation_id, included, *kind, now_ms),
        MetaIntent::FindColumn { name } => find_column(conversation_id, included, name),
    }
}

// --- Suggested asks ---------------------------------------------------------------

/// One tap-to-ask suggestion: `label` is the chip text, `question` the full
/// ask (file-scoped so the analytics path is on rails).
#[derive(Debug, Clone, Serialize)]
pub struct SuggestedAsk {
    pub label: String,
    pub question: String,
}

/// Derive ≤4 concrete, answerable questions from the columns of the most
/// recently modified included tabular files. Guaranteed answerable: every
/// suggestion names real columns of a real included file, phrased like the
/// analytics few-shot idioms. Empty when nothing tabular is included — the
/// chat keeps its static empty-state hint.
pub fn suggested_asks(conversation_id: &str, included: &[String]) -> Vec<SuggestedAsk> {
    let recent: Vec<(String, String, PathBuf)> = included_files_with_mtime(conversation_id, included)
        .into_iter()
        .filter(|(_, name, _, _)| is_tabular(name))
        .take(SUGGEST_FILES)
        .map(|(id, name, abs, _)| (id, name, abs))
        .collect();
    if recent.is_empty() {
        return Vec::new();
    }
    let mut asks: Vec<SuggestedAsk> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for fc in catalog::columns_for(&recent) {
        let numeric = fc.columns.iter().find(|c| c.kind == ColumnKind::Numeric);
        let text = fc.columns.iter().find(|c| c.kind == ColumnKind::Text);
        let date = fc.columns.iter().find(|c| c.kind == ColumnKind::Date);
        if let (Some(n), Some(c)) = (numeric, text) {
            let label = format!("Total {} by {}", n.name, c.name);
            if asks.len() < SUGGEST_MAX && seen.insert(label.clone()) {
                asks.push(SuggestedAsk {
                    question: format!("Total {} by {} in {}", n.name, c.name, fc.name),
                    label,
                });
            }
        }
        if let (Some(_d), Some(n)) = (date, numeric) {
            let label = format!("Monthly trend of {}", n.name);
            if asks.len() < SUGGEST_MAX && seen.insert(label.clone()) {
                asks.push(SuggestedAsk {
                    question: format!("Monthly trend of {} in {}", n.name, fc.name),
                    label,
                });
            }
        }
    }
    asks
}

/// Suggested asks, off the async transport boundary. The scan itself is
/// blocking (a cache-first header read per file, no DataFusion), so it runs on
/// a blocking thread; the chips are `suggested_asks`' exactly.
pub async fn suggested_asks_resolved(conversation_id: String, included: Vec<String>) -> Vec<SuggestedAsk> {
    tokio::task::spawn_blocking(move || suggested_asks(&conversation_id, &included))
        .await
        .unwrap_or_default()
}

// --- Applicable recipes (openspec: add-recipes §2.3) ------------------------------

/// One applicable recipe, resolved for the Library gallery / empty-state chips:
/// the built-in's identity plus the table (file display name) or view (name) it
/// runs on. `id` is the wire-stable key the run cue names
/// (`run-recipe:{id} on {table}`). KEEP IN SYNC with `RecipeCard` in
/// src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct RecipeCard {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub table: String,
}

/// Most recipe cards returned across files + views.
const RECIPE_CARDS_MAX: usize = 24;

/// Recipes applicable to the included set, resolved the SAME way
/// `suggested_asks_resolved` resolves chips (openspec: add-recipes §2.3): the
/// cheap, blocking, cache-first FILE path — each recipe's `needs` evaluated
/// against `columns_for`'s typed columns (a CSV date reads as Date-kind).
/// The data-quality audit needs nothing, so it surfaces on every table.
pub async fn applicable_recipes(conversation_id: String, included: Vec<String>) -> Vec<RecipeCard> {
    tokio::task::spawn_blocking(move || file_recipe_cards(&conversation_id, &included))
        .await
        .unwrap_or_default()
}

/// File-derived recipe cards: the most recently modified included tabular files,
/// typed by the column catalog — mirrors `suggested_asks`' file scan exactly
/// (same `SUGGEST_FILES` window, same cheap `columns_for`).
fn file_recipe_cards(conversation_id: &str, included: &[String]) -> Vec<RecipeCard> {
    let recent: Vec<(String, String, PathBuf)> = included_files_with_mtime(conversation_id, included)
        .into_iter()
        .filter(|(_, name, _, _)| is_tabular(name))
        .take(SUGGEST_FILES)
        .map(|(id, name, abs, _)| (id, name, abs))
        .collect();
    if recent.is_empty() {
        return Vec::new();
    }
    let mut cards: Vec<RecipeCard> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for fc in catalog::columns_for(&recent) {
        let cols: Vec<(String, ColumnKind)> =
            fc.columns.iter().map(|c| (c.name.clone(), c.kind)).collect();
        push_recipe_cards(&mut cards, &mut seen, &fc.name, &cols);
    }
    cards
}

/// Append every built-in applicable to `table`'s typed columns, deduped by
/// (recipe id, table) and budget-capped. Pure and context-free, so it is
/// unit-testable without a SessionContext.
fn push_recipe_cards(
    cards: &mut Vec<RecipeCard>,
    seen: &mut HashSet<(String, String)>,
    table: &str,
    cols: &[(String, ColumnKind)],
) {
    for r in crate::recipes::BUILTINS {
        if cards.len() >= RECIPE_CARDS_MAX {
            break;
        }
        if !r.applicable(cols) {
            continue;
        }
        if !seen.insert((r.id.to_string(), table.to_string())) {
            continue;
        }
        cards.push(RecipeCard {
            id: r.id.to_string(),
            name: r.name.to_string(),
            summary: r.summary.to_string(),
            table: table.to_string(),
        });
    }
}

// --- Applicable semantics (openspec: add-semantic-layer §6.1) ---------------------

/// One metric surfaced for the semantic nav: enough to list it, ask about it,
/// and manage it (the `id` the rename/delete ops name). `local_only` drives the
/// per-row lock badge (the ViewsNav idiom) — a cloud posture's eligible set
/// already excludes local-only metrics, so it is only ever true on a device ask.
/// KEEP IN SYNC with `MetricCard` in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricCard {
    pub id: String,
    pub name: String,
    pub expression: String,
    pub description: String,
    pub entity: String,
    pub local_only: bool,
}

/// One synonym surfaced for the semantic nav. KEEP IN SYNC with `SynonymCard`
/// in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct SynonymCard {
    pub term: String,
    pub canonical: String,
}

/// One auto-derived "save as metric" proposal for the nav's Suggested affordance
/// (openspec: field-patch-0.12.5 §3.4): a recurring aggregation mined from usage.
/// The user names it on accept (it prefills the New metric dialog); nothing is
/// stored until then. KEEP IN SYNC with `SuggestedMetric` in
/// src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedMetric {
    pub expression: String,
    pub entity: String,
    pub occurrences: usize,
    pub certified: bool,
}

/// The semantic definitions applicable to the current tables, for the nav
/// (openspec §6.1). `suggested_*` are the field-patch-0.12.5 §3.4 auto-derived
/// PROPOSALS (never stored until the user accepts): synonyms mined from the
/// included columns' abbreviations, metrics mined from recurring usage. KEEP IN
/// SYNC with `SemanticCards` in src/contracts/types.ts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCards {
    pub synonyms: Vec<SynonymCard>,
    pub suggested_synonyms: Vec<SynonymCard>,
    pub suggested_metrics: Vec<SuggestedMetric>,
}

// --- Capability map (openspec: add-deep-analysis §3) ------------------------------

/// One analyzable table in the capability map: its display name, the typed
/// columns (`kind` serializes to "numeric"/"date"/"text"), and whether it has a
/// Date+Numeric shape (⇒ investigable by deep analysis). KEEP IN SYNC with
/// `CapabilityTable` in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTable {
    pub name: String,
    pub columns: Vec<catalog::Column>,
    pub investigable: bool,
}

/// One "Investigate {table}" suggestion — offered for a Date+Numeric table only,
/// so it never proposes an investigation that would produce an empty report. KEEP
/// IN SYNC with `SuggestedInvestigation` in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedInvestigation {
    pub label: String,
    pub table: String,
}

/// The capability map: a single view of what the included vault makes
/// investigable — the analyzable tables + their columns, the recipes and metrics
/// that apply, the suggested asks, and one investigation per Date+Numeric table.
/// KEEP IN SYNC with `CapabilityMap` in src/contracts/types.ts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityMap {
    pub tables: Vec<CapabilityTable>,
    pub recipes: Vec<RecipeCard>,
    pub suggested_asks: Vec<SuggestedAsk>,
    pub suggested_investigations: Vec<SuggestedInvestigation>,
}

/// Aggregate the analyzable surfaces for the included set into one map (openspec:
/// add-deep-analysis §3). It introduces NO new analysis: the recipes and
/// asks are the existing `applicable_recipes` / `suggested_asks_resolved`
/// outputs VERBATIM, so their cloud-posture gating
/// carries through unchanged (a local-only recipe/metric never appears on a cloud
/// map). The tables + `suggested_investigations` come from the SAME recent
/// tabular-file window (`SUGGEST_FILES`) those nav helpers use, so the map is
/// internally consistent — every listed table is one the recipes/asks were
/// computed over. `suggested_investigations` is empty when no included table has a
/// Date+Numeric shape (nothing is investigable), rather than offering an
/// investigation that would produce an empty report.
pub async fn capability_map(conversation_id: String, included: Vec<String>) -> CapabilityMap {
    // Tables: the recent tabular-file window, typed by the catalog (a CSV date
    // reads as Date). One investigation per Date+Numeric table. The catalog read
    // is blocking — kept off the async runtime like the recipe/ask helpers.
    let table_included = included.clone();
    let table_conv = conversation_id.clone();
    let tables: Vec<CapabilityTable> = tokio::task::spawn_blocking(move || {
        let recent: Vec<(String, String, PathBuf)> =
            included_files_with_mtime(&table_conv, &table_included)
                .into_iter()
                .filter(|(_, name, _, _)| is_tabular(name))
                .take(SUGGEST_FILES)
                .map(|(id, name, abs, _)| (id, name, abs))
                .collect();
        catalog::columns_for(&recent)
            .into_iter()
            .map(|fc| {
                let investigable = fc.columns.iter().any(|c| c.kind == ColumnKind::Date)
                    && fc.columns.iter().any(|c| c.kind == ColumnKind::Numeric);
                CapabilityTable { name: fc.name, columns: fc.columns, investigable }
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    let suggested_investigations: Vec<SuggestedInvestigation> = tables
        .iter()
        .filter(|t| t.investigable)
        .map(|t| SuggestedInvestigation {
            label: format!("Investigate {}", t.name),
            table: t.name.clone(),
        })
        .collect();

    // The existing posture-gated surfaces, reused verbatim (no re-gating).
    let recipes = applicable_recipes(conversation_id.clone(), included.clone()).await;
    let suggested_asks = suggested_asks_resolved(conversation_id, included).await;

    CapabilityMap { tables, recipes, suggested_asks, suggested_investigations }
}

// --- Tests -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn applicable_recipes_gate_on_column_kinds() {
        // A table with a date + numeric + text surfaces the recipes whose needs
        // it meets; the data-quality audit (needs nothing) always appears.
        let full = [
            ("order_date".to_string(), ColumnKind::Date),
            ("region".to_string(), ColumnKind::Text),
            ("amount".to_string(), ColumnKind::Numeric),
        ];
        let mut cards = Vec::new();
        let mut seen = HashSet::new();
        push_recipe_cards(&mut cards, &mut seen, "sales.csv", &full);
        let ids: Vec<&str> = cards.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"variance-vs-last-period"));
        assert!(ids.contains(&"cohort-breakdown"));
        assert!(ids.contains(&"anomaly-scan"));
        assert!(ids.contains(&"top-movers"));
        assert!(ids.contains(&"data-quality-audit"));
        assert!(cards.iter().all(|c| c.table == "sales.csv"));

        // A numeric-only table: only the audit and (numeric-only) recipes that
        // don't need a date or a group. Variance/anomaly/cohort/top-movers all
        // demand a date or a text column, so only the audit survives.
        let numeric_only = [("amount".to_string(), ColumnKind::Numeric)];
        let mut cards2 = Vec::new();
        let mut seen2 = HashSet::new();
        push_recipe_cards(&mut cards2, &mut seen2, "nums.csv", &numeric_only);
        let ids2: Vec<&str> = cards2.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids2, vec!["data-quality-audit"]);

        // Dedup: a second pass over the same (recipe, table) adds nothing.
        push_recipe_cards(&mut cards2, &mut seen2, "nums.csv", &numeric_only);
        assert_eq!(cards2.len(), 1);
    }

    #[test]
    fn cue_table_positives() {
        // (question, expected intent)
        assert_eq!(meta_intent("What's new?"), Some(MetaIntent::WhatsNew { window_ms: None }));
        assert_eq!(
            meta_intent("what's new this week"),
            Some(MetaIntent::WhatsNew { window_ms: Some(7 * DAY_MS) })
        );
        assert_eq!(
            meta_intent("Whats new today?"),
            Some(MetaIntent::WhatsNew { window_ms: Some(DAY_MS) })
        );
        assert_eq!(
            meta_intent("What changed in my vault this month?"),
            Some(MetaIntent::WhatsNew { window_ms: Some(31 * DAY_MS) })
        );
        assert_eq!(
            meta_intent("anything new lately?"),
            Some(MetaIntent::WhatsNew { window_ms: Some(7 * DAY_MS) })
        );
        assert_eq!(
            meta_intent("What files do I have?"),
            Some(MetaIntent::ListFiles { kind: None })
        );
        assert_eq!(
            meta_intent("which spreadsheets do i have in my vault"),
            Some(MetaIntent::ListFiles { kind: Some(KindFilter::Spreadsheets) })
        );
        assert_eq!(
            meta_intent("list my documents"),
            Some(MetaIntent::ListFiles { kind: Some(KindFilter::Documents) })
        );
        assert_eq!(
            meta_intent("show me all my pdfs"),
            Some(MetaIntent::ListFiles { kind: Some(KindFilter::Pdfs) })
        );
        // "how many" is the count phrasing §2 answers with a stat tile.
        assert_eq!(
            meta_intent("how many pdfs do i have"),
            Some(MetaIntent::ListFiles { kind: Some(KindFilter::Pdfs) })
        );
        assert_eq!(
            meta_intent("How many files do I have?"),
            Some(MetaIntent::ListFiles { kind: None })
        );
        assert_eq!(
            meta_intent("Which files have an employee id column?"),
            Some(MetaIntent::FindColumn { name: "employee id".into() })
        );
        assert_eq!(
            meta_intent("which files have a column called region"),
            Some(MetaIntent::FindColumn { name: "region".into() })
        );
        assert_eq!(
            meta_intent("who has a revenue column"),
            Some(MetaIntent::FindColumn { name: "revenue".into() })
        );
    }

    #[test]
    fn cue_table_negatives() {
        // Document-scoped and content questions must run the full pipeline.
        for q in [
            "What's new in the Q3 report?",           // names a document
            "what's newest",                          // frame must end on a word boundary
            "What are the key risks across my files?", // content synthesis
            "what files does the contract mention",   // content, not inventory
            "which files have the highest revenue",   // aggregate → analytics
            "Summarize what's new in accounting.xlsx", // not anchored at start
            "total amount by region",                 // analytics
            "who has the largest budget",             // not a column question
            "what did I add to the deck about pricing", // tail names content
            "",
        ] {
            assert_eq!(meta_intent(q), None, "expected full pipeline for {q:?}");
        }
    }

    #[test]
    fn column_name_extraction_is_bounded() {
        // A long tail is a content question, not a schema lookup.
        assert_eq!(
            meta_intent("which files have a column with all the sales figures from last year"),
            None
        );
        // Quotes around the name are shed.
        assert_eq!(
            meta_intent("which files have a column \"unit price\""),
            Some(MetaIntent::FindColumn { name: "unit price".into() })
        );
    }

    #[test]
    fn count_visual_comes_from_the_inventory_not_prose() {
        // A single kind → a stat tile carrying the engine count, fixed key order
        // for byte-parity with the TS twin.
        assert_eq!(
            stat_fence(3, "PDFs"),
            "```lighthouse-stat\n{\"raw\":\"3\",\"value\":3,\"label\":\"PDFs\"}\n```"
        );
        // Two+ kinds → a bar over the by-kind counts, materialized by the SAME
        // emitter the analytics path uses (a RecordBatch → chart_spec_from_batches).
        let bar = counts_bar_spec(&[("spreadsheet", 5), ("document", 3), ("PDF", 2)]).expect("bar");
        let v: serde_json::Value = serde_json::from_str(&bar).unwrap();
        assert_eq!(v["kind"], "bar");
        assert_eq!(v["x"], serde_json::json!(["spreadsheets", "documents", "PDFs"]));
        assert_eq!(v["series"][0]["values"], serde_json::json!([5.0, 3.0, 2.0]));
        // CONSTITUTION guard: a single count is a tile, never a one-bar chart —
        // and there is no path that turns a prose number into either.
        assert_eq!(counts_bar_spec(&[("spreadsheet", 5)]), None);
        assert_eq!(counts_bar_spec(&[]), None);
    }

    #[test]
    fn renderers_err_on_an_empty_corpus_so_pipeline_falls_through() {
        // The synth stage treats Err as "not a meta answer" and emits nothing;
        // a conversation with no attachments must therefore be an Err, not a
        // sad answer.
        let now = 1_700_000_000_000;
        assert!(whats_new("conv-empty", &[], None, now).is_err());
        assert!(list_files("conv-empty", &[], None, now).is_err());
        // FindColumn with an unusable (sanitizes-to-nothing) name also errs.
        assert!(find_column("conv-empty", &[], "??").is_err());
    }
}
