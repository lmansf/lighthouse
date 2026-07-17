//! Deep-analysis report model + engine (openspec: add-deep-analysis §1–§2).
//!
//! A `Report` is what "Investigate {table}" produces: a titled document with a
//! SUMMARY of the top findings, one SECTION per analysis (its evidence table +
//! the exact SQL), and a CAVEATS block. Two layers live here:
//!
//! - The PURE model — `SubAnalysis`/`Report`/`ReportSection` plus `assemble` and
//!   `render_markdown`. It holds NO store, calls NO model, and reads NO clock
//!   (the generation time is passed in), so the whole render is reproducible and
//!   unit-testable.
//! - The `investigate` ENGINE (§2) — the only impure part: it registers the
//!   vault's tabular files, runs every applicable `recipes::BUILTINS`'
//!   representative query through the model-free `analytics::run_query`, templates
//!   one `SubAnalysis` per verified result (its `headline` from the result's own
//!   engine cells — the `insights` discipline), derives honest caveats, stamps
//!   `config::now_ms()`, and hands the lot to `assemble`. No model plans or
//!   narrates the core report; every figure is a `run_query` cell.
//!
//! Invariant: the report carries no model-authored figure. Every number is in a
//! section's `run_query` result, and each summary line is a `headline` the engine
//! templated from those cells — so the summary is reproducible from the SQL.
//!
//! Render idiom: `# title` / `## Summary` / `## {section}` / `## Caveats`,
//! matching `briefings::render_markdown` (`briefings.rs:245`).
//!
//! PARITY: Rust-only (DataFusion + recipes), like the whole analytics branch. The
//! TS twin's `investigate` op returns `{available:false}` (docs/ts-twin.md).

use std::path::PathBuf;

use datafusion::arrow::util::display::array_value_to_string;
use datafusion::prelude::SessionContext;

use crate::analytics::{register_tables, run_query, QueryResult};
use crate::catalog::{columns_for, ColumnKind};
use crate::config::now_ms;
use crate::{ledger, recipes};

/// A changepoint headline is surfaced to the SUMMARY only when its normalized
/// magnitude clears this floor — a flat series scores ~0 and contributes its
/// SECTION (the evidence) without a misleading "level shift" summary line. Mirrors
/// `insights::INSIGHT_CHANGEPOINT_MIN_MAG`.
const CHANGEPOINT_HEADLINE_MIN: f64 = 1.0;

/// One executed sub-analysis handed to the assembler: the recipe's name and human
/// summary, its VERIFIED result table (already rendered to markdown), the exact
/// query, and a one-line finding for the report summary (engine numbers only, or
/// `None` when the analysis turned up nothing material).
#[derive(Debug, Clone)]
pub struct SubAnalysis {
    pub heading: String,
    pub question: String,
    pub result_markdown: String,
    pub sql: String,
    pub headline: Option<String>,
}

/// One rendered section of the report.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportSection {
    pub heading: String,
    pub question: String,
    pub result_markdown: String,
    pub sql: String,
}

/// A deep-analysis report — deterministic, engine-verified, ready to render + write.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub title: String,
    /// Generation time (epoch ms), passed in so the render is deterministic.
    pub generated_ms: i64,
    /// Templated top findings — engine numbers pulled from the section results.
    pub summary: Vec<String>,
    pub sections: Vec<ReportSection>,
    pub caveats: Vec<String>,
}

/// Assemble a report from already-executed sub-analyses. Pure: the summary is the
/// sub-analyses' `headline`s (each an engine-number finding); an analysis with no
/// material headline still contributes its SECTION (the evidence) but no summary
/// line. When nothing was analyzable, the summary states so honestly.
pub fn assemble(
    title: impl Into<String>,
    generated_ms: i64,
    subs: Vec<SubAnalysis>,
    caveats: Vec<String>,
) -> Report {
    let mut summary: Vec<String> = subs.iter().filter_map(|s| s.headline.clone()).collect();
    if subs.is_empty() {
        summary.push("Nothing to analyze — this table has no dated numeric series.".to_string());
    } else if summary.is_empty() {
        summary.push("No single figure stood out; see the sections below.".to_string());
    }
    let sections = subs
        .into_iter()
        .map(|s| ReportSection {
            heading: s.heading,
            question: s.question,
            result_markdown: s.result_markdown,
            sql: s.sql,
        })
        .collect();
    Report { title: title.into(), generated_ms, summary, sections, caveats }
}

/// Render the report to a standalone markdown document (the `briefings.rs:245`
/// idiom, extended with the summary/SQL/caveats blocks). Byte-stable for a fixed
/// `Report` — the generation time formats from the carried `generated_ms`.
pub fn render_markdown(report: &Report) -> String {
    let generated = chrono::DateTime::from_timestamp_millis(report.generated_ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    let mut out = format!("# {}\n\n_Generated {generated} — every figure computed by Lighthouse._\n", report.title);

    out.push_str("\n## Summary\n\n");
    for line in &report.summary {
        out.push_str(&format!("- {line}\n"));
    }

    for s in &report.sections {
        out.push_str(&format!("\n## {}\n\n{}\n\n", s.heading, s.question));
        if s.result_markdown.trim().is_empty() {
            out.push_str("_no rows_\n");
        } else {
            out.push_str(s.result_markdown.trim_end());
            out.push('\n');
        }
        out.push_str(&format!("\n*Query used:*\n```sql\n{}\n```\n", s.sql.trim()));
    }

    if !report.caveats.is_empty() {
        out.push_str("\n## Caveats\n\n");
        for c in &report.caveats {
            out.push_str(&format!("- {c}\n"));
        }
    }
    out
}

// --- The `investigate` engine (openspec: add-deep-analysis §2) ---------------------

/// Run the applicable recipe battery over `table` and assemble the verified
/// results into a `Report`. `files` are the `(file_id, display_name, path)`
/// triples the op gathered (the `insights::scan` shape) — the same on-device
/// DataFusion path the analytics branch uses, so a report egresses NOTHING and
/// every figure is a `run_query` cell, never model text.
///
/// Degradation is honest, never an error: a table with no dated numeric shape (or
/// one that doesn't resolve/register) yields an empty-sections report with an
/// honest summary; a recipe that doesn't resolve, plans nothing, errors, or
/// returns no rows is SKIPPED while the rest of the battery still runs.
pub async fn investigate(table: &str, files: &[(String, String, PathBuf)], is_cloud: bool) -> Report {
    let title = format!("Investigate {table}");
    let generated_ms = now_ms();

    // The typed catalog — the same source recipe applicability reads, so what a
    // recipe is OFFERED on and what it RESOLVES on never disagree (the
    // `insights::scan` pattern). `columns_for` is sync CSV/workbook sniffing.
    let catalog = {
        let files = files.to_vec();
        tokio::task::spawn_blocking(move || columns_for(&files))
            .await
            .unwrap_or_default()
    };

    // Resolve the target's typed columns. An unknown name → an honest empty report
    // (never an error, never a fabricated section).
    let Some(fc) = catalog.iter().find(|fc| fc.name == table) else {
        return assemble(title, generated_ms, Vec::new(), Vec::new());
    };
    let cols: Vec<(String, ColumnKind)> =
        fc.columns.iter().map(|c| (c.name.clone(), c.kind)).collect();

    // The analyzable-shape gate: deep analysis IS the temporal recipe battery, so a
    // table with no dated numeric series has nothing to investigate — an honest
    // empty report, matching the capability map's "one investigation per
    // Date+Numeric table". Whole-table recipes (the data-quality audit) run as
    // SECTIONS of an analyzable report, never as the whole of an otherwise-empty
    // one.
    if !has_date_and_numeric(&cols) {
        return assemble(title, generated_ms, Vec::new(), Vec::new());
    }

    let ctx = SessionContext::new();
    let regs = register_tables(&ctx, files, is_cloud).await;
    // Map the cataloged file to its registered SQL table (a union-family member
    // maps to the family's table), exactly as the recipe branch does.
    let Some(sql_table) = regs
        .iter()
        .find(|r| r.file_id == fc.id || r.group.as_ref().is_some_and(|g| g.file_ids.contains(&fc.id)))
        .map(|r| r.table.clone())
    else {
        return assemble(title, generated_ms, Vec::new(), Vec::new());
    };

    // Run each applicable builtin's representative query (plan[0]) through the
    // model-free run_query. `run_query` returns Err on a no-rows result, so the
    // `let Ok` skip covers §2.2's "returns no rows is SKIPPED" for free.
    let mut subs: Vec<SubAnalysis> = Vec::new();
    let mut last_sql: Option<String> = None;
    let mut dq_caveat: Option<String> = None;
    for recipe in recipes::BUILTINS {
        let Some(params) = recipe.resolve(&sql_table, &cols) else { continue };
        let plan = (recipe.plan)(&params);
        let Some(q) = plan.into_iter().next() else { continue };
        let Ok(res) = run_query(&ctx, &q.sql).await else { continue };
        let headline = section_headline(recipe.id, &res);
        // The data-quality audit contributes a CAVEAT (its worst column), not a
        // summary headline — captured before `res.markdown` is moved below.
        if recipe.id == "data-quality-audit" {
            dq_caveat = data_quality_caveat(&res);
        }
        last_sql = Some(q.sql.clone());
        subs.push(SubAnalysis {
            heading: recipe.name.to_string(),
            question: recipe.summary.to_string(),
            result_markdown: res.markdown,
            sql: q.sql,
            headline,
        });
    }

    // Caveats — all engine-derived, never model text:
    //  1. A structural caveat that always holds past the Date+Numeric gate: the
    //     recipes bucket by calendar month, so the latest bucket can be partial.
    //  2. The last section's STRUCTURAL assumptions (date/grouping/filters/
    //     null-handling) via the §1 assumption ledger — `rows: None` omits the
    //     per-query row count (a section artifact that reads as misleadingly small
    //     for a LIMIT-1 argmax query, not a report-level caveat).
    //  3. A data-quality finding, when the audit turned one up.
    let mut caveats: Vec<String> = vec![
        "Time-series figures are bucketed by calendar month (`YYYY-MM`); the most recent month \
         may be partial if the source is still accumulating."
            .to_string(),
    ];
    if let Some(sql) = &last_sql {
        if let Some(l) = ledger::assumption_ledger_parts(sql, &regs, None) {
            caveats.extend(ledger_caveats(&l));
        }
    }
    if let Some(c) = dq_caveat {
        caveats.push(c);
    }

    assemble(title, generated_ms, subs, caveats)
}

/// The default vault subfolder for a standalone report (no named investigation) —
/// a write-artifact allowlist entry, alongside `Lighthouse Results`/`Lighthouse
/// Notes`.
pub const REPORTS_SUBDIR: &str = "Lighthouse Reports";

/// Render `report` to markdown and write it into the vault as a NON-EGRESS note
/// (openspec add-deep-analysis §2.4) — the `exportChat`/briefing precedent. When
/// `investigation_id` names a known investigation, the note lands in that
/// investigation's `Lighthouse Notes/<folder>` subdir; otherwise under
/// `Lighthouse Reports`. Both are write-artifact allowlist entries, so the write
/// is sanitized, traversal-safe, and never overwrites an existing note. Returns
/// the saved artifact's `(id, name)` so the app can open it. The write NEVER
/// egresses and NEVER writes outside the vault (the `vault::write_artifact` funnel
/// enforces the allowlist).
pub fn write_report(
    report: &Report,
    investigation_id: Option<&str>,
) -> Result<(String, String), String> {
    let subdir = match investigation_id {
        Some(id) if !id.trim().is_empty() => crate::investigations::notes_subdir(id)?,
        _ => REPORTS_SUBDIR.to_string(),
    };
    let markdown = render_markdown(report);
    crate::vault::write_artifact(&subdir, &report.title, "md", markdown.as_bytes())
        .map_err(|e| e.to_string())
}

/// Whether a typed column set can carry the temporal recipe battery — at least
/// one Date and one Numeric column (the `insights::scan` gate, and the same shape
/// the capability map offers an investigation for).
fn has_date_and_numeric(cols: &[(String, ColumnKind)]) -> bool {
    cols.iter().any(|(_, k)| *k == ColumnKind::Date)
        && cols.iter().any(|(_, k)| *k == ColumnKind::Numeric)
}

/// Template a one-line SUMMARY finding from a section's engine result — the
/// `insights` discipline (every figure is a `run_query` cell; only a sign or label
/// is added). `None` for a recipe with no single headline figure (the forecast,
/// whose story is its band chart; the data-quality audit, which yields a caveat)
/// or an immaterial result (a flat changepoint), so that section still contributes
/// its evidence without a summary line.
fn section_headline(id: &str, res: &QueryResult) -> Option<String> {
    match id {
        "variance-vs-last-period" => {
            let period = cell(res, "current_period")?;
            let total = cell(res, "current_total")?;
            match parse_cell(res, "pct_change") {
                Some(pct) => {
                    let prior = cell(res, "prior_period").unwrap_or_default();
                    Some(format!("{period}: {total} ({pct:+}% vs {prior})"))
                }
                None => Some(format!("{period}: {total} (no prior period to compare)")),
            }
        }
        "anomaly-scan" => {
            let period = cell(res, "period")?;
            let z = parse_cell(res, "z_score")?;
            Some(format!("{period} is a {z:+}σ anomaly"))
        }
        "top-movers" => {
            let cohort = cell(res, "cohort")?;
            match parse_cell(res, "pct_change") {
                Some(pct) => Some(format!("{cohort} moved {pct:+}% vs the prior period")),
                None => cell(res, "total").map(|t| format!("{cohort} is the largest group ({t})")),
            }
        }
        "cohort-breakdown" => {
            let cohort = cell(res, "cohort")?;
            let pct = parse_cell(res, "pct_of_total")?;
            Some(format!("{cohort} leads with {pct}% of the total"))
        }
        "changepoint-scan" => {
            // Below the floor is an immaterial (near-flat) split — a section, not a
            // summary line.
            if parse_cell(res, "magnitude")? < CHANGEPOINT_HEADLINE_MIN {
                return None;
            }
            let period = cell(res, "changepoint_period")?;
            let before = cell(res, "mean_before")?;
            let after = cell(res, "mean_after")?;
            Some(format!("Level shift at {period} ({before} → {after})"))
        }
        // forecast + data-quality-audit contribute no single summary figure.
        _ => None,
    }
}

/// Row-0 cell under `col` as a rendered string (DataFusion's own formatting), or
/// `None` when the result is empty, the column is absent, or the cell is NULL.
/// Shared shape with `insights::cell`.
fn cell(res: &QueryResult, col: &str) -> Option<String> {
    let b = res.batches.iter().find(|b| b.num_rows() > 0)?;
    let idx = b.schema().index_of(col).ok()?;
    if b.column(idx).is_null(0) {
        return None;
    }
    array_value_to_string(b.column(idx), 0).ok()
}

fn parse_cell(res: &QueryResult, col: &str) -> Option<f64> {
    cell(res, col)?.trim().parse::<f64>().ok()
}

/// Split an assumption-ledger block (`*Assumptions:*` + `- ` bullets, the
/// `ledger.rs` shape) into its individual caveat lines — dropping the header and
/// the `- ` markers so `render_markdown` re-bullets them cleanly under `## Caveats`.
fn ledger_caveats(ledger: &str) -> Vec<String> {
    ledger
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- ").map(|b| b.trim().to_string()))
        .filter(|b| !b.is_empty())
        .collect()
}

/// A single honest caveat from the data-quality audit's completeness result (its
/// plan[0] — `column_name, rows, nulls, null_pct, …`): the column with the MOST
/// missing cells, when any column has one. `None` when the audit is clean (no
/// nulls) or the shape is unexpected — the figures are the engine's, never
/// fabricated.
fn data_quality_caveat(res: &QueryResult) -> Option<String> {
    let mut worst: Option<(String, f64, String)> = None; // (column, nulls, null_pct text)
    for b in &res.batches {
        let name_idx = b.schema().index_of("column_name").ok()?;
        let nulls_idx = b.schema().index_of("nulls").ok()?;
        let pct_idx = b.schema().index_of("null_pct").ok();
        for row in 0..b.num_rows() {
            if b.column(nulls_idx).is_null(row) {
                continue;
            }
            let nulls = array_value_to_string(b.column(nulls_idx), row)
                .ok()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .unwrap_or(0.0);
            if nulls <= 0.0 {
                continue;
            }
            let Ok(name) = array_value_to_string(b.column(name_idx), row) else { continue };
            let pct = pct_idx
                .filter(|i| !b.column(*i).is_null(row))
                .and_then(|i| array_value_to_string(b.column(i), row).ok())
                .unwrap_or_default();
            if worst.as_ref().map(|(_, n, _)| nulls > *n).unwrap_or(true) {
                worst = Some((name, nulls, pct));
            }
        }
    }
    worst.map(|(name, nulls, pct)| {
        let pct = if pct.is_empty() { String::new() } else { format!(", {pct}%") };
        format!("`{name}` has the most missing values ({nulls:.0} nulls{pct}); aggregates skip null cells.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(heading: &str, headline: Option<&str>) -> SubAnalysis {
        SubAnalysis {
            heading: heading.to_string(),
            question: format!("What does {heading} show?"),
            result_markdown: "| period | total |\n|---|---|\n| 2024-10 | 400 |".to_string(),
            sql: "SELECT period, total FROM t".to_string(),
            headline: headline.map(str::to_string),
        }
    }

    #[test]
    fn assemble_collects_headlines_into_the_summary() {
        let report = assemble(
            "Investigate sales.csv",
            1_700_000_000_000,
            vec![
                sub("Anomaly scan", Some("2024-10 is a +2.85σ anomaly")),
                sub("Data-quality audit", None), // a section with no summary line
            ],
            vec!["Latest month may be partial.".to_string()],
        );
        assert_eq!(report.summary, vec!["2024-10 is a +2.85σ anomaly"]);
        assert_eq!(report.sections.len(), 2, "every analysis contributes a section");
        assert_eq!(report.sections[0].heading, "Anomaly scan");
    }

    #[test]
    fn an_empty_report_says_nothing_to_analyze() {
        let report = assemble("Investigate notes.csv", 1_700_000_000_000, vec![], vec![]);
        assert!(report.sections.is_empty());
        assert_eq!(report.summary.len(), 1);
        assert!(report.summary[0].contains("Nothing to analyze"));
    }

    #[test]
    fn render_is_byte_stable_and_carries_the_sections() {
        let report = assemble(
            "Investigate sales.csv",
            1_700_000_000_000,
            vec![sub("Anomaly scan", Some("2024-10 is a +2.85σ anomaly"))],
            vec!["Latest month may be partial.".to_string()],
        );
        let a = render_markdown(&report);
        let b = render_markdown(&report);
        assert_eq!(a, b, "the render is deterministic");
        assert!(a.starts_with("# Investigate sales.csv\n"));
        assert!(a.contains("## Summary"));
        assert!(a.contains("- 2024-10 is a +2.85σ anomaly"));
        assert!(a.contains("## Anomaly scan"));
        assert!(a.contains("```sql\nSELECT period, total FROM t\n```"));
        assert!(a.contains("## Caveats"));
        assert!(a.contains("- Latest month may be partial."));
        // The generation time is formatted from generated_ms (deterministic).
        assert!(a.contains("UTC"));
    }
}
