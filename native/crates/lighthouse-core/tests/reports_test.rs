//! Deep-analysis report engine (openspec: add-deep-analysis §2), end to end.
//! Writes fixture CSVs, builds the `(file_id, name, path)` triples the op passes,
//! and drives `reports::investigate` — the same on-device DataFusion recipe
//! battery the surface uses. No VAULT_DIR and no provider: every figure is a
//! `run_query` cell, so these prove the zero-network posture by construction (no
//! key is ever set) and need no env lock.

use std::path::PathBuf;

use lighthouse_core::llm::ModelCfg;
use lighthouse_core::reports::{
    investigate, investigate_templated, render_markdown, write_report, ReportTemplate,
};

mod common;

fn write_csv(dir: &std::path::Path, name: &str, body: &str) -> (String, String, PathBuf) {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    (format!("id-{name}"), name.to_string(), path)
}

/// A dated numeric series that holds ~100 then spikes to 400 in October — a clear
/// 2σ anomaly AND a level shift for the battery to surface across sections.
const SPIKE_CSV: &str = "d,amount\n\
    2024-01-15,100\n2024-02-15,100\n2024-03-15,100\n2024-04-15,100\n2024-05-15,100\n\
    2024-06-15,100\n2024-07-15,100\n2024-08-15,100\n2024-09-15,100\n2024-10-15,400\n";

/// A text-only table — no dated numeric series, so nothing is investigable.
const TEXT_CSV: &str = "label,note\na,hello\nb,world\n";

#[tokio::test]
async fn investigate_assembles_a_multi_section_engine_verified_report() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let report = investigate("sales.csv", &files, false).await;

    // The title names the table; the battery produced several sections (variance,
    // anomaly, forecast, changepoint, data-quality — cohort/movers need a text
    // column this fixture lacks).
    assert_eq!(report.title, "Investigate sales.csv");
    assert!(
        report.sections.len() >= 3,
        "a dated numeric table yields several sections, got {}",
        report.sections.len()
    );

    // Every section carries its exact SQL (reproducible) and an evidence table.
    for s in &report.sections {
        assert!(!s.sql.trim().is_empty(), "section {:?} carries its query", s.heading);
        assert!(
            !s.result_markdown.trim().is_empty(),
            "section {:?} carries an evidence table",
            s.heading
        );
    }

    // The anomaly section surfaced (October breaches the 2σ fence) and its
    // headline reached the summary — an engine z-score, not model text.
    let anomaly = report
        .sections
        .iter()
        .find(|s| s.heading == "Anomaly scan")
        .expect("the spike is surfaced as an anomaly section");
    assert!(
        report.summary.iter().any(|l| l.contains("2024-10") && l.contains('σ')),
        "the summary names the October anomaly with a z-score: {:?}",
        report.summary
    );

    // The every-number invariant: the summary's anomaly period is present in the
    // anomaly section's own result (the summary is reproducible from the SQL, no
    // figure is model-introduced).
    assert!(
        anomaly.result_markdown.contains("2024-10"),
        "the anomaly figure lives in the section result: {}",
        anomaly.result_markdown
    );
    assert!(
        !report.summary.iter().any(|l| l.contains("Nothing to analyze")),
        "an analyzable table is not the empty report"
    );

    // A month-bucketing caveat is disclosed (engine-authored, honest).
    assert!(
        report.caveats.iter().any(|c| c.contains("calendar month")),
        "the report discloses its month bucketing: {:?}",
        report.caveats
    );

    // The render is deterministic (same Report → same bytes) and standalone.
    let a = render_markdown(&report);
    let b = render_markdown(&report);
    assert_eq!(a, b, "the render is byte-stable");
    assert!(a.starts_with("# Investigate sales.csv\n"));
    assert!(a.contains("## Summary"));
    assert!(a.contains("## Anomaly scan"));
    assert!(a.contains("```sql"), "every section carries its Query-used block");
    assert!(a.contains("## Caveats"));
}

#[tokio::test]
async fn an_unanalyzable_table_returns_an_honest_empty_report() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "notes.csv", TEXT_CSV)];

    let report = investigate("notes.csv", &files, false).await;

    // No dated numeric shape → no sections, and an honest summary, never an error
    // and never a fabricated section.
    assert!(report.sections.is_empty(), "no Date+Numeric shape → no sections");
    assert_eq!(report.summary.len(), 1);
    assert!(
        report.summary[0].contains("Nothing to analyze"),
        "an honest empty summary: {:?}",
        report.summary
    );
    // It still renders as a standalone document (title + summary), no panic.
    let md = render_markdown(&report);
    assert!(md.starts_with("# Investigate notes.csv\n"));
    assert!(md.contains("Nothing to analyze"));
}

#[tokio::test]
async fn an_unknown_table_degrades_to_empty_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    // A table name absent from the vault resolves to nothing — an honest empty
    // report, never a panic or a fabricated section.
    let report = investigate("does-not-exist.csv", &files, false).await;
    assert!(report.sections.is_empty());
    assert_eq!(report.summary.len(), 1);
    assert!(report.summary[0].contains("Nothing to analyze"));
}

#[tokio::test]
async fn the_report_is_byte_identical_across_runs_with_a_fixed_time() {
    // Determinism of the assembled+rendered report over an unchanged table: two
    // independent `investigate` runs differ ONLY in the generated timestamp, so
    // stamping both renders to the same instant yields byte-identical documents
    // (the core is model-free SQL assembled by a pure renderer).
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let mut a = investigate("sales.csv", &files, false).await;
    let mut b = investigate("sales.csv", &files, false).await;
    a.generated_ms = 1_700_000_000_000;
    b.generated_ms = 1_700_000_000_000;
    assert_eq!(
        render_markdown(&a),
        render_markdown(&b),
        "the model-free report is reproducible from the same table"
    );
}

#[tokio::test]
async fn investigate_writes_the_report_under_the_reports_allowlist() {
    // The in-vault write (§2.4) touches the vault, so it env-locks VAULT_DIR to a
    // temp dir (the shared serial lock). `investigate` still reads the passed
    // paths directly; only `write_report` needs the vault.
    let dir = tempfile::tempdir().unwrap();
    let _lock = common::lock_env(dir.path());
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let report = investigate("sales.csv", &files, false).await;
    let (id, name) = write_report(&report, None).expect("the report writes into the vault");

    // It lands under the reports allowlist as a markdown note, and returns its id.
    assert!(id.starts_with("Lighthouse Reports/"), "under the reports allowlist: {id}");
    assert!(id.ends_with(".md"), "a markdown note: {id}");
    assert!(name.ends_with(".md"), "the returned name is the note file: {name}");

    // The note is on disk under the vault, carrying the rendered report (a
    // non-egress, in-vault artifact).
    let written = std::fs::read_to_string(dir.path().join(&id)).expect("the note is on disk");
    assert!(written.starts_with("# Investigate sales.csv\n"), "the rendered report: {written:.40}");
    assert!(written.contains("## Summary"));
    assert!(written.contains("## Anomaly scan"));
}

// --- Report templates (openspec: add-report-templates) ----------------------------
// All template tests pass an EMPTY `ModelCfg` (no provider), so `investigate_templated`
// takes the deterministic-framing path — no narration model is called and the suite
// stays zero-network by construction, exactly like the Standard tests above. They
// prove the STRUCTURE (the IMRaD / BLUF skeleton) and that every figure is still an
// engine cell carried from the SAME verified sections.

/// A no-provider config: `provider_id.is_none()` ⇒ the deterministic framing path.
fn no_model() -> ModelCfg {
    ModelCfg { provider_id: None, model_id: None, api_key: None }
}

#[tokio::test]
async fn scientific_method_template_renders_imrad_structure() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let report =
        investigate_templated("sales.csv", &files, false, ReportTemplate::ScientificMethod, no_model())
            .await;

    // The template names itself in the title; the sections are the SAME verified ones.
    assert_eq!(report.title, "Investigate sales.csv — Scientific method");
    assert_eq!(report.template, ReportTemplate::ScientificMethod);
    assert!(report.sections.len() >= 3, "the verified sections carry over");
    assert!(report.intro.is_none(), "no provider ⇒ no model narration, deterministic framing");
    assert!(report.discussion.is_none());

    let md = render_markdown(&report);
    // The IMRaD skeleton, in order.
    assert!(md.starts_with("# Investigate sales.csv — Scientific method\n"));
    let intro = md.find("## Introduction").expect("has an Introduction");
    let methods = md.find("## Methods").expect("has a Methods");
    let results = md.find("## Results").expect("has a Results");
    let discussion = md.find("## Discussion").expect("has a Discussion");
    assert!(intro < methods && methods < results && results < discussion, "IMRaD order: {md}");
    // Deterministic framing stands in for the absent model narration.
    assert!(md.contains("Every figure is computed by the engine, not estimated."));
    // Results nest the verified sections at ### and keep their Query-used block.
    assert!(md.contains("### Anomaly scan"));
    assert!(md.contains("```sql"), "the verified section keeps its SQL");
    assert!(md.contains("## Caveats"));
    // The every-number invariant holds through the template: the engine anomaly
    // figure is present, and no model introduced any figure (no provider ran).
    assert!(md.contains("2024-10"), "the engine's October figure survives templating");
    // §38 §3: the footer names the framing's author — the engine, honestly.
    assert!(
        md.ends_with(
            "\n_Framing written by the engine from the computed findings (model unavailable)._\n"
        ),
        "the engine-framing footer closes the document: {md}"
    );
}

#[tokio::test]
async fn business_report_template_renders_bluf_structure() {
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let report =
        investigate_templated("sales.csv", &files, false, ReportTemplate::BusinessReport, no_model())
            .await;

    assert_eq!(report.title, "Investigate sales.csv — Business report");
    assert_eq!(report.template, ReportTemplate::BusinessReport);
    assert!(report.intro.is_none(), "no provider ⇒ no model narration");
    assert!(report.discussion.is_none());

    let md = render_markdown(&report);
    assert!(md.starts_with("# Investigate sales.csv — Business report\n"));
    let bottom = md.find("## Bottom line").expect("leads with the Bottom line");
    let support = md.find("## Supporting analysis").expect("has Supporting analysis");
    assert!(bottom < support, "BLUF: the bottom line leads the detail: {md}");
    // With no model, the bottom line falls back to the top deterministic headline —
    // an engine figure (the October spike), never model text.
    assert!(md.contains("2024-10"), "the bottom line is the engine's top finding");
    // Supporting analyses nest at ### with their Query-used block.
    assert!(md.contains("### Anomaly scan"));
    assert!(md.contains("```sql"));
    assert!(md.contains("## Caveats"));
    // No model ⇒ no "What this means" block (discussion stays None, gated out).
    assert!(!md.contains("## What this means"), "no narration ⇒ no What-this-means block");
    // §38 §3: the same honest footer on the business template.
    assert!(
        md.ends_with(
            "\n_Framing written by the engine from the computed findings (model unavailable)._\n"
        ),
        "the engine-framing footer closes the document: {md}"
    );
}

#[tokio::test]
async fn templated_standard_is_byte_identical_to_investigate() {
    // The Standard template must be the UNCHANGED deterministic document — the
    // byte-stability contract the whole render split preserves.
    let dir = tempfile::tempdir().unwrap();
    let files = vec![write_csv(dir.path(), "sales.csv", SPIKE_CSV)];

    let mut plain = investigate("sales.csv", &files, false).await;
    let mut templated =
        investigate_templated("sales.csv", &files, false, ReportTemplate::Standard, no_model()).await;
    // Independent runs differ only in the generation timestamp; pin both.
    plain.generated_ms = 1_700_000_000_000;
    templated.generated_ms = 1_700_000_000_000;

    assert_eq!(templated.template, ReportTemplate::Standard);
    assert_eq!(templated.title, "Investigate sales.csv", "Standard carries no title suffix");
    assert_eq!(
        render_markdown(&plain),
        render_markdown(&templated),
        "the Standard template is the byte-identical deterministic document"
    );
}
