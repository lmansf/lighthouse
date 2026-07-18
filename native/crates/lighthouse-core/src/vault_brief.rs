//! The engine-drafted vault brief (openspec: field-patch-0.12.5 §3.5).
//!
//! A short, DETERMINISTIC summary of the vault the model is answering over —
//! drafted from facts the engine already knows (file-kind composition + the
//! queryable tables in scope, with date ranges when cheaply known) — injected as
//! ONE editable context block beside the business-definitions block (synth.rs).
//! It is NOT a semantic-store kind and is NOT part of the §3 ablation study: it
//! is the new additive deliverable, drawn only from engine-verified facts (never
//! model prose), so it can never introduce an ungrounded number.
//!
//! Determinism is the contract: the same vault + registered tables render the
//! same brief every time (unit-pinned below), so the analytics prompt stays
//! reproducible and the answer-cache key is unaffected.
//!
//! PARITY: the pure `render_brief` renderer is mirrored BYTE-FOR-BYTE by
//! vaultBrief.ts::renderBrief (the labels + line shapes are the byte contract —
//! change them in lockstep). The `draft_brief` gathering wrapper is Rust-only
//! (the TS twin has no analytics branch to inject into), exactly like
//! semantic::prompt_block.

use crate::llm::Ctx;

/// The block label (surfaced as `[n] vault brief`). KEEP IN SYNC with
/// vaultBrief.ts::BRIEF_NAME.
const BRIEF_NAME: &str = "vault brief";
/// Leading line of the block body. KEEP IN SYNC with vaultBrief.ts::BRIEF_HEADER.
const BRIEF_HEADER: &str =
    "Vault brief (engine-drafted from your files — edit to correct or extend; this is context, not a constraint):";
/// Composition-line lead. KEEP IN SYNC with vaultBrief.ts::COMPOSITION_LABEL.
const COMPOSITION_LABEL: &str = "Files:";
/// Tables-section header. KEEP IN SYNC with vaultBrief.ts::TABLES_LABEL.
const TABLES_LABEL: &str = "Queryable tables:";

/// One queryable table's brief facts: its name, column count, and an optional
/// rendered date range (min, max) over a date column. KEEP IN SYNC with
/// vaultBrief.ts::BriefTable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BriefTable {
    pub table: String,
    pub columns: usize,
    pub dates: Option<(String, String)>,
}

/// Render the brief from already-gathered facts — a PURE function (testable
/// without a vault), the byte contract with vaultBrief.ts::renderBrief.
/// `composition` is `(KIND, count)` pairs (any order; zero-counts pruned and the
/// rest sorted most-files-first, ties by kind). `None` when there is nothing to
/// say (no files and no tables), which keeps the prompt byte-identical to today.
pub fn render_brief(mut composition: Vec<(String, usize)>, tables: &[BriefTable]) -> Option<Ctx> {
    // Deterministic composition order: most files first, ties broken by kind.
    composition.retain(|(_, n)| *n > 0);
    composition.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let mut sections: Vec<String> = Vec::new();
    if !composition.is_empty() {
        let parts: Vec<String> = composition.iter().map(|(k, n)| format!("{n} {k}")).collect();
        sections.push(format!("{COMPOSITION_LABEL} {}.", parts.join(", ")));
    }
    if !tables.is_empty() {
        let mut lines = vec![TABLES_LABEL.to_string()];
        for t in tables {
            let cols = if t.columns == 1 {
                "1 column".to_string()
            } else {
                format!("{} columns", t.columns)
            };
            let dates = match &t.dates {
                Some((min, max)) => format!("; dates {min} to {max}"),
                None => String::new(),
            };
            lines.push(format!("- {} ({cols}{dates})", t.table));
        }
        sections.push(lines.join("\n"));
    }
    if sections.is_empty() {
        return None;
    }
    Some(Ctx {
        name: BRIEF_NAME.to_string(),
        // Auxiliary guidance, like the join-hints / business-definitions cards.
        score: 0.0,
        text: format!("{BRIEF_HEADER}\n\n{}", sections.join("\n\n")),
    })
}

/// Draft the vault brief for an ask (Rust-only, like `semantic::prompt_block`):
/// file-kind composition over the vault's active included files + the queryable
/// tables from the registered `regs`. Deterministic. Date ranges are populated
/// only when cheaply known; today the draft ships composition + tables (date-
/// range enrichment from profiles is a follow-on) — NEVER fabricated.
pub fn draft_brief(regs: &[crate::analytics::TableReg]) -> Option<Ctx> {
    let composition = vault_composition();
    let tables: Vec<BriefTable> = regs
        .iter()
        .map(|r| BriefTable {
            table: r.table.clone(),
            columns: r.columns.len(),
            dates: None,
        })
        .collect();
    render_brief(composition, &tables)
}

/// File-kind counts over the vault's active, included files — the composition
/// line's raw input. Cheap (node metadata only, no data read) and deterministic
/// (a `BTreeMap` yields a stable kind order before `render_brief` re-sorts).
fn vault_composition() -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for id in crate::vault::active_included_file_ids() {
        if let Some((name, _)) = crate::vault::doc_path(&id) {
            if let Some(kind) = file_kind(&name) {
                *counts.entry(kind).or_insert(0) += 1;
            }
        }
    }
    counts.into_iter().collect()
}

/// A file's brief KIND label from its extension (uppercased, no dot); `None`
/// for an extensionless name, a dotfile, or a trailing-dot name. KEEP IN SYNC
/// with vaultBrief.ts::fileKind.
fn file_kind(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_brief_is_none_when_there_is_nothing_to_say() {
        assert!(render_brief(vec![], &[]).is_none());
        // A zero-count kind is pruned, so an all-zero composition with no tables
        // is None (keeps the prompt byte-identical to today).
        assert!(render_brief(vec![("CSV".into(), 0)], &[]).is_none());
    }

    #[test]
    fn render_brief_pins_composition_and_tables() {
        // Composition sorts most-files-first, ties by kind; tables keep order;
        // singular vs plural columns; an optional date range. This exact string
        // is the byte contract with vaultBrief.ts::renderBrief.
        let brief = render_brief(
            vec![("CSV".into(), 1), ("PDF".into(), 3), ("XLSX".into(), 1)],
            &[
                BriefTable {
                    table: "orders".into(),
                    columns: 4,
                    dates: Some(("2024-01".into(), "2024-03".into())),
                },
                BriefTable { table: "flag".into(), columns: 1, dates: None },
            ],
        )
        .expect("a non-empty set renders a brief");
        assert_eq!(brief.name, "vault brief");
        assert_eq!(brief.score, 0.0);
        let expected = [
            "Vault brief (engine-drafted from your files — edit to correct or extend; this is context, not a constraint):",
            "",
            "Files: 3 PDF, 1 CSV, 1 XLSX.",
            "",
            "Queryable tables:",
            "- orders (4 columns; dates 2024-01 to 2024-03)",
            "- flag (1 column)",
        ]
        .join("\n");
        assert_eq!(brief.text, expected);
    }

    #[test]
    fn render_brief_is_deterministic_across_calls() {
        let comp = vec![("PDF".into(), 2), ("CSV".into(), 2)];
        let tables = [BriefTable { table: "t".into(), columns: 2, dates: None }];
        assert_eq!(
            render_brief(comp.clone(), &tables).unwrap().text,
            render_brief(comp, &tables).unwrap().text,
            "same facts ⇒ same brief",
        );
    }

    #[test]
    fn file_kind_reads_the_extension_or_nothing() {
        assert_eq!(file_kind("orders.csv").as_deref(), Some("CSV"));
        assert_eq!(file_kind("Q3.report.pdf").as_deref(), Some("PDF"));
        assert_eq!(file_kind("README"), None);
        assert_eq!(file_kind(".env"), None);
        assert_eq!(file_kind("trailing."), None);
    }
}
