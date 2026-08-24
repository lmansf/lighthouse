//! Meta-answers + suggested asks over a conversation's ATTACHMENTS: instant
//! deterministic answers with real references, and catalog-derived example
//! questions (openspec: add-vault-meta-answers, re-pointed at the workspace by
//! refocus-chat-attachments).

mod common;

/// One conversation per file — every case here shares its attachments.
const CONV: &str = "conv-meta";

use lighthouse_core::meta::{capability_map, meta_intent, render_meta, suggested_asks};

#[test]
fn meta_answers_and_suggestions_come_from_the_vault() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let included = common::attach_all(
        CONV,
        &[
            ("sales.csv", b"date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n"),
            ("notes.md", b"# planning\nsome prose\n"),
        ],
    );
    let now_ms = lighthouse_core::config::now_ms();

    // "What's new this week?" — both fresh files, newest first, cited.
    let intent = meta_intent("What's new this week?").expect("recency cue");
    let ans = render_meta(CONV, &intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert!(ans.markdown.contains("just now"), "age labels present: {}", ans.markdown);
    assert_eq!(ans.references.len(), 2, "both files cited");

    // "What spreadsheets do I have?" — only the CSV, with a count.
    let intent = meta_intent("What spreadsheets do I have?").expect("inventory cue");
    let ans = render_meta(CONV, &intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("**1 spreadsheet**"), "{}", ans.markdown);
    assert!(ans.markdown.contains("sales.csv") && !ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // "Which files have a region column?" — catalog scan names file + kind.
    let intent = meta_intent("Which files have a region column?").expect("column cue");
    let ans = render_meta(CONV, &intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("`region`") && ans.markdown.contains("text"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // No matching column: still a deterministic, honest answer.
    let intent = meta_intent("Which files have a payroll_id column?").expect("column cue");
    let ans = render_meta(CONV, &intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("No column like"), "{}", ans.markdown);
    assert!(ans.references.is_empty());

    // Suggested asks derive from sales.csv's real columns (numeric amount ×
    // text region, date column ⇒ monthly trend) and are file-scoped.
    let asks = suggested_asks(CONV, &included);
    let labels: Vec<&str> = asks.iter().map(|a| a.label.as_str()).collect();
    assert!(labels.contains(&"Total amount by region"), "{labels:?}");
    assert!(labels.contains(&"Monthly trend of amount"), "{labels:?}");
    assert!(asks.iter().all(|a| a.question.contains("sales.csv")), "{asks:?}");
    assert!(asks.len() <= 4);

    // A conversation holding only prose has nothing tabular to suggest over.
    let prose = common::attach_all("conv-prose", &[("notes.md", b"# planning\nsome prose\n")]);
    assert!(
        suggested_asks("conv-prose", &prose).is_empty(),
        "no tabular ⇒ no suggestions"
    );
}

// --- Capability map (openspec: add-deep-analysis §3) ------------------------------

#[tokio::test]
async fn capability_map_aggregates_the_investigable_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let ids = common::attach_all(
        CONV,
        &[(
            "sales.csv",
            b"date,region,amount\n2026-01-05,NE,100\n2026-02-06,NW,50\n2026-03-06,NE,75\n",
        )],
    );

    let map = capability_map(CONV.to_string(), ids).await;

    // The Date+Numeric table is listed, typed, and flagged investigable.
    let sales = map.tables.iter().find(|t| t.name == "sales.csv").expect("sales table listed");
    assert!(sales.investigable, "a date+numeric table is investigable");
    assert!(sales.columns.iter().any(|c| c.name == "amount"), "typed columns carried");

    // Exactly one "Investigate sales.csv" — one investigation per date+numeric table.
    assert!(
        map.suggested_investigations
            .iter()
            .any(|s| s.table == "sales.csv" && s.label == "Investigate sales.csv"),
        "an investigation is offered: {:?}",
        map.suggested_investigations
    );

    // The recipes + asks the nav computes are aggregated here verbatim.
    assert!(map.recipes.iter().any(|r| r.table == "sales.csv"), "recipes for the table: {:?}", map.recipes);
    assert!(
        map.recipes.iter().any(|r| r.id == "variance-vs-last-period"),
        "the temporal recipes apply: {:?}",
        map.recipes
    );
    assert!(
        map.suggested_asks
            .iter()
            .any(|a| a.label == "Total amount by region" || a.label == "Monthly trend of amount"),
        "asks aggregated: {:?}",
        map.suggested_asks
    );
}

#[tokio::test]
async fn a_corpus_with_no_analyzable_table_offers_no_investigations() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    // A text-only table (no numeric, no date) — nothing investigable.
    let ids = common::attach_all(CONV, &[("labels.csv", b"label,note\na,hello\nb,world\n")]);

    let map = capability_map(CONV.to_string(), ids).await;

    // The table is still listed (with its columns) but flagged not investigable,
    // and NO investigation is offered (it would produce an empty report).
    let labels = map.tables.iter().find(|t| t.name == "labels.csv").expect("table listed");
    assert!(!labels.investigable, "no date+numeric ⇒ not investigable");
    assert!(map.suggested_investigations.is_empty(), "no analyzable table ⇒ no investigations");
}

// The `cloud_posture_drops_local_only_capabilities` case lived here. Local-only
// marks were vault state — a flag keyed by node id, resolved ancestor-wins
// through the walk — and went with the vault in 0.15.0. What a cloud model can
// see is now exactly what the user attached to the conversation, so there is no
// second posture for the capability map to have.
