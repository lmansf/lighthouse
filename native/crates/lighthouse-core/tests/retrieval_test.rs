//! Retrieval parity tests: tokenizer, TF-IDF ranking, filename matching,
//! catalog/listing intent, attachment scoping, server-authoritative inclusion.

mod common;

use lighthouse_core::vault;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn include_all(ids: &[&str]) -> Vec<String> {
    for id in ids {
        vault::set_included(id, true);
    }
    ids.iter().map(|s| s.to_string()).collect()
}

#[test]
fn tokenize_lowercases_strips_stopwords_and_short_tokens() {
    assert_eq!(
        vault::tokenize("The Quick brown-fox DOES jump over 42 logs, a lot!"),
        vec!["quick", "brown", "fox", "jump", "over", "42", "logs", "lot"]
    );
    assert!(vault::tokenize("a I of to x 1").is_empty());
}

#[test]
fn content_ranking_finds_the_relevant_file_first() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(
        &vault_dir.path().join("budget.md"),
        "The quarterly budget forecast includes revenue targets and expense caps for marketing.",
    );
    write(
        &vault_dir.path().join("recipe.md"),
        "Sourdough starter needs flour, water, and patience over several days of feeding.",
    );
    let ids = include_all(&["budget.md", "recipe.md"]);

    let r = vault::retrieve(
        "what are the revenue targets in the budget?",
        &ids,
        5,
        &[],
        &[],
        false,
    );
    assert!(!r.references.is_empty());
    assert_eq!(r.references[0].file_id, "budget.md");
    assert_eq!(r.references[0].score, 1.0, "top score normalizes to 1.0");
    assert!(r.contexts[0].text.contains("revenue targets"));
}

#[test]
fn file_findable_by_name_even_without_content_match() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // The canonical README case: anonymized rows, telling filename.
    write(
        &vault_dir.path().join("creditcard.csv"),
        "4111,2026,123\n5500,2027,456\n",
    );
    write(
        &vault_dir.path().join("notes.md"),
        "meeting notes about roadmap themes",
    );
    let ids = include_all(&["creditcard.csv", "notes.md"]);

    let r = vault::retrieve("do I have any credit cards?", &ids, 5, &[], &[], false);
    assert!(!r.references.is_empty(), "name match must surface the file");
    assert_eq!(r.references[0].file_id, "creditcard.csv");
    // Name-only candidates score in the 0.5..0.9 band before normalization.
    assert!(r.references[0].score > 0.0 && r.references[0].score <= 1.0);
}

#[test]
fn listing_intent_enumerates_instead_of_ranking() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("a.csv"), "x,y\n1,2\n");
    write(&vault_dir.path().join("b.pdf"), "%PDF-1.4 stub");
    write(&vault_dir.path().join("c.md"), "hello notes");
    let ids = include_all(&["a.csv", "b.pdf", "c.md"]);

    // "show me all files" → enumerate everything.
    let all = vault::retrieve("show me all files", &ids, 5, &[], &[], false);
    assert_eq!(all.contexts.len(), 1);
    assert!(
        all.contexts[0].text.starts_with("3 included files:"),
        "got: {}",
        all.contexts[0].text
    );
    assert_eq!(all.references.len(), 3);

    // "how many pdfs" → narrowed by kind.
    let pdfs = vault::retrieve("how many pdfs do I have?", &ids, 5, &[], &[], false);
    assert!(
        pdfs.contexts[0].text.starts_with("1 included PDFs:"),
        "got: {}",
        pdfs.contexts[0].text
    );

    // A named type qualifier narrows to exactly those extensions.
    let csvs = vault::retrieve("list my csv files", &ids, 5, &[], &[], false);
    assert!(csvs.contexts[0].text.contains("a.csv"));
    assert!(!csvs.contexts[0].text.contains("c.md"));

    // A content question with a residual token must NOT enumerate.
    let content = vault::retrieve("which documents mention the lawsuit", &ids, 5, &[], &[], false);
    assert!(
        content
            .contexts
            .first()
            .map(|c| !c.text.starts_with("3 included"))
            .unwrap_or(true),
        "content questions fall through to ranking"
    );
}

#[test]
fn attachments_scope_and_inclusion_is_server_authoritative() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(
        &vault_dir.path().join("in.md"),
        "zebra migration patterns in the savanna",
    );
    write(
        &vault_dir.path().join("out.md"),
        "zebra stripes and camouflage research",
    );
    vault::set_included("in.md", true); // out.md stays excluded

    // A stale client claiming an excluded file cannot leak it into retrieval.
    let claimed: Vec<String> = vec!["in.md".into(), "out.md".into()];
    let r = vault::retrieve("zebra", &claimed, 5, &[], &[], false);
    assert!(
        r.references.iter().all(|refr| refr.file_id == "in.md"),
        "excluded file must not leak"
    );

    // An explicit attachment bypasses the global included set (the attach
    // gesture is the consent) — even for a file not globally included.
    let attached = vault::retrieve("zebra", &[], 5, &[], &["out.md".to_string()], false);
    assert_eq!(attached.references.len(), 1);
    assert_eq!(attached.references[0].file_id, "out.md");
}

#[test]
fn unavailable_source_empties_retrieval() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    write(&vault_dir.path().join("x.md"), "searchable content here");
    let ids = include_all(&["x.md"]);
    vault::set_source_available(false);
    let r = vault::retrieve("searchable content", &ids, 5, &[], &[], false);
    assert!(
        r.references.is_empty(),
        "hiding the source drops it from the very next answer"
    );
    vault::set_source_available(true);
    let r = vault::retrieve("searchable content", &ids, 5, &[], &[], false);
    assert!(!r.references.is_empty());
}

#[test]
fn indexed_files_are_searchable_past_the_legacy_1mb_cap() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    // Phase 5: the legacy 1 MB per-file cap protected the per-query read loop;
    // with the persistent index, content past 1 MB is retrievable (default cap
    // 8 MB, env-tunable), and content past the configured cap stays invisible.
    let mut big = String::with_capacity(2_100_000);
    big.push_str("findable-prefix-token appears early. ");
    while big.len() < 1_050_000 {
        big.push_str("filler words repeat here endlessly ");
    }
    big.push_str(" hidden-suffix-needle appears late.");
    while big.len() < 2_000_000 {
        big.push_str("more filler after the needle ");
    }
    write(&vault_dir.path().join("big.txt"), &big);
    let ids = include_all(&["big.txt"]);

    let early = vault::retrieve("findable prefix token", &ids, 5, &[], &[], false);
    assert!(
        !early.references.is_empty(),
        "prefix content is retrievable"
    );
    let late = vault::retrieve("hidden suffix needle", &ids, 5, &[], &[], false);
    assert!(
        !late.references.is_empty(),
        "content past the legacy 1MB cap is now indexed and retrievable"
    );

    // A tighter env cap still bounds one pathological file.
    std::env::set_var("LIGHTHOUSE_INDEX_MAX_FILE_BYTES", "1000000");
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&vault_dir.path().join("big.txt"), &big); // new mtime ⇒ entry rebuilds
    let capped = vault::retrieve("hidden suffix needle", &ids, 5, &[], &[], false);
    std::env::remove_var("LIGHTHOUSE_INDEX_MAX_FILE_BYTES");
    assert!(
        capped.references.is_empty(),
        "content past the configured cap is not indexed"
    );
}
