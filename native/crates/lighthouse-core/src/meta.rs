//! Vault meta-answers: deterministic, model-free answers to questions ABOUT
//! the vault — "what's new this week?", "what spreadsheets do I have?",
//! "which files have an employee id column?" (openspec: add-vault-meta-answers).
//!
//! The synthesis pipeline consults `meta_intent` before its analytics branch;
//! a `Some` intent renders instantly from walk metadata (names, kinds, mtimes)
//! and — for column questions — the column catalog, with real references.
//! Cues are ANCHORED phrase patterns, not keywords: a question that merely
//! mentions files ("what's new in the Q3 report?") never lands here. Any
//! renderer error falls through to the normal pipeline with nothing emitted.
//!
//! KEEP IN SYNC with src/server/meta.ts (cue table + WhatsNew/ListFiles
//! renderers; FindColumn and suggested asks are desktop-only — the catalog
//! has no TS twin, PARITY).

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;

use crate::analytics::{is_tabular, sanitize_table_name, saved_age_label};
use crate::catalog::{self, ColumnKind};
use crate::contracts::RagReference;
use crate::vault;

/// Most files a WhatsNew answer lists.
const WHATS_NEW_MAX: usize = 15;
/// Most names a ListFiles answer spells out (counts cover the rest).
const LIST_FILES_MAX: usize = 10;
/// Recent tabular files consulted for suggested asks.
const SUGGEST_FILES: usize = 3;
/// Most suggestions returned.
const SUGGEST_MAX: usize = 4;

// --- Intent ----------------------------------------------------------------------

/// A recognized vault-meta question. Fields are pre-parsed so renderers stay
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
    "in", "to", "with", "my", "the", "vault", "files", "file", "documents", "docs",
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

/// A ListFiles tail may only point back at the vault ("in my vault").
fn vault_tail_ok(tail: &str) -> bool {
    tail.split(' ')
        .filter(|w| !w.is_empty())
        .all(|w| matches!(w, "in" | "my" | "the" | "vault" | "here"))
}

fn list_files_intent(q: &str) -> Option<MetaIntent> {
    // "what|which <kind> do i have [in my vault]"
    for lead in ["what ", "which "] {
        if let Some(rest) = q.strip_prefix(lead) {
            let (kind_word, after) = rest.split_once(' ').unwrap_or((rest, ""));
            if let Some(kind) = kind_of_word(kind_word) {
                if let Some(tail) = frame_tail(after, "do i have") {
                    if vault_tail_ok(tail) {
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
                if vault_tail_ok(after) {
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
fn included_files_with_mtime(included: &[String]) -> Vec<(String, String, PathBuf, i64)> {
    let active: HashSet<String> = vault::active_included_file_ids().into_iter().collect();
    let mut out: Vec<(String, String, PathBuf, i64)> = Vec::new();
    for id in included {
        if !active.contains(id) {
            continue;
        }
        if let Some((name, abs)) = vault::doc_path(id) {
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
    }
}

fn whats_new(included: &[String], window_ms: Option<i64>, now_ms: i64) -> Result<MetaAnswer, String> {
    let files = included_files_with_mtime(included);
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

fn list_files(included: &[String], kind: Option<KindFilter>, now_ms: i64) -> Result<MetaAnswer, String> {
    let files = included_files_with_mtime(included);
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
    Ok(MetaAnswer { markdown: lines.join("\n"), references })
}

/// "5 spreadsheets, 3 documents, 2 PDFs" — only non-zero buckets, biggest first.
fn count_line(files: &[(String, String, PathBuf, i64)]) -> String {
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
        .iter()
        .map(|(label, n)| {
            let plural = if *n == 1 { "" } else { "s" };
            format!("{n} {label}{plural}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn find_column(included: &[String], raw_name: &str) -> Result<MetaAnswer, String> {
    let want = sanitize_table_name(raw_name);
    if want.is_empty() || want == "table" {
        return Err("unusable column name".into());
    }
    let tabular: Vec<(String, String, PathBuf)> = included_files_with_mtime(included)
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
pub fn render_meta(intent: &MetaIntent, included: &[String], now_ms: i64) -> Result<MetaAnswer, String> {
    match intent {
        MetaIntent::WhatsNew { window_ms } => whats_new(included, *window_ms, now_ms),
        MetaIntent::ListFiles { kind } => list_files(included, *kind, now_ms),
        MetaIntent::FindColumn { name } => find_column(included, name),
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
pub fn suggested_asks(included: &[String]) -> Vec<SuggestedAsk> {
    let recent: Vec<(String, String, PathBuf)> = included_files_with_mtime(included)
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

// --- Tests -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
    fn renderers_err_on_empty_vault_so_pipeline_falls_through() {
        // The synth stage treats Err as "not a meta answer" and emits nothing;
        // an empty inclusion set must therefore be an Err, not a sad answer.
        let now = 1_700_000_000_000;
        assert!(whats_new(&[], None, now).is_err());
        assert!(list_files(&[], None, now).is_err());
        // FindColumn with an unusable (sanitizes-to-nothing) name also errs.
        assert!(find_column(&[], "??").is_err());
    }
}
