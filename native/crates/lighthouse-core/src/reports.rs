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

/// Which structured-report shape to render (openspec: add-report-templates). The
/// STANDARD report is the deterministic, model-free document assembled today —
/// byte-stable and unchanged. The two templates prescribe a familiar STRUCTURE
/// around the SAME engine-verified sections: the deterministic analyses carry
/// every figure, and (when a narration model is available) the model writes only
/// the connective framing — never a number. PARITY: Rust-only, like the whole
/// report/recipes branch (the TS twin's `investigate` op returns
/// `{available:false}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReportTemplate {
    /// Today's deep-analysis report: Summary / one section per analysis / Caveats.
    #[default]
    Standard,
    /// Scientific method (IMRaD): Introduction / Methods / Results / Discussion.
    ScientificMethod,
    /// Business report: Bottom Line Up Front, then Minto-pyramid supporting detail.
    BusinessReport,
}

impl ReportTemplate {
    /// Parse the wire value threaded from the `investigate` op body. Unknown or
    /// absent → the Standard report (the safe, deterministic default).
    pub fn from_wire(v: Option<&str>) -> ReportTemplate {
        match v {
            Some("imrad") | Some("scientific") => ReportTemplate::ScientificMethod,
            Some("bluf") | Some("business") => ReportTemplate::BusinessReport,
            _ => ReportTemplate::Standard,
        }
    }

    /// The title suffix that names the template in the saved note.
    fn title_suffix(self) -> &'static str {
        match self {
            ReportTemplate::Standard => "",
            ReportTemplate::ScientificMethod => " — Scientific method",
            ReportTemplate::BusinessReport => " — Business report",
        }
    }
}

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
    /// The structured shape to render. Default `Standard` keeps the deterministic
    /// document byte-identical; the templates reorganize the SAME sections.
    pub template: ReportTemplate,
    /// Model-narrated FRAMING for a template — the IMRaD Introduction / the BLUF
    /// bottom line. `None` on the Standard report and whenever no narration model
    /// is available (a deterministic framing line is used instead). Never carries
    /// a figure the engine didn't compute.
    pub intro: Option<String>,
    /// Model-narrated interpretation for a template — the IMRaD Discussion / the
    /// BLUF "What this means". `None` when unavailable. Figures are the engine's.
    pub discussion: Option<String>,
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
    Report {
        title: title.into(),
        generated_ms,
        summary,
        sections,
        caveats,
        template: ReportTemplate::Standard,
        intro: None,
        discussion: None,
    }
}

/// Render the report to a standalone markdown document (the `briefings.rs:245`
/// idiom, extended with the summary/SQL/caveats blocks). Byte-stable for a fixed
/// `Report` — the generation time formats from the carried `generated_ms`.
pub fn render_markdown(report: &Report) -> String {
    match report.template {
        ReportTemplate::Standard => render_standard(report),
        ReportTemplate::ScientificMethod => render_imrad(report),
        ReportTemplate::BusinessReport => render_bluf(report),
    }
}

/// The Standard deep-analysis document — byte-identical to the pre-templates
/// render (the `reports_test.rs` byte-stability contract pins this exact shape).
fn render_standard(report: &Report) -> String {
    let mut out = report_header(report);

    out.push_str("\n## Summary\n\n");
    for line in &report.summary {
        out.push_str(&format!("- {line}\n"));
    }

    for s in &report.sections {
        push_section(&mut out, s, "##");
    }

    render_caveats(&mut out, &report.caveats, "##");
    out
}

/// The `# {title}` + deterministic generation stamp — shared by every template.
fn report_header(report: &Report) -> String {
    let generated = chrono::DateTime::from_timestamp_millis(report.generated_ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    format!(
        "# {}\n\n_Generated {generated} — every figure computed by Lighthouse._\n",
        report.title
    )
}

/// One analysis section at the given heading level (`##` standard, `###` nested
/// under a template's Results). The evidence table + display-formatted SQL come
/// from the engine; nothing here is model text. A section with an empty `sql`
/// (a narrated framing block) omits the "Query used" block.
fn push_section(out: &mut String, s: &ReportSection, level: &str) {
    out.push_str(&format!("\n{level} {}\n\n{}\n\n", s.heading, s.question));
    if s.result_markdown.trim().is_empty() {
        out.push_str("_no rows_\n");
    } else {
        out.push_str(s.result_markdown.trim_end());
        out.push('\n');
    }
    if !s.sql.trim().is_empty() {
        // Display-formatted (§1): the report's SQL is laid out for reading; the
        // stored/executed `s.sql` is untouched.
        out.push_str(&format!(
            "\n*Query used:*\n```sql\n{}\n```\n",
            crate::sqlfmt::format_sql(&s.sql)
        ));
    }
}

/// The shared `## Caveats` block (omitted when there are none).
fn render_caveats(out: &mut String, caveats: &[String], level: &str) {
    if !caveats.is_empty() {
        out.push_str(&format!("\n{level} Caveats\n\n"));
        for c in caveats {
            out.push_str(&format!("- {c}\n"));
        }
    }
}

/// Scientific method (IMRaD). Introduction + Discussion are model narration when
/// present (`report.intro`/`report.discussion`), else a deterministic framing
/// line — never a figure. Methods is deterministic (which analyses ran); Results
/// are the engine-verified sections; Caveats are the engine's.
fn render_imrad(report: &Report) -> String {
    let mut out = report_header(report);

    out.push_str("\n## Introduction\n\n");
    out.push_str(report.intro.as_deref().unwrap_or(
        "This report investigates the table below using Lighthouse's verified analyses. \
         Every figure is computed by the engine, not estimated.",
    ));
    out.push('\n');

    out.push_str("\n## Methods\n\n");
    if report.sections.is_empty() {
        out.push_str("No dated numeric series was available to analyze.\n");
    } else {
        out.push_str(&format!(
            "Lighthouse ran {} verified {} over the table — {}. Each figure below is a query \
             result, and the exact SQL is shown with it.\n",
            report.sections.len(),
            if report.sections.len() == 1 { "analysis" } else { "analyses" },
            report
                .sections
                .iter()
                .map(|s| s.heading.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }

    out.push_str("\n## Results\n");
    if report.sections.is_empty() {
        out.push_str("\n_no rows_\n");
    } else {
        for s in &report.sections {
            push_section(&mut out, s, "###");
        }
    }

    out.push_str("\n## Discussion\n\n");
    out.push_str(report.discussion.as_deref().unwrap_or(
        "See the verified results above; each figure is the engine's, and the caveats below \
         note the limits of the underlying data.",
    ));
    out.push('\n');

    render_caveats(&mut out, &report.caveats, "##");
    out
}

/// Business report (BLUF + Minto). The Bottom line leads (model narration when
/// present, else the top deterministic headline); the verified analyses follow
/// as supporting detail; "What this means" + Caveats close. Numbers are the
/// engine's throughout.
fn render_bluf(report: &Report) -> String {
    let mut out = report_header(report);

    out.push_str("\n## Bottom line\n\n");
    let bottom = report.intro.clone().or_else(|| report.summary.first().cloned());
    out.push_str(bottom.as_deref().unwrap_or("No single figure stood out; see the detail below."));
    out.push('\n');

    if report.summary.len() > 1 {
        out.push_str("\n## Key findings\n\n");
        for line in &report.summary {
            out.push_str(&format!("- {line}\n"));
        }
    }

    out.push_str("\n## Supporting analysis\n");
    if report.sections.is_empty() {
        out.push_str("\n_no rows_\n");
    } else {
        for s in &report.sections {
            push_section(&mut out, s, "###");
        }
    }

    if let Some(d) = &report.discussion {
        out.push_str("\n## What this means\n\n");
        out.push_str(d);
        out.push('\n');
    }

    render_caveats(&mut out, &report.caveats, "##");
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

// --- Report templates (openspec: add-report-templates) ---------------------------

/// The narration prompts for the two templates. Report EXECUTION is Rust-only, so
/// these are Rust-side constants pinned by `reports_test.rs` (not the twinned
/// `promptParity` set). Each asks for plain framing prose over the verified
/// findings — the model narrates the structure; the engine's numbers are the
/// only figures (the grounded SYSTEM_PROMPT forbids inventing any other).
const IMRAD_INTRO_PROMPT: &str = "Write the INTRODUCTION for a scientific-method (IMRaD) report on this data, in 2-3 sentences: what is being investigated and why it matters. Use ONLY the findings in the context; state no figure that is not present there. Plain prose only — no heading, no bullet list, no bracket citations.";
const IMRAD_DISCUSSION_PROMPT: &str = "Write the DISCUSSION for a scientific-method (IMRaD) report, in 3-5 sentences: interpret the verified findings — what they mean, what stands out, and what to watch next. Use ONLY the numbers in the findings; never invent or recompute a figure. Plain prose only — no heading, no bullet list, no bracket citations.";
const BLUF_BOTTOM_LINE_PROMPT: &str = "Write the BOTTOM LINE UP FRONT for a business report, in 1-2 sentences: the single most important takeaway for a decision-maker, stated plainly and first. Use ONLY the numbers in the findings; invent nothing. Plain prose only — no heading, no bullet list, no bracket citations.";
const BLUF_MEANING_PROMPT: &str = "Write a short 'What this means' for a business report, in 2-3 sentences: the implication of the findings and where to focus. Use ONLY the numbers in the findings; never invent or recompute a figure. Plain prose only — no heading, no bullet list, no bracket citations.";

/// A framing narration longer than this reads as a runaway / error response
/// rather than a paragraph; discard it and fall back to deterministic framing.
const NARRATION_CHAR_CAP: usize = 1200;

/// Run the deterministic `investigate` battery, then render it in the requested
/// template. STANDARD is returned unchanged (byte-stable). For a template the
/// SAME engine-verified sections carry every figure; the model narrates only the
/// framing (Introduction/Discussion, or Bottom line/What-this-means) over those
/// findings as ground truth — and only when a narration model is configured. No
/// model (or an empty report) ⇒ the deterministic framing lines stand in, so a
/// report is never blocked on a model.
pub async fn investigate_templated(
    table: &str,
    files: &[(String, String, PathBuf)],
    is_cloud: bool,
    template: ReportTemplate,
    cfg: crate::llm::ModelCfg,
) -> Report {
    let mut report = investigate(table, files, is_cloud).await;
    if template == ReportTemplate::Standard {
        return report;
    }
    report.template = template;
    report.title = format!("{}{}", report.title, template.title_suffix());
    if !report.sections.is_empty() && cfg.provider_id.is_some() {
        // §32 §6: the framing calls ride the same tier seam as narration —
        // capped grounding on apple-fm, byte-identical elsewhere. (The §2
        // profile selection already covers their system prompt via
        // stream_answer → stream_local.)
        let ctx = report_findings_ctx(&report, crate::llm::narration_tier(&cfg));
        match template {
            ReportTemplate::ScientificMethod => {
                report.intro = narrate(IMRAD_INTRO_PROMPT, &ctx, &cfg).await;
                report.discussion = narrate(IMRAD_DISCUSSION_PROMPT, &ctx, &cfg).await;
            }
            ReportTemplate::BusinessReport => {
                report.intro = narrate(BLUF_BOTTOM_LINE_PROMPT, &ctx, &cfg).await;
                report.discussion = narrate(BLUF_MEANING_PROMPT, &ctx, &cfg).await;
            }
            ReportTemplate::Standard => {}
        }
    }
    report
}

/// The verified findings as ONE grounding context block for narration — the
/// summary headlines plus each section's result table. The model may narrate over
/// this but (per the SYSTEM_PROMPT grounding rules) must invent no figure not
/// present here.
///
/// §32 §6: on the apple-fm tiers each section is CAPPED — its heading plus
/// the first `REPORT_SECTION_MAX_ROWS` table rows with an honest "(first N
/// rows of the section's table)" note — so BOTH framing calls fit the shared
/// 4k window with the §1 output reserve intact. The full tables still render
/// deterministically in the report body; only the model's grounding slice
/// shrinks. Cloud/llama keep every row byte-for-byte.
fn report_findings_ctx(report: &Report, tier: crate::budget::Tier) -> Vec<crate::llm::Ctx> {
    let mut text = String::new();
    if !report.summary.is_empty() {
        text.push_str("Key findings:\n");
        for line in &report.summary {
            text.push_str(&format!("- {line}\n"));
        }
        text.push('\n');
    }
    for s in &report.sections {
        let body = if tier.is_apple_fm() {
            capped_section_table(&s.result_markdown)
        } else {
            s.result_markdown.trim().to_string()
        };
        text.push_str(&format!("{}:\n{body}\n\n", s.heading));
    }
    vec![crate::llm::Ctx { name: format!("verified findings for {}", report.title), text, score: 1.0 }]
}

/// Data rows one report section may hand the apple-fm framing calls.
const REPORT_SECTION_MAX_ROWS: usize = 5;

/// The section's table cut to header + alignment + the first N data rows,
/// with an honest note when rows were cut. Non-table bodies ride whole
/// (they are already headline-sized).
fn capped_section_table(markdown: &str) -> String {
    let trimmed = markdown.trim();
    let lines: Vec<&str> = trimmed.lines().collect();
    let table_rows = lines.iter().filter(|l| l.trim_start().starts_with('|')).count();
    if table_rows <= 2 + REPORT_SECTION_MAX_ROWS {
        return trimmed.to_string();
    }
    let mut out: Vec<String> = Vec::new();
    let mut kept = 0usize;
    let mut cut = 0usize;
    for l in lines {
        if l.trim_start().starts_with('|') {
            if kept < 2 + REPORT_SECTION_MAX_ROWS {
                out.push(l.to_string());
                kept += 1;
            } else {
                cut += 1;
            }
        } else {
            out.push(l.to_string());
        }
    }
    out.push(format!(
        "(first {REPORT_SECTION_MAX_ROWS} rows of the section's table; {cut} more rows are in the report itself)"
    ));
    out.join("\n")
}

/// Collect a model narration to a string (the synth.rs streaming-collect idiom
/// with no UI sink). Empty or over-long ⇒ None, so the render falls back to the
/// deterministic framing.
async fn narrate(prompt: &str, ctx: &[crate::llm::Ctx], cfg: &crate::llm::ModelCfg) -> Option<String> {
    use futures::StreamExt;
    let mut stream =
        crate::llm::stream_answer(prompt.to_string(), ctx.to_vec(), cfg.clone(), Vec::new(), None);
    let mut buf = String::new();
    while let Some(d) = stream.next().await {
        buf.push_str(&d);
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() || trimmed.chars().count() > NARRATION_CHAR_CAP {
        None
    } else {
        Some(trimmed.to_string())
    }
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
    fn section_cap_keeps_five_rows_and_tells_the_truth() {
        // §32 §6: a tall section table caps to header + align + 5 rows with an
        // honest note; small tables and non-table bodies ride byte-identical.
        let mut md = String::from("| a | b |\n| --- | --- |\n");
        for i in 0..10 {
            md.push_str(&format!("| r{i} | {i} |\n"));
        }
        let capped = capped_section_table(&md);
        let rows = capped.lines().filter(|l| l.trim_start().starts_with('|')).count();
        assert_eq!(rows, 7, "header + align + 5 data rows: {capped}");
        assert!(capped.contains("first 5 rows of the section's table; 5 more rows"), "{capped}");
        let small = "| a |\n| --- |\n| only |";
        assert_eq!(capped_section_table(small), small, "small tables untouched");
        assert_eq!(capped_section_table("Just a headline."), "Just a headline.");

        // The tier gate: llama grounding is byte-identical to the old shape;
        // apple grounding carries the capped body.
        let report = Report {
            title: "t".into(),
            generated_ms: 0,
            template: ReportTemplate::Standard,
            intro: None,
            discussion: None,
            summary: vec!["headline".into()],
            caveats: Vec::new(),
            sections: vec![ReportSection {
                heading: "By region".into(),
                question: "q".into(),
                result_markdown: md.clone(),
                sql: "SELECT 1".into(),
            }],
        };
        let llama = report_findings_ctx(&report, crate::budget::Tier::Llama6144);
        assert!(llama[0].text.contains("| r9 | 9 |"), "llama keeps every row");
        let apple = report_findings_ctx(&report, crate::budget::Tier::AppleFm4096);
        assert!(!apple[0].text.contains("| r9 | 9 |"), "apple grounding is capped");
        assert!(apple[0].text.contains("Key findings:"), "headlines always ride");
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
        // §1: the report's SQL is display-formatted (clause per line).
        assert!(a.contains("```sql\nSELECT period, total\nFROM t\n```"), "{a}");
        assert!(a.contains("## Caveats"));
        assert!(a.contains("- Latest month may be partial."));
        // The generation time is formatted from generated_ms (deterministic).
        assert!(a.contains("UTC"));
    }
}
