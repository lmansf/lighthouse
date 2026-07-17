//! Deep-analysis report model + renderer (openspec: add-deep-analysis §1).
//!
//! A `Report` is what "Investigate {table}" produces: a titled document with a
//! SUMMARY of the top findings, one SECTION per analysis (its evidence table +
//! the exact SQL), and a CAVEATS block. This module is the PURE core — the types
//! plus a deterministic assembler and renderer. It holds NO store, calls NO
//! model, and reads NO clock (the generation time is passed in), so the whole
//! render is reproducible and unit-testable. The `investigate` engine (§2) runs
//! the applicable recipes, builds one `SubAnalysis` per verified result (its
//! `headline` templated from the result's engine numbers, the `insights`
//! discipline), and hands them here.
//!
//! Invariant: the report carries no model-authored figure. Every number is in a
//! section's `run_query` result, and each summary line is a `headline` the engine
//! templated from those cells — so the summary is reproducible from the SQL.
//!
//! Render idiom: `# title` / `## Summary` / `## {section}` / `## Caveats`,
//! matching `briefings::render_markdown` (`briefings.rs:245`).

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
