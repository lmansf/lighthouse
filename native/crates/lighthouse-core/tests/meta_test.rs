//! Vault meta-answers + suggested asks over a real temp vault: instant
//! deterministic answers with real references, and catalog-derived example
//! questions (openspec: add-vault-meta-answers).

mod common;

use lighthouse_core::meta::{capability_map, meta_intent, render_meta, suggested_asks};
use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn meta_answers_and_suggestions_come_from_the_vault() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(&dir.path().join("sales.csv"), "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n");
    write(&dir.path().join("notes.md"), "# planning\nsome prose\n");
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);
    vault::set_included("notes.md", true);

    let included = vec!["sales.csv".to_string(), "notes.md".to_string()];
    let now_ms = lighthouse_core::config::now_ms();

    // "What's new this week?" — both fresh files, newest first, cited.
    let intent = meta_intent("What's new this week?").expect("recency cue");
    let ans = render_meta(&intent, &included, now_ms, false).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert!(ans.markdown.contains("just now"), "age labels present: {}", ans.markdown);
    assert_eq!(ans.references.len(), 2, "both files cited");

    // "What spreadsheets do I have?" — only the CSV, with a count.
    let intent = meta_intent("What spreadsheets do I have?").expect("inventory cue");
    let ans = render_meta(&intent, &included, now_ms, false).expect("renders");
    assert!(ans.markdown.contains("**1 spreadsheet**"), "{}", ans.markdown);
    assert!(ans.markdown.contains("sales.csv") && !ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // "Which files have a region column?" — catalog scan names file + kind.
    let intent = meta_intent("Which files have a region column?").expect("column cue");
    let ans = render_meta(&intent, &included, now_ms, false).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("`region`") && ans.markdown.contains("text"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // No matching column: still a deterministic, honest answer.
    let intent = meta_intent("Which files have a payroll_id column?").expect("column cue");
    let ans = render_meta(&intent, &included, now_ms, false).expect("renders");
    assert!(ans.markdown.contains("No column like"), "{}", ans.markdown);
    assert!(ans.references.is_empty());

    // Suggested asks derive from sales.csv's real columns (numeric amount ×
    // text region, date column ⇒ monthly trend) and are file-scoped.
    let asks = suggested_asks(&included, false);
    let labels: Vec<&str> = asks.iter().map(|a| a.label.as_str()).collect();
    assert!(labels.contains(&"Total amount by region"), "{labels:?}");
    assert!(labels.contains(&"Monthly trend of amount"), "{labels:?}");
    assert!(asks.iter().all(|a| a.question.contains("sales.csv")), "{asks:?}");
    assert!(asks.len() <= 4);

    // Excluding the spreadsheet empties the suggestions (docs only ⇒ none).
    vault::set_included("sales.csv", false);
    vault::invalidate_walk_cache();
    assert!(suggested_asks(&included, false).is_empty(), "no tabular ⇒ no suggestions");
}

// --- Capability map (openspec: add-deep-analysis §3) ------------------------------

#[tokio::test]
async fn capability_map_aggregates_the_investigable_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(
        &dir.path().join("sales.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-02-06,NW,50\n2026-03-06,NE,75\n",
    );
    vault::invalidate_walk_cache();
    vault::set_included("sales.csv", true);

    let map = capability_map(vec!["sales.csv".to_string()], false).await;

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
async fn a_vault_with_no_analyzable_table_offers_no_investigations() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    // A text-only table (no numeric, no date) — nothing investigable.
    write(&dir.path().join("labels.csv"), "label,note\na,hello\nb,world\n");
    vault::invalidate_walk_cache();
    vault::set_included("labels.csv", true);

    let map = capability_map(vec!["labels.csv".to_string()], false).await;

    // The table is still listed (with its columns) but flagged not investigable,
    // and NO investigation is offered (it would produce an empty report).
    let labels = map.tables.iter().find(|t| t.name == "labels.csv").expect("table listed");
    assert!(!labels.investigable, "no date+numeric ⇒ not investigable");
    assert!(map.suggested_investigations.is_empty(), "no analyzable table ⇒ no investigations");
}

#[tokio::test]
async fn cloud_posture_drops_local_only_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    write(
        &dir.path().join("private.csv"),
        "date,region,amount\n2026-01-05,NE,100\n2026-02-06,NW,50\n2026-03-06,NE,75\n",
    );
    vault::invalidate_walk_cache();
    vault::set_included("private.csv", true);
    vault::set_local_only("private.csv", true);

    let included = vec!["private.csv".to_string()];

    // On device: the table + its investigation are present.
    let local = capability_map(included.clone(), false).await;
    assert!(local.tables.iter().any(|t| t.name == "private.csv"), "present on device");
    assert!(
        local.suggested_investigations.iter().any(|s| s.table == "private.csv"),
        "investigable on device"
    );

    // On cloud: a local-only file is dropped everywhere (the shareable subset the
    // sources gate on), so the map offers no table, no investigation, no recipe —
    // matching what the underlying `applicable_*` return for the same posture.
    let cloud = capability_map(included, true).await;
    assert!(!cloud.tables.iter().any(|t| t.name == "private.csv"), "dropped from cloud tables");
    assert!(cloud.suggested_investigations.is_empty(), "no cloud investigation for a local-only table");
    assert!(!cloud.recipes.iter().any(|r| r.table == "private.csv"), "no cloud recipes for a local-only table");
}
