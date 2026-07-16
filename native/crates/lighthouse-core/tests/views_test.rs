//! Shaped-views store over a real temp vault (openspec: add-shaped-views):
//! round trip with derived reads, unknown-version/corrupt bak-on-write, the
//! save-time guard, the name rules (reserved words, view/table collisions,
//! sanitization), unknown-table refusal, the DAG rules (depth cap, crafted-
//! cycle refusal), the lifecycle rules (rename/delete dependent refusals,
//! cascade set in one write), and the sources-untouched invariant. Mirrored
//! by the TS twin's test/views.test.mjs (PARITY).

mod common;

use lighthouse_core::views::{self, SummarySource, ViewSummary};

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn summary(text: &str) -> ViewSummary {
    ViewSummary {
        text: text.to_string(),
        source: SummarySource::Question,
    }
}

/// Paths of `views.json.bak-<epochms>` siblings in the state dir.
fn bak_files(state: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(state)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("views.json.bak-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A vault with one included sales.csv, ready for view creation.
fn seed_sales(vault: &std::path::Path) {
    write(
        &vault.join("sales.csv"),
        "region,amount\nnorth,3\nsouth,7\n",
    );
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("sales.csv", true);
}

#[test]
fn round_trips_byte_stable_with_derived_reads() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // Create from a Beam answer's meta: display name sanitizes, the file
    // dependency is derived from the SQL with its name binding pinned.
    let created = views::create(
        "Top Regions",
        "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
        summary("which regions sell most"),
        &["sales.csv".to_string()],
    )
    .expect("creates");
    assert!(created.id.starts_with("view-"), "{}", created.id);
    assert_eq!(created.name, "top_regions", "name sanitized at save");
    assert_eq!(created.reads.files.len(), 1);
    assert_eq!(created.reads.files[0].file_id, "sales.csv");
    assert_eq!(created.reads.files[0].table_name, "sales");
    assert!(created.reads.views.is_empty());
    assert_eq!(created.summary.text, "which regions sell most");
    assert_eq!(created.summary.source, SummarySource::Question);
    assert!(created.created_ms > 0);

    // Re-read from disk: the identical record returns.
    let listed = views::list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0], created, "round trip preserves the record exactly");

    // A view over the view: the reference resolves by name to the saved id.
    let over = views::create(
        "north only",
        "SELECT * FROM top_regions WHERE region = 'north'",
        summary("just the north"),
        &[],
    )
    .expect("creates view-over-view");
    assert!(over.reads.files.is_empty());
    assert_eq!(over.reads.views, vec![created.id.clone()]);

    // The on-disk envelope is the byte contract with the TS twin: v1, then
    // the records, camelCase keys in declaration order, 2-space pretty,
    // the summary source as a bare lowercase string.
    let raw = std::fs::read_to_string(vault.path().join(".rag-vault/views.json")).unwrap();
    assert!(raw.starts_with("{\n  \"v\": 1,\n  \"views\": ["), "{raw}");
    for pair in [
        ("\"id\"", "\"name\""),
        ("\"name\"", "\"sql\""),
        ("\"sql\"", "\"reads\""),
        ("\"reads\"", "\"summary\""),
        ("\"summary\"", "\"createdMs\""),
        ("\"fileId\"", "\"tableName\""),
        ("\"text\"", "\"source\""),
    ] {
        let (a, b) = (raw.find(pair.0), raw.find(pair.1));
        assert!(a.is_some() && a < b, "{} must precede {}", pair.0, pair.1);
    }
    // Within reads: files precede views (the envelope's own "views" key is
    // first in the file, so compare against the LAST "views" occurrence).
    assert!(raw.find("\"files\"").unwrap() < raw.rfind("\"views\"").unwrap());
    assert!(raw.contains("\"source\": \"question\""), "{raw}");
    assert!(raw.contains(&format!("\"views\": [\n          \"{}\"\n        ]", created.id)), "{raw}");
}

#[test]
fn unknown_version_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    let newer = r#"{"v":99,"views":[{"id":"view-from-the-future"}]}"#;
    std::fs::write(state.join("views.json"), newer).unwrap();

    // Session reads empty — never a crash, never a partial parse.
    assert!(views::list().is_empty(), "v99 loads empty");

    // The first write preserves the unreadable file, then writes fresh v1.
    views::create("fresh", "SELECT 1", summary("q"), &[]).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "exactly one bak: {baks:?}");
    assert_eq!(
        std::fs::read_to_string(&baks[0]).unwrap(),
        newer,
        "newer data recoverable byte-for-byte"
    );
    let raw = std::fs::read_to_string(state.join("views.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["v"], 1);
    assert_eq!(parsed["views"][0]["name"], "fresh");
    assert_eq!(views::list().len(), 1);
}

#[test]
fn corrupt_json_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("views.json"), "{ not json").unwrap();

    assert!(views::list().is_empty(), "corrupt loads empty");
    views::create("after", "SELECT 1", summary("q"), &[]).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "corrupt file preserved: {baks:?}");
    assert_eq!(std::fs::read_to_string(&baks[0]).unwrap(), "{ not json");
    assert_eq!(views::list().len(), 1);
}

/// The guard runs at save: anything that is not a single read-only SELECT is
/// refused with the guard's reason and NOTHING persists.
#[test]
fn guard_refuses_non_select_definitions_at_save() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    let err = views::create(
        "mutation",
        "UPDATE sales SET amount = 0",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .unwrap_err();
    assert_eq!(err, "only SELECT queries are allowed");

    let err = views::create(
        "two",
        "SELECT 1; SELECT 2",
        summary("q"),
        &[],
    )
    .unwrap_err();
    assert_eq!(err, "expected exactly one SQL statement");

    let err = views::create("broken", "not sql at all", summary("q"), &[]).unwrap_err();
    assert!(err.starts_with("SQL parse error"), "{err}");

    assert!(views::list().is_empty(), "refusals persist nothing");
    assert!(
        !vault.path().join(".rag-vault/views.json").exists(),
        "no store file was ever written"
    );
}

#[test]
fn name_rules_reject_reserved_collisions_and_empty() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // Reserved keywords, checked AFTER normalization ("  SELECT " → select).
    for reserved in ["select", "  SELECT ", "table", "With"] {
        let err = views::create(reserved, "SELECT 1", summary("q"), &[]).unwrap_err();
        assert!(err.ends_with("is a reserved word"), "{reserved:?}: {err}");
    }
    // Unusable (empty after sanitization) names.
    for empty in ["", "   ", "!!!"] {
        assert_eq!(
            views::create(empty, "SELECT 1", summary("q"), &[]).unwrap_err(),
            "a view needs a name",
            "{empty:?}"
        );
    }

    // Case-insensitive collision with an existing view, sanitize-aware:
    // "top  SALES!" normalizes to the same identifier as "Top Sales".
    views::create("Top Sales", "SELECT 1", summary("q"), &[]).expect("creates");
    for taken in ["top_sales", "Top Sales", "top  SALES!"] {
        assert_eq!(
            views::create(taken, "SELECT 1", summary("q"), &[]).unwrap_err(),
            "a view named \"top_sales\" already exists",
            "{taken:?}"
        );
    }

    // Collision with a CURRENT catalog file table name (sales.csv → sales),
    // fetched by create's public entry from the vault.
    assert_eq!(
        views::create("sales", "SELECT 1", summary("q"), &[]).unwrap_err(),
        "a table named \"sales\" already exists in your files"
    );
    // …and via the parameterized core with caller-supplied taken names.
    assert_eq!(
        views::create_with_tables("Q3 Report", "SELECT 1", summary("q"), &[], &[
            "q3_report".to_string()
        ])
        .unwrap_err(),
        "a table named \"q3_report\" already exists in your files"
    );

    assert_eq!(views::list().len(), 1, "only the one valid create persisted");
}

#[test]
fn unknown_table_references_are_refused() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // A name that is neither a saved view nor derivable from the passed
    // file ids refuses the save, naming the offender.
    let err = views::create(
        "mystery",
        "SELECT * FROM sales JOIN nowhere ON true",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .unwrap_err();
    assert_eq!(err, "unknown table in definition: nowhere");

    // The same SQL with NO file ids can't even resolve sales.
    let err = views::create("mystery", "SELECT * FROM sales", summary("q"), &[]).unwrap_err();
    assert_eq!(err, "unknown table in definition: sales");
    assert!(views::list().is_empty());
}

/// Same-stem files replay register_tables' collision suffixing in file_ids
/// order, so stored bindings match what the naming pipeline would assign.
#[test]
fn file_table_names_replay_the_registration_pipeline() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("a/report.csv"), "x\n1\n");
    write(&vault.path().join("b/report.csv"), "x\n2\n");
    lighthouse_core::vault::invalidate_walk_cache();

    let created = views::create(
        "both reports",
        "SELECT * FROM report UNION ALL SELECT * FROM report_2",
        summary("q"),
        &["a/report.csv".to_string(), "b/report.csv".to_string()],
    )
    .expect("creates");
    let bindings: Vec<(String, String)> = created
        .reads
        .files
        .iter()
        .map(|f| (f.file_id.clone(), f.table_name.clone()))
        .collect();
    assert_eq!(
        bindings,
        vec![
            ("a/report.csv".to_string(), "report".to_string()),
            ("b/report.csv".to_string(), "report_2".to_string()),
        ],
        "suffix-on-collision in file_ids order"
    );
}

#[test]
fn depth_beyond_the_cap_is_refused_at_save() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    views::create("lvl1", "SELECT * FROM sales", summary("q"), &["sales.csv".to_string()])
        .expect("depth 1");
    views::create("lvl2", "SELECT * FROM lvl1", summary("q"), &[]).expect("depth 2");
    views::create("lvl3", "SELECT * FROM lvl2", summary("q"), &[]).expect("depth 3 = the cap");
    let err = views::create("lvl4", "SELECT * FROM lvl3", summary("q"), &[]).unwrap_err();
    assert_eq!(err, "view depth is capped at 3");
    assert_eq!(views::list().len(), 3, "the refused layer never persisted");

    // Referencing a SHALLOW view stays fine after the refusal.
    views::create("side", "SELECT * FROM lvl1", summary("q"), &[]).expect("depth 2 again");
}

/// The cycle guard is defense in depth: create can't form a cycle (it only
/// references existing views and nothing redefines edges), so the refusal is
/// exercised against a hand-crafted store whose manual edge closes a loop.
#[test]
fn crafted_cycle_is_refused_at_save() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    // a reads b, b reads a — a cycle no create sequence can produce.
    let crafted = serde_json::json!({
        "v": 1,
        "views": [
            {"id": "view-aaa", "name": "alpha", "sql": "SELECT * FROM beta",
             "reads": {"files": [], "views": ["view-bbb"]},
             "summary": {"text": "q", "source": "question"}, "createdMs": 1},
            {"id": "view-bbb", "name": "beta", "sql": "SELECT * FROM alpha",
             "reads": {"files": [], "views": ["view-aaa"]},
             "summary": {"text": "q", "source": "question"}, "createdMs": 2},
        ]
    });
    std::fs::write(
        state.join("views.json"),
        serde_json::to_string_pretty(&crafted).unwrap(),
    )
    .unwrap();

    let before = std::fs::read_to_string(state.join("views.json")).unwrap();
    let err = views::create("closer", "SELECT * FROM alpha", summary("q"), &[]).unwrap_err();
    assert_eq!(err, "that definition would create a cycle");
    assert_eq!(
        std::fs::read_to_string(state.join("views.json")).unwrap(),
        before,
        "the store is unchanged by the refusal"
    );
}

#[test]
fn rename_refuses_with_dependents_and_otherwise_updates_in_place() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    let base = views::create("base", "SELECT * FROM sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    let mid = views::create("mid", "SELECT * FROM base", summary("q"), &[]).expect("creates");
    views::create("top_v", "SELECT * FROM mid", summary("q"), &[]).expect("creates");

    // Refused while ANY other view reads it — the message names the DIRECT
    // dependents (the definitions whose SQL uses this name).
    let err = views::rename(&base.id, "renamed").unwrap_err();
    assert_eq!(err, "\"base\" can't be renamed while other views read it: mid");
    assert_eq!(views::list()[0].name, "base", "refusal changed nothing");

    // Helpers the refusals and the UI lean on.
    let direct: Vec<String> = views::dependents_of(&base.id).iter().map(|d| d.name.clone()).collect();
    assert_eq!(direct, vec!["mid"]);
    let transitive: Vec<String> = views::transitive_dependents(&base.id)
        .iter()
        .map(|d| d.name.clone())
        .collect();
    assert_eq!(transitive, vec!["mid", "top_v"]);

    // A leaf renames freely: sanitized, id stable, reads untouched
    // everywhere (the dependent edge is by ID, and mid still reads base).
    let renamed = views::rename(&views::list()[2].id, "The Peak").expect("renames");
    assert_eq!(renamed.name, "the_peak");
    assert_eq!(renamed.id, views::list()[2].id, "rename keeps the id");
    assert_eq!(renamed.reads.views, vec![mid.id.clone()], "reads untouched");
    assert_eq!(views::list()[1].reads.views, vec![base.id.clone()]);

    // The new name passes the create rules.
    let peak_id = renamed.id.clone();
    assert_eq!(
        views::rename(&peak_id, "select").unwrap_err(),
        "\"select\" is a reserved word"
    );
    assert_eq!(
        views::rename(&peak_id, "MID").unwrap_err(),
        "a view named \"mid\" already exists"
    );
    assert_eq!(
        views::rename(&peak_id, "sales").unwrap_err(),
        "a table named \"sales\" already exists in your files"
    );
    assert_eq!(views::rename(&peak_id, "  ").unwrap_err(), "a view needs a name");
    assert_eq!(views::rename("view-nope", "x").unwrap_err(), "view not found");
}

#[test]
fn delete_refuses_with_the_transitive_list_and_cascades_in_one_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    let base = views::create("base", "SELECT * FROM sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    let mid = views::create("mid", "SELECT * FROM base", summary("q"), &[]).expect("creates");
    let top = views::create("top_v", "SELECT * FROM mid", summary("q"), &[]).expect("creates");
    let other = views::create("other", "SELECT * FROM sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");

    // Refused by default, naming the FULL transitive list (what the UI's
    // cascade confirmation must show), creation order.
    let err = views::delete(&base.id, false).unwrap_err();
    assert_eq!(
        err,
        "\"base\" can't be deleted while other views read it: mid, top_v"
    );
    assert_eq!(views::list().len(), 4, "refusal deleted nothing");

    // Cascade removes the view plus EXACTLY its transitive dependents in
    // one write; unrelated views survive.
    let deleted = views::delete(&base.id, true).expect("cascades");
    assert_eq!(deleted, vec![base.id.clone(), mid.id.clone(), top.id.clone()]);
    let left = views::list();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, other.id);

    // A leaf deletes without cascade; unknown ids refuse.
    assert_eq!(views::delete(&other.id, false).expect("deletes"), vec![other.id.clone()]);
    assert!(views::list().is_empty());
    assert_eq!(views::delete(&other.id, false).unwrap_err(), "view not found");
    assert_eq!(views::delete("view-nope", true).unwrap_err(), "view not found");
}

/// Saving, renaming, and deleting views never writes to any source file —
/// the fixture's bytes are identical after every operation.
#[test]
fn source_files_are_never_touched_by_any_op() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let csv = vault.path().join("sales.csv");
    write(&csv, "region,amount\nnorth,3\nsouth,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("sales.csv", true);
    let before = std::fs::read(&csv).unwrap();

    let base = views::create(
        "shaped",
        "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .expect("creates");
    views::create("over", "SELECT * FROM shaped", summary("q"), &[]).expect("creates");
    views::rename(&views::list()[1].id, "renamed_over").expect("renames");
    let _ = views::create("select", "SELECT 1", summary("q"), &[]).unwrap_err(); // a refusal too
    views::delete(&base.id, true).expect("cascades");

    assert_eq!(
        std::fs::read(&csv).unwrap(),
        before,
        "source bytes identical after create/rename/refusal/cascade-delete"
    );
    assert!(views::list().is_empty());
}

// --- §2: virtual resolution at ask time (openspec: add-shaped-views) ----------------

use lighthouse_core::analytics::{register_tables, register_views, run_query, TableReg};

/// (file_id, display name, abs) triple for `register_tables`, with the id
/// doubling as the vault-relative name — the tests' usual shape.
fn entry(vault: &std::path::Path, id: &str) -> (String, String, std::path::PathBuf) {
    let name = id.rsplit('/').next().unwrap_or(id).to_string();
    (id.to_string(), name, vault.join(id))
}

/// A hand-crafted registration for slot/posture tests — `register_views`
/// reads only the table name, file id, and group coverage from a reg.
fn fake_reg(table: &str, file_id: &str) -> TableReg {
    TableReg {
        table: table.to_string(),
        file_id: file_id.to_string(),
        file_name: file_id.to_string(),
        card: String::new(),
        modified_ms: None,
        columns: vec![],
        group: None,
        capped_rows: None,
    }
}

/// Task 2.4 scenario 1: an ask THROUGH a view returns the shaped number via
/// real DataFusion — messy text amounts a raw SUM could never add.
#[tokio::test]
async fn ask_against_a_view_returns_shaped_numbers() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(
        &vault.path().join("messy.csv"),
        "region,amount\nnorth,$3\nsouth,$7\n",
    );

    views::create_with_tables(
        "clean_sales",
        "SELECT region, CAST(REPLACE(amount, '$', '') AS DOUBLE) AS amount FROM messy",
        summary("clean the amounts"),
        &[("messy.csv".to_string(), "messy.csv".to_string())],
        &[],
    )
    .expect("saves");

    let ctx = datafusion::prelude::SessionContext::new();
    let regs = register_tables(&ctx, &[entry(vault.path(), "messy.csv")], false).await;
    assert_eq!(regs.len(), 1, "the source registers as a table");
    let view_regs = register_views(&ctx, &regs, false).await;
    assert_eq!(view_regs.len(), 1, "the view registers virtually");

    // The card leads with the view marker + summary, then the standard body,
    // and the provenance fields point at the transitive source.
    let vr = &view_regs[0];
    assert_eq!(vr.name, "clean_sales");
    assert!(
        vr.card
            .starts_with("clean_sales is a saved view — clean the amounts\n"),
        "{}",
        vr.card
    );
    assert!(vr.card.contains("table clean_sales — 2 rows"), "{}", vr.card);
    assert_eq!(vr.columns, vec!["region", "amount"]);
    assert_eq!(vr.source_file_ids, vec!["messy.csv"]);
    assert_eq!(vr.source_tables, vec!["messy"]);
    assert_eq!(vr.summary, "clean the amounts");

    // The engine computes the shaped number from the view.
    let res = run_query(
        &ctx,
        "SELECT CAST(SUM(amount) AS BIGINT) AS total FROM clean_sales",
    )
    .await
    .expect("query runs");
    assert!(res.markdown.contains("| 10 |"), "{}", res.markdown);
}

/// Task 2.4 scenario 2: a source edit flows straight through the view (no
/// rows were ever materialized — the state dir holds ONLY views.json).
#[tokio::test]
async fn source_edits_flow_through_with_no_rows_on_disk() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(
        &vault.path().join("messy.csv"),
        "region,amount\nnorth,$3\nsouth,$7\n",
    );
    views::create_with_tables(
        "clean_sales",
        "SELECT CAST(REPLACE(amount, '$', '') AS DOUBLE) AS amount FROM messy",
        summary("q"),
        &[("messy.csv".to_string(), "messy.csv".to_string())],
        &[],
    )
    .expect("saves");

    let ask = |vault: std::path::PathBuf| async move {
        let ctx = datafusion::prelude::SessionContext::new();
        let regs = register_tables(&ctx, &[entry(&vault, "messy.csv")], false).await;
        let view_regs = register_views(&ctx, &regs, false).await;
        assert_eq!(view_regs.len(), 1);
        run_query(
            &ctx,
            "SELECT CAST(SUM(amount) AS BIGINT) AS total FROM clean_sales",
        )
        .await
        .expect("query runs")
        .markdown
    };

    let first = ask(vault.path().to_path_buf()).await;
    assert!(first.contains("| 10 |"), "{first}");

    // Overwrite the source; a FRESH ctx + re-registration sees the new bytes.
    write(
        &vault.path().join("messy.csv"),
        "region,amount\nnorth,$4\nsouth,$8\n",
    );
    let second = ask(vault.path().to_path_buf()).await;
    assert!(second.contains("| 12 |"), "{second}");

    // No materialized rows anywhere: the views feature put exactly ONE file
    // in the state dir — views.json (the definition). The only other entry is
    // the pre-existing extract/catalog `cache` directory, which registration
    // creates with or without views.
    let mut names: Vec<String> = std::fs::read_dir(vault.path().join(".rag-vault"))
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    assert_eq!(names, vec!["cache", "views.json"], "no materialized rows on disk");
}

/// Task 2.4 scenario 3: views share the file tables' slot cap — a full ctx
/// registers none, one free slot registers exactly the FIRST saved view.
#[tokio::test]
async fn views_share_the_table_slot_cap_deterministically() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("data.csv"), "x\n1\n2\n");
    views::create_with_tables(
        "v_first",
        "SELECT * FROM data",
        summary("q"),
        &[("data.csv".to_string(), "data.csv".to_string())],
        &[],
    )
    .expect("saves");
    views::create_with_tables(
        "v_second",
        "SELECT COUNT(*) AS n FROM data",
        summary("q"),
        &[("data.csv".to_string(), "data.csv".to_string())],
        &[],
    )
    .expect("saves");

    // MAX_TABLES_TOTAL is 6 (analytics.rs) — craft a full registration: the
    // real source table plus five fillers leaves no view slot.
    let ctx = datafusion::prelude::SessionContext::new();
    let regs = register_tables(&ctx, &[entry(vault.path(), "data.csv")], false).await;
    assert_eq!(regs.len(), 1);
    let mut full = regs.clone();
    for i in 0..5 {
        full.push(fake_reg(&format!("filler_{i}"), &format!("filler_{i}.csv")));
    }
    assert!(register_views(&ctx, &full, false).await.is_empty(), "no slots ⇒ no views");

    // One free slot: exactly the first (creation-order) view registers.
    let one_slot = &full[..5];
    let view_regs = register_views(&ctx, one_slot, false).await;
    assert_eq!(view_regs.len(), 1);
    assert_eq!(view_regs[0].name, "v_first", "creation order decides");
}

/// Requirement 6 + task 2.4 scenario 4: a local-only mark propagates to the
/// view transitively — visible locally, excluded from every cloud surface.
#[tokio::test]
async fn local_only_views_are_ineligible_on_cloud_asks() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("private.csv"), "region,amount\nNE,5\n");
    lighthouse_core::vault::set_local_only("private.csv", true);

    let base = views::create_with_tables(
        "private_view",
        "SELECT * FROM private",
        summary("q"),
        &[("private.csv".to_string(), "private.csv".to_string())],
        &[],
    )
    .expect("saves");
    // A view OVER the marked view inherits the mark transitively.
    let over = views::create_with_tables(
        "over_private",
        "SELECT COUNT(*) AS n FROM private_view",
        summary("q"),
        &[],
        &[],
    )
    .expect("saves");

    let records = views::list();
    assert!(views::view_effectively_local_only(&base, &records));
    assert!(
        views::view_effectively_local_only(&over, &records),
        "the mark rides through the parent view"
    );

    // Posture: local sees both; cloud sees neither.
    let local: Vec<String> = views::eligible_for_posture(false).iter().map(|v| v.name.clone()).collect();
    assert_eq!(local, vec!["private_view", "over_private"]);
    assert!(views::eligible_for_posture(true).is_empty());

    // register_views honors the posture even when the file itself is
    // registered (the crafted-regs belt-and-suspenders path).
    let ctx = datafusion::prelude::SessionContext::new();
    let regs = register_tables(&ctx, &[entry(vault.path(), "private.csv")], false).await;
    assert_eq!(regs.len(), 1);
    assert!(
        register_views(&ctx, &regs, true).await.is_empty(),
        "cloud ask never registers a local-only view"
    );
    let local_regs = register_views(&ctx, &regs, false).await;
    assert_eq!(local_regs.len(), 2, "a local ask may use both normally");
}

/// Requirement 2 (cache posture, design.md "Answer cache"): the view registry
/// re-keys exactly the asks it could apply to — a local-only view changes the
/// LOCAL key and leaves the CLOUD key untouched.
#[test]
fn cache_keys_fold_the_view_registry_by_posture() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("sales.csv"), "region,amount\nnorth,3\n");
    write(&vault.path().join("private.csv"), "region,amount\nNE,5\n");
    lighthouse_core::vault::set_included("sales.csv", true);
    lighthouse_core::vault::set_included("private.csv", true);
    lighthouse_core::vault::set_local_only("private.csv", true);

    let q = "what were sales";
    let local = || lighthouse_core::answer_cache::cache_key(q, Some("local"), None, &[], &[], false);
    let cloud =
        || lighthouse_core::answer_cache::cache_key(q, Some("openai"), Some("gpt-5-mini"), &[], &[], true);
    let (local0, cloud0) = (local(), cloud());

    // A view over the MARKED file: eligible locally only ⇒ only the local
    // key moves.
    views::create(
        "private_view",
        "SELECT * FROM private",
        summary("q"),
        &["private.csv".to_string()],
    )
    .expect("saves");
    let (local1, cloud1) = (local(), cloud());
    assert_ne!(local1, local0, "a local-only view re-keys the local ask");
    assert_eq!(cloud1, cloud0, "…and never the cloud ask");

    // A view over the unmarked file re-keys both postures.
    views::create(
        "sales_view",
        "SELECT * FROM sales",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .expect("saves");
    assert_ne!(local(), local1);
    assert_ne!(cloud(), cloud1, "an eligible view re-keys the cloud ask");
}

/// Task 2.4 scenario 6: view-over-view registers when the whole chain's
/// sources are in play; only the base registers when the child's extra
/// source is missing.
#[tokio::test]
async fn view_over_view_registers_and_degrades_by_coverage() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("base.csv"), "region,amount\nnorth,$3\nsouth,$7\n");
    write(&vault.path().join("extra.csv"), "region,factor\nnorth,2\nsouth,3\n");

    views::create_with_tables(
        "view_a",
        "SELECT region, CAST(REPLACE(amount, '$', '') AS DOUBLE) AS amount FROM base",
        summary("clean"),
        &[("base.csv".to_string(), "base.csv".to_string())],
        &[],
    )
    .expect("saves A");
    views::create_with_tables(
        "view_b",
        "SELECT a.region, a.amount * e.factor AS scaled FROM view_a a JOIN extra e ON a.region = e.region",
        summary("scaled"),
        &[("extra.csv".to_string(), "extra.csv".to_string())],
        &[],
    )
    .expect("saves B");

    // Both sources in play: A and B register; B answers through the stack.
    let ctx = datafusion::prelude::SessionContext::new();
    let files = vec![entry(vault.path(), "base.csv"), entry(vault.path(), "extra.csv")];
    let regs = register_tables(&ctx, &files, false).await;
    assert_eq!(regs.len(), 2);
    let view_regs = register_views(&ctx, &regs, false).await;
    let names: Vec<&str> = view_regs.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, vec!["view_a", "view_b"], "store order, both eligible");
    // B's provenance is TRANSITIVE: its own file plus A's, reads order.
    assert_eq!(view_regs[1].source_file_ids, vec!["extra.csv", "base.csv"]);
    assert_eq!(view_regs[1].source_tables, vec!["extra", "base"]);
    let res = run_query(
        &ctx,
        "SELECT CAST(SUM(scaled) AS BIGINT) AS total FROM view_b",
    )
    .await
    .expect("query runs");
    assert!(res.markdown.contains("| 27 |"), "{}", res.markdown);

    // Only the base source in play: A registers alone — B's extra source is
    // missing, so B drops out without failing anything.
    let ctx2 = datafusion::prelude::SessionContext::new();
    let regs2 = register_tables(&ctx2, &[entry(vault.path(), "base.csv")], false).await;
    let view_regs2 = register_views(&ctx2, &regs2, false).await;
    let names2: Vec<&str> = view_regs2.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names2, vec!["view_a"], "A alone when B's source is missing");
}

/// Design "Name bindings": ambient naming differences alias the SAME provider
/// under the stored name; a registered table always wins the view's own name.
#[tokio::test]
async fn stored_name_bindings_alias_and_files_win_collisions() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("x/report.csv"), "region,amount\nnorth,1\n");
    write(&vault.path().join("y/report.csv"), "region,amount\nsouth,5\n");

    // Saved when BOTH same-named files were in play: the definition's SQL
    // references only the second binding, pinned as report_2.
    views::create_with_tables(
        "second_only",
        "SELECT * FROM report_2",
        summary("q"),
        &[
            ("x/report.csv".to_string(), "report.csv".to_string()),
            ("y/report.csv".to_string(), "report.csv".to_string()),
        ],
        &[],
    )
    .expect("saves");
    // A view whose name an ask-time table will shadow (legal at save — no
    // such file table existed then).
    views::create_with_tables("shadowed", "SELECT 1 AS one", summary("q"), &[], &[])
        .expect("saves");

    // At ask time only y/report.csv is in play, registered ambient as
    // plain `report` — the stored binding re-binds via an alias.
    let ctx = datafusion::prelude::SessionContext::new();
    let regs = register_tables(&ctx, &[entry(vault.path(), "y/report.csv")], false).await;
    assert_eq!(regs.len(), 1);
    assert_eq!(regs[0].table, "report");
    // Craft an ambient collision for the second view's own name — a REAL
    // registered table plus its reg: files win, the view skips.
    let shadow_df = ctx.sql("SELECT 1 AS one").await.expect("plans");
    ctx.register_table("shadowed", shadow_df.into_view()).expect("registers");
    let mut with_shadow = regs.clone();
    with_shadow.push(fake_reg("shadowed", "shadow.csv"));
    let view_regs = register_views(&ctx, &with_shadow, false).await;
    let names: Vec<&str> = view_regs.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, vec!["second_only"], "alias registers; shadowed name skips");
    let res = run_query(&ctx, "SELECT CAST(SUM(amount) AS BIGINT) AS t FROM second_only")
        .await
        .expect("query runs");
    assert!(res.markdown.contains("| 5 |"), "aliased to y's rows: {}", res.markdown);
}

// --- §3: the shaping ask (openspec: add-shaped-views) --------------------------------
//
// `shape_view` itself is async + model-dependent, so these tests drive its
// PURE pieces — the prompt assembly, the reply parser, the local-only seam,
// the extractive refusal — plus the before/after sampling helper against a
// real registered ctx: everything but the one network completion.

/// The chart-directive precedent: every few-shot SELECT must pass the
/// engine's own validator, and survive the fence extraction a real reply
/// goes through — a prompt edit can't ship an example the guard would refuse.
#[test]
fn shape_fewshots_pass_the_guard_and_extraction() {
    use lighthouse_core::analytics::{extract_sql, guard_sql};
    assert_eq!(views::SHAPE_FEWSHOTS.len(), 2, "the two messy→clean shapes");
    for (instruction, sql, summary) in views::SHAPE_FEWSHOTS {
        guard_sql(sql).unwrap_or_else(|e| panic!("few-shot for {instruction:?} rejected: {e}"));
        let fenced = format!("```sql\n{sql}\n```");
        assert_eq!(extract_sql(&fenced).as_deref(), Some(*sql), "{instruction}");
        assert!(!summary.trim().is_empty(), "every example models a Summary");
    }
    // All of them ride the few-shot context block, in the pinned shape.
    let block = views::shape_fewshot_block();
    assert!(block.starts_with("Instruction: "), "{block}");
    for (instruction, sql, summary) in views::SHAPE_FEWSHOTS {
        assert!(block.contains(&format!("Instruction: {instruction}")), "{block}");
        assert!(block.contains(&format!("SQL: {sql}")), "{block}");
        assert!(block.contains(&format!("Summary: {summary}")), "{block}");
    }
}

/// The prompt template is a PINNED snapshot: the reply contract (one fenced
/// SELECT + one Summary line) and the read-only framing are load-bearing for
/// the parser, so a wording drift must be a conscious edit here.
#[test]
fn shape_question_is_a_pinned_snapshot() {
    let expected = "You are shaping the table \"messy\" into a clean, reusable view with \
ONE SQL query (DataFusion, PostgreSQL-style syntax). The first context block \
describes messy: its exact table name, columns with types, row count, and a \
few sample rows; the second holds examples with a GENERIC schema — adapt \
their idea to messy's real columns.\n\
Write a single SELECT statement over messy that applies the instruction \
below. Reply with ONLY:\n\
1. the SQL in a ```sql code block\n\
2. one line starting with \"Summary:\" — a plain-words description of the \
shaped result\n\
Use the exact table and column names as given. Read only — never write, and \
never invent tables.\n\n\
Instruction: cast amount to a number";
    assert_eq!(
        views::shape_question("messy", "cast amount to a number"),
        expected
    );
}

#[test]
fn parse_shape_reply_recovers_sql_and_summary_or_refuses() {
    // The contract shape: fenced SELECT + a Summary line.
    let reply = "Here is the transform.\n```sql\nSELECT * FROM messy WHERE amount IS NOT NULL\n```\nSummary: messy without blank amounts\n";
    assert_eq!(
        views::parse_shape_reply(reply).expect("parses"),
        (
            "SELECT * FROM messy WHERE amount IS NOT NULL".to_string(),
            "messy without blank amounts".to_string()
        )
    );
    // A bare SELECT with no Summary line still parses — summary is "" (the
    // record stores an empty model-labeled summary; the card shows nothing).
    assert_eq!(
        views::parse_shape_reply("SELECT a FROM t").expect("parses"),
        ("SELECT a FROM t".to_string(), String::new())
    );
    // A refusal (no SELECT anywhere) errs with the model's own words —
    // that raw reason is what the dialog shows.
    let refusal = "I can't shape that: the instruction asks for a column that does not exist.";
    assert_eq!(views::parse_shape_reply(refusal).unwrap_err(), refusal);
    // …bounded, so a rambling reply can't flood the dialog.
    let long = "no ".repeat(400);
    assert_eq!(views::parse_shape_reply(&long).unwrap_err().chars().count(), 400);
    // An empty reply gets honest fallback copy instead of an empty error.
    assert_eq!(
        views::parse_shape_reply("  ").unwrap_err(),
        "the model returned no SQL"
    );
    // Extraction recovers a SELECT but the guard refuses it: a smuggled
    // second statement fails the SAME single-read-only-SELECT check every
    // executed query passes.
    let multi = "```sql\nSELECT 1; DROP TABLE t\n```";
    assert_eq!(
        views::parse_shape_reply(multi).unwrap_err(),
        "expected exactly one SQL statement"
    );
}

/// The evidence helper renders engine-computed before/after samples — first
/// SAMPLE_ROWS of the source and of the proposed SELECT — via the guarded
/// `run_query` path, against a real registered ctx and NO model. Any
/// execution failure is an Err the dialog shows; nothing persists anywhere.
#[tokio::test]
async fn shape_samples_render_before_and_after_against_a_real_csv() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    // Four rows so the 3-row sample cap is observable.
    write(
        &vault.path().join("messy.csv"),
        "region,amount\nnorth,$3\nsouth,$7\neast,$11\nwest,$2\n",
    );
    let source_bytes = std::fs::read(vault.path().join("messy.csv")).unwrap();
    let ctx = datafusion::prelude::SessionContext::new();
    let regs = register_tables(&ctx, &[entry(vault.path(), "messy.csv")], false).await;
    assert_eq!(regs.len(), 1);

    // A canned model reply (with a stray citation marker the real path
    // strips) drives the SAME parse → guard → sample pieces shape_view runs.
    let reply = "Sure [1].\n```sql\nSELECT region, CAST(REPLACE(REPLACE(amount, '$', ''), ',', '') AS DOUBLE) AS amount FROM messy\n```\nSummary: messy with amount as a real number\n";
    let (sql, summary) =
        views::parse_shape_reply(&lighthouse_core::synth::strip_markers(reply)).expect("parses");
    assert_eq!(summary, "messy with amount as a real number");

    let (before, after) = views::shape_samples(&ctx, "messy", &sql)
        .await
        .expect("samples render");
    // Row counts: header + separator + exactly 3 sample rows on each side.
    let rows = |md: &str| md.lines().count().saturating_sub(2);
    assert_eq!(rows(&before), 3, "before caps at SAMPLE_ROWS: {before}");
    assert_eq!(rows(&after), 3, "after caps at SAMPLE_ROWS: {after}");
    // Before shows the messy text; after shows engine-cast numbers.
    assert!(before.contains("$3"), "{before}");
    assert!(after.contains("3.0"), "{after}");
    assert!(!after.contains('$'), "{after}");

    // A proposal that can't execute (unknown column) errs with the engine's
    // reason — the dialog shows it and nothing was persisted.
    assert!(views::shape_samples(&ctx, "messy", "SELECT nope FROM messy")
        .await
        .is_err());
    assert!(views::list().is_empty(), "sampling persists nothing");
    // Requirement 4: the source file's bytes are identical afterward — the
    // whole evidence flow never opens a file for write.
    assert_eq!(
        std::fs::read(vault.path().join("messy.csv")).unwrap(),
        source_bytes,
        "source bytes identical after shaping evidence"
    );
}

/// The H1 local-only seam: a marked source file — or a saved view that is
/// transitively local-only — forces the local model path (the cfg swap
/// `shape_view` applies before any transport exists).
#[test]
fn shape_is_local_only_forces_the_local_seam() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("private.csv"), "region,amount\nNE,5\n");
    write(&vault.path().join("open.csv"), "region,amount\nNW,3\n");
    lighthouse_core::vault::set_local_only("private.csv", true);

    // A marked file id forces local regardless of the source name.
    assert!(views::shape_is_local_only(
        "anything",
        &["private.csv".to_string(), "open.csv".to_string()]
    ));
    assert!(!views::shape_is_local_only("anything", &["open.csv".to_string()]));

    // A source naming a view over the marked file forces local transitively.
    views::create_with_tables(
        "private_view",
        "SELECT * FROM private",
        summary("q"),
        &[("private.csv".to_string(), "private.csv".to_string())],
        &[],
    )
    .expect("saves");
    assert!(views::shape_is_local_only("private_view", &[]));
    assert!(views::shape_is_local_only("  PRIVATE_VIEW  ", &[]), "trimmed, case-insensitive");
    assert!(!views::shape_is_local_only("some_other_view", &[]));
}

/// An extractive/keyless provider can't shape: the EXACT stable string the
/// dispatch arms match to answer `{available:false}` — and the refusal fires
/// before any registration or completion work.
#[tokio::test]
async fn shape_view_refuses_extractive_and_keyless_cfgs_with_stable_copy() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    assert_eq!(
        views::SHAPE_NEEDS_MODEL,
        "shaping needs a model; the current provider answers extractively"
    );
    // No provider at all (the extractive fallback).
    let err = views::shape_view("t", "clean it", &[], lighthouse_core::llm::ModelCfg::default())
        .await
        .unwrap_err();
    assert_eq!(err, views::SHAPE_NEEDS_MODEL);
    // A selected-but-keyless remote is extractive too.
    let keyless = lighthouse_core::llm::ModelCfg {
        provider_id: Some("openai".to_string()),
        model_id: Some("gpt-5-mini".to_string()),
        api_key: None,
    };
    let err = views::shape_view("t", "clean it", &[], keyless).await.unwrap_err();
    assert_eq!(err, views::SHAPE_NEEDS_MODEL);
    // Blank inputs refuse before anything else.
    let local = lighthouse_core::profile::local_model_config();
    assert_eq!(
        views::shape_view(" ", "x", &[], local.clone()).await.unwrap_err(),
        "a source table or view is required"
    );
    assert_eq!(
        views::shape_view("t", "  ", &[], local).await.unwrap_err(),
        "an instruction is required"
    );
}

/// A source that names no registered table or view refuses with clear copy —
/// resolution happens BEFORE the completion, so no model is consulted.
#[tokio::test]
async fn shape_view_refuses_an_unknown_source_before_any_completion() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());
    let err = views::shape_view(
        "nowhere",
        "clean it",
        &["sales.csv".to_string()],
        lighthouse_core::profile::local_model_config(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err,
        "\"nowhere\" is not available to shape — pick a table or saved view from the current files"
    );
    assert!(views::list().is_empty(), "nothing persisted");
}

