//! Retrieval parity tests: tokenizer, TF-IDF ranking, filename matching, and
//! per-question attachment scoping — over a conversation's ATTACHMENTS.
//!
//! Retrieval used to run over a vault walk gated by inclusion flags, and half
//! these cases were about that gate (server-authoritative inclusion, a hidden
//! source, a stale client's claim). Since 0.15.0 the corpus IS the attachment
//! set, so the gate is gone and what remains is the RANKER — which is what
//! these now pin, over `workspace::retrieve` → `retrieval::retrieve_items`.

mod common;

use lighthouse_core::retrieval;
use lighthouse_core::workspace;

const CONV: &str = "conv-retrieval";

/// Retrieve over the whole conversation.
fn ask(query: &str) -> lighthouse_core::retrieval::Retrieved {
    workspace::retrieve(CONV, query, &[], 5, &[])
}

#[test]
fn tokenize_lowercases_strips_stopwords_and_short_tokens() {
    assert_eq!(
        retrieval::tokenize("The Quick brown-fox DOES jump over 42 logs, a lot!"),
        vec!["quick", "brown", "fox", "jump", "over", "42", "logs", "lot"]
    );
    assert!(retrieval::tokenize("a I of to x 1").is_empty());
}

#[test]
fn content_ranking_finds_the_relevant_file_first() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let ids = common::attach_all(
        CONV,
        &[
            ("budget.md", b"The quarterly budget forecast includes revenue targets and expense caps for marketing."),
            ("recipe.md", b"Sourdough starter needs flour, water, and patience over several days of feeding."),
        ],
    );

    let r = ask("what are the revenue targets in the budget?");
    assert!(!r.references.is_empty());
    assert_eq!(r.references[0].file_id, ids[0], "budget.md ranks first");
    assert_eq!(r.references[0].score, 1.0, "top score normalizes to 1.0");
    assert!(r.contexts[0].text.contains("revenue targets"));
}

#[test]
fn file_findable_by_name_even_without_content_match() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    // The canonical README case: anonymized rows, telling filename.
    let ids = common::attach_all(
        CONV,
        &[
            ("creditcard.csv", b"4111,2026,123\n5500,2027,456\n"),
            ("notes.md", b"meeting notes about roadmap themes"),
        ],
    );

    let r = ask("do I have any credit cards?");
    assert!(!r.references.is_empty(), "name match must surface the file");
    assert_eq!(r.references[0].file_id, ids[0]);
    // Name-only candidates score in the 0.5..0.9 band before normalization.
    assert!(r.references[0].score > 0.0 && r.references[0].score <= 1.0);
}

#[test]
fn a_per_question_subset_scopes_retrieval_to_exactly_those_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    let ids = common::attach_all(
        CONV,
        &[
            ("in.md", b"zebra migration patterns in the savanna"),
            ("out.md", b"zebra stripes and camouflage research"),
        ],
    );

    // Whole conversation: both are candidates.
    let all = ask("zebra");
    assert_eq!(all.references.len(), 2, "both attachments are in the corpus");

    // Narrowed to one: the other cannot appear, however well it matches.
    let scoped = workspace::retrieve(CONV, "zebra", &[ids[1].clone()], 5, &[]);
    assert_eq!(scoped.references.len(), 1);
    assert_eq!(scoped.references[0].file_id, ids[1]);
}

#[test]
fn another_conversations_attachments_are_never_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());
    common::attach_all(CONV, &[("mine.md", b"zebra migration patterns")]);
    common::attach_all("conv-other", &[("theirs.md", b"zebra stripes and camouflage")]);

    let r = ask("zebra");
    assert_eq!(r.references.len(), 1, "only this conversation's attachment: {r:?}");
    assert!(r.references[0].name == "mine.md");

    // And a conversation with nothing attached retrieves nothing.
    let empty = workspace::retrieve("conv-empty", "zebra", &[], 5, &[]);
    assert!(empty.references.is_empty());
}

#[test]
fn indexed_files_are_searchable_past_the_legacy_1mb_cap() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(dir.path());

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
    common::attach_all(CONV, &[("big.txt", big.as_bytes())]);

    assert!(!ask("findable prefix token").references.is_empty(), "prefix content is retrievable");
    assert!(
        !ask("hidden suffix needle").references.is_empty(),
        "content past the legacy 1MB cap is now indexed and retrievable"
    );

    // A tighter env cap still bounds one pathological file. Attachment blobs are
    // write-once and content-addressed, so a re-read cannot change the bytes —
    // the cap has to be proven on a DIFFERENT conversation, whose index entry is
    // built fresh under the new limit.
    std::env::set_var("LIGHTHOUSE_INDEX_MAX_FILE_BYTES", "1000000");
    lighthouse_core::index::invalidate_all();
    common::attach_all("conv-capped", &[("big.txt", big.as_bytes())]);
    let capped = workspace::retrieve("conv-capped", "hidden suffix needle", &[], 5, &[]);
    std::env::remove_var("LIGHTHOUSE_INDEX_MAX_FILE_BYTES");
    lighthouse_core::index::invalidate_all();
    assert!(capped.references.is_empty(), "content past the configured cap is not indexed");
}
