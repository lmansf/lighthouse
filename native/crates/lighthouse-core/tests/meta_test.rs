//! Vault meta-answers + suggested asks over a real temp vault: instant
//! deterministic answers with real references, and catalog-derived example
//! questions (openspec: add-vault-meta-answers).

mod common;

use lighthouse_core::meta::{meta_intent, render_meta, suggested_asks};
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
    let ans = render_meta(&intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert!(ans.markdown.contains("just now"), "age labels present: {}", ans.markdown);
    assert_eq!(ans.references.len(), 2, "both files cited");

    // "What spreadsheets do I have?" — only the CSV, with a count.
    let intent = meta_intent("What spreadsheets do I have?").expect("inventory cue");
    let ans = render_meta(&intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("**1 spreadsheet**"), "{}", ans.markdown);
    assert!(ans.markdown.contains("sales.csv") && !ans.markdown.contains("notes.md"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // "Which files have a region column?" — catalog scan names file + kind.
    let intent = meta_intent("Which files have a region column?").expect("column cue");
    let ans = render_meta(&intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("sales.csv"), "{}", ans.markdown);
    assert!(ans.markdown.contains("`region`") && ans.markdown.contains("text"), "{}", ans.markdown);
    assert_eq!(ans.references.len(), 1);

    // No matching column: still a deterministic, honest answer.
    let intent = meta_intent("Which files have a payroll_id column?").expect("column cue");
    let ans = render_meta(&intent, &included, now_ms).expect("renders");
    assert!(ans.markdown.contains("No column like"), "{}", ans.markdown);
    assert!(ans.references.is_empty());

    // Suggested asks derive from sales.csv's real columns (numeric amount ×
    // text region, date column ⇒ monthly trend) and are file-scoped.
    let asks = suggested_asks(&included);
    let labels: Vec<&str> = asks.iter().map(|a| a.label.as_str()).collect();
    assert!(labels.contains(&"Total amount by region"), "{labels:?}");
    assert!(labels.contains(&"Monthly trend of amount"), "{labels:?}");
    assert!(asks.iter().all(|a| a.question.contains("sales.csv")), "{asks:?}");
    assert!(asks.len() <= 4);

    // Excluding the spreadsheet empties the suggestions (docs only ⇒ none).
    vault::set_included("sales.csv", false);
    vault::invalidate_walk_cache();
    assert!(suggested_asks(&included).is_empty(), "no tabular ⇒ no suggestions");
}
