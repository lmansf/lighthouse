//! Semantic-layer store over a real temp vault (openspec: add-semantic-layer
//! §1): metric round trip with derived reads + the camelCase byte contract,
//! unknown-version/corrupt bak-on-write, the save-time guard, the name rules
//! (reserved words, metric collisions, column shadowing, sanitization), the
//! unknown-entity refusal, the lifecycle rules (metric rename/delete refuse or
//! cascade against dependent synonyms), the model-free resolver, local-only
//! propagation + the cloud posture gate, and the sources-untouched invariant.
//! Mirrored by the TS twin's test/semantic.test.mjs (PARITY).

mod common;

use lighthouse_core::semantic;
use lighthouse_core::views::{SummarySource, ViewSummary};

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

/// Paths of `semantic.json.bak-<epochms>` siblings in the state dir.
fn bak_files(state: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(state)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("semantic.json.bak-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A vault with one included sales.csv (columns: region, amount).
fn seed_sales(vault: &std::path::Path) {
    write(&vault.join("sales.csv"), "region,amount\nnorth,3\nsouth,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("sales.csv", true);
}

#[test]
fn metric_round_trips_byte_stable_with_derived_reads() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // Create over the `sales` entity: name sanitizes, the file dependency is
    // derived from the synthesized `SELECT <expr> AS <name> FROM sales`.
    let created = semantic::create_metric(
        "Net Revenue",
        "SUM(amount) FILTER (WHERE region <> 'north')",
        "revenue excluding the north region",
        "sales",
        summary("revenue by region"),
        &["sales.csv".to_string()],
    )
    .expect("creates");
    assert!(created.id.starts_with("metric-"), "{}", created.id);
    assert_eq!(created.name, "net_revenue", "name sanitized at save");
    assert_eq!(created.entity, "sales");
    assert_eq!(created.description, "revenue excluding the north region");
    assert_eq!(created.reads.files.len(), 1);
    assert_eq!(created.reads.files[0].file_id, "sales.csv");
    assert_eq!(created.reads.files[0].table_name, "sales");
    assert!(created.reads.views.is_empty());
    assert_eq!(created.summary.source, SummarySource::Question);
    assert!(created.created_ms > 0);

    // Re-read from disk: the identical record returns.
    let listed = semantic::list();
    assert_eq!(listed.metrics.len(), 1);
    assert_eq!(listed.metrics[0], created, "round trip preserves the record");

    // Synonym + entity + join hint persist beside the metric.
    semantic::create_synonym("GMV", "net_revenue").expect("synonym");
    semantic::create_entity("sales", "sales", &["region".to_string()], "the ledger")
        .expect("entity");
    let store = semantic::list();
    assert_eq!(store.synonyms, vec![semantic::Synonym {
        term: "GMV".to_string(),
        canonical: "net_revenue".to_string(),
    }]);
    assert_eq!(store.entities[0].key_columns, vec!["region".to_string()]);

    // The on-disk envelope is the byte contract with the TS twin: v1, the four
    // record arrays in order (`joinHints` camelCase), 2-space pretty, camelCase
    // record keys (the view types' fileId/tableName reused), summary source a
    // bare lowercase string.
    let raw = std::fs::read_to_string(vault.path().join(".rag-vault/semantic.json")).unwrap();
    assert!(raw.starts_with("{\n  \"v\": 1,\n  \"metrics\": ["), "{raw}");
    for (a, b) in [
        ("\"metrics\"", "\"synonyms\""),
        ("\"synonyms\"", "\"entities\""),
        ("\"entities\"", "\"joinHints\""),
        ("\"id\"", "\"name\""),
        ("\"name\"", "\"expression\""),
        ("\"expression\"", "\"description\""),
        ("\"description\"", "\"entity\""),
        ("\"entity\"", "\"reads\""),
        ("\"reads\"", "\"summary\""),
        ("\"summary\"", "\"createdMs\""),
        ("\"fileId\"", "\"tableName\""),
        ("\"term\"", "\"canonical\""),
    ] {
        let (ia, ib) = (raw.find(a), raw.find(b));
        assert!(ia.is_some() && ia < ib, "{a} must precede {b} in:\n{raw}");
    }
    assert!(raw.contains("\"source\": \"question\""), "{raw}");
    assert!(raw.contains("\"keyColumns\": ["), "entity keyColumns is camelCase: {raw}");
}

#[test]
fn unknown_version_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    let newer = r#"{"v":99,"metrics":[{"id":"metric-future"}],"synonyms":[],"entities":[],"joinHints":[]}"#;
    std::fs::write(state.join("semantic.json"), newer).unwrap();

    // Session reads empty — never a crash, never a partial parse.
    assert!(semantic::list().metrics.is_empty(), "v99 loads empty");

    // The first write preserves the unreadable file, then writes fresh v1.
    semantic::create_synonym("gmv", "revenue").expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "exactly one bak: {baks:?}");
    assert_eq!(
        std::fs::read_to_string(&baks[0]).unwrap(),
        newer,
        "newer data recoverable byte-for-byte"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(state.join("semantic.json")).unwrap())
            .unwrap();
    assert_eq!(parsed["v"], 1);
    assert_eq!(parsed["synonyms"][0]["term"], "gmv");
}

/// Corrupt JSON baks the same way — a SEPARATE `#[test]` so it takes the env
/// lock on its own. Holding two `common::lock_env` guards at once on one thread
/// would deadlock the non-reentrant `ENV_LOCK` mutex.
#[test]
fn corrupt_json_loads_empty_and_baks_on_write() {
    let vault2 = tempfile::tempdir().unwrap();
    let _guard2 = common::lock_env(vault2.path());
    let state2 = vault2.path().join(".rag-vault");
    std::fs::create_dir_all(&state2).unwrap();
    std::fs::write(state2.join("semantic.json"), "{ not json").unwrap();
    assert!(semantic::list().synonyms.is_empty(), "corrupt loads empty");
    semantic::create_synonym("after", "x").expect("creates");
    let baks2 = bak_files(&state2);
    assert_eq!(baks2.len(), 1, "corrupt file preserved: {baks2:?}");
    assert_eq!(std::fs::read_to_string(&baks2[0]).unwrap(), "{ not json");
}

/// The guard runs at save: anything that is not a single read-only SELECT is
/// refused with the guard's reason and NOTHING persists.
#[test]
fn guard_refuses_bad_definitions_at_save() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // A non-read-only expression: the synthesized statement fails the guard.
    let err = semantic::create_metric(
        "sneaky",
        "1 FROM sales; DROP TABLE sales; SELECT 1",
        "",
        "sales",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .unwrap_err();
    assert_eq!(err, "expected exactly one SQL statement");

    // An expression that doesn't parse.
    let err = semantic::create_metric("broken", "SUM(", "", "sales", summary("q"), &["sales.csv".to_string()])
        .unwrap_err();
    assert!(err.starts_with("SQL parse error"), "{err}");

    // An empty expression parses leniently at the SQL layer, so create refuses
    // it explicitly (never persists an empty definition).
    let err = semantic::create_metric("blank", "   ", "", "sales", summary("q"), &["sales.csv".to_string()])
        .unwrap_err();
    assert_eq!(err, "a metric needs an expression");

    assert!(semantic::list().metrics.is_empty(), "refusals persist nothing");
    assert!(
        !vault.path().join(".rag-vault/semantic.json").exists(),
        "no store file was ever written"
    );
}

#[test]
fn name_rules_reject_reserved_shadow_collisions_and_empty() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // Reserved keywords, checked AFTER normalization.
    for reserved in ["select", "  SELECT ", "table"] {
        let err = semantic::create_metric(reserved, "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
            .unwrap_err();
        assert!(err.ends_with("is a reserved word"), "{reserved:?}: {err}");
    }
    // Unusable (empty after sanitization) names.
    for empty in ["", "   ", "!!!"] {
        assert_eq!(
            semantic::create_metric(empty, "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
                .unwrap_err(),
            "a metric needs a name",
            "{empty:?}"
        );
    }
    // Shadowing a column of the entity (sales has region, amount) is refused —
    // the columns are read from the real file via the catalog.
    assert_eq!(
        semantic::create_metric("amount", "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
            .unwrap_err(),
        "\"amount\" is already a column of sales"
    );

    // A valid metric, then a case-insensitive collision with it.
    semantic::create_metric("Revenue", "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    for taken in ["revenue", "Revenue", "  REVENUE "] {
        assert_eq!(
            semantic::create_metric(taken, "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
                .unwrap_err(),
            "a metric named \"revenue\" already exists",
            "{taken:?}"
        );
    }
    assert_eq!(semantic::list().metrics.len(), 1, "only the one valid create persisted");
}

#[test]
fn unknown_entity_references_are_refused() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    // The entity resolves to no passed file table and no saved view.
    let err = semantic::create_metric("mystery", "SUM(amount)", "", "nowhere", summary("q"), &["sales.csv".to_string()])
        .unwrap_err();
    assert_eq!(err, "unknown entity in definition: nowhere");
    // The right entity name but no file ids can't resolve `sales` either.
    let err = semantic::create_metric("mystery", "SUM(amount)", "", "sales", summary("q"), &[])
        .unwrap_err();
    assert_eq!(err, "unknown entity in definition: sales");
    assert!(semantic::list().metrics.is_empty());
}

#[test]
fn resolve_metric_returns_the_stored_expression_or_none() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());
    assert_eq!(semantic::resolve_metric("revenue"), None, "empty store");

    semantic::create_metric(
        "revenue",
        "SUM(amount) FILTER (WHERE region <> 'north')",
        "",
        "sales",
        summary("q"),
        &["sales.csv".to_string()],
    )
    .expect("creates");
    assert_eq!(
        semantic::resolve_metric("revenue").as_deref(),
        Some("SUM(amount) FILTER (WHERE region <> 'north')")
    );
    assert_eq!(
        semantic::resolve_metric("  REVENUE  ").as_deref(),
        Some("SUM(amount) FILTER (WHERE region <> 'north')"),
        "trimmed, case-insensitive"
    );
    assert_eq!(semantic::resolve_metric("unknown"), None);
}

/// The lifecycle rules mirror views: a metric referenced by a synonym refuses
/// rename, and refuses delete unless cascade (which removes it plus the
/// synonyms that map to it in one write).
#[test]
fn metric_lifecycle_refuses_or_cascades_against_dependent_synonyms() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    seed_sales(vault.path());

    let revenue = semantic::create_metric("revenue", "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    semantic::create_synonym("GMV", "revenue").expect("synonym");
    semantic::create_synonym("turnover", "Revenue").expect("case-insensitive synonym");

    // Rename refused while synonyms map to it (naming them).
    let err = semantic::rename_metric(&revenue.id, "net_revenue").unwrap_err();
    assert_eq!(err, "\"revenue\" can't be renamed while synonyms map to it: GMV, turnover");
    // Delete refused by default with the same list.
    let err = semantic::delete_metric(&revenue.id, false).unwrap_err();
    assert_eq!(err, "\"revenue\" can't be deleted while synonyms map to it: GMV, turnover");
    assert_eq!(semantic::list().metrics.len(), 1, "refusals changed nothing");
    assert_eq!(semantic::list().synonyms.len(), 2);

    // Cascade removes the metric AND both mapping synonyms in one write.
    assert_eq!(semantic::delete_metric(&revenue.id, true).expect("cascades"), revenue.id);
    let store = semantic::list();
    assert!(store.metrics.is_empty());
    assert!(store.synonyms.is_empty(), "dependent synonyms cascaded away");

    // A metric with NO dependents renames (id stable) and deletes freely.
    let m = semantic::create_metric("orders", "COUNT(*)", "", "sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    let renamed = semantic::rename_metric(&m.id, "Order Count").expect("renames");
    assert_eq!(renamed.name, "order_count");
    assert_eq!(renamed.id, m.id, "rename keeps the id");
    assert_eq!(semantic::delete_metric(&m.id, false).expect("deletes"), m.id);
    assert!(semantic::list().metrics.is_empty());
    // Unknown ids refuse.
    assert_eq!(semantic::rename_metric("metric-nope", "x").unwrap_err(), "metric not found");
    assert_eq!(semantic::delete_metric("metric-nope", true).unwrap_err(), "metric not found");
}

/// A metric/entity over an effectively-local-only source is visible on a device
/// ask and excluded from every cloud surface; a synonym naming a dropped metric
/// and a join hint touching a dropped entity drop with it.
#[test]
fn local_only_definitions_are_ineligible_on_cloud_asks() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("private.csv"), "region,amount\nNE,5\n");
    write(&vault.path().join("public.csv"), "region,amount\nSW,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("private.csv", true);
    lighthouse_core::vault::set_included("public.csv", true);
    lighthouse_core::vault::set_local_only("private.csv", true);

    let private_metric = semantic::create_metric_with_context(
        "private_rev",
        "SUM(amount)",
        "",
        "private",
        summary("q"),
        &[("private.csv".to_string(), "private.csv".to_string())],
        &[],
    )
    .expect("creates");
    let public_metric = semantic::create_metric_with_context(
        "public_rev",
        "SUM(amount)",
        "",
        "public",
        summary("q"),
        &[("public.csv".to_string(), "public.csv".to_string())],
        &[],
    )
    .expect("creates");
    semantic::create_synonym("pgmv", "private_rev").expect("synonym on the private metric");
    semantic::create_synonym("pubgmv", "public_rev").expect("synonym on the public metric");
    semantic::create_entity("priv_ent", "private", &[], "").expect("entity over the private table");
    semantic::create_entity("pub_ent", "public", &[], "").expect("entity over the public table");

    // The propagation predicate itself.
    assert!(semantic::metric_effectively_local_only(&private_metric.reads));
    assert!(!semantic::metric_effectively_local_only(&public_metric.reads));

    // Device posture: everything is eligible.
    let local = semantic::eligible_for_posture(false);
    assert_eq!(local.metrics.len(), 2);
    assert_eq!(local.synonyms.len(), 2);
    assert_eq!(local.entities.len(), 2);

    // Cloud posture: the private metric, its synonym, and the private entity
    // are all dropped; the public ones remain.
    let cloud = semantic::eligible_for_posture(true);
    assert_eq!(
        cloud.metrics.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        vec!["public_rev"],
        "the local-only metric never rides a cloud prompt"
    );
    assert_eq!(
        cloud.synonyms.iter().map(|s| s.term.as_str()).collect::<Vec<_>>(),
        vec!["pubgmv"],
        "the synonym naming the dropped metric drops with it"
    );
    assert_eq!(
        cloud.entities.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        vec!["pub_ent"],
        "the entity over the local-only table drops on cloud"
    );
}

/// Saving/renaming/deleting metrics never writes to any source file — the
/// fixture's bytes are identical after every operation.
#[test]
fn source_files_are_never_touched_by_any_op() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let csv = vault.path().join("sales.csv");
    write(&csv, "region,amount\nnorth,3\nsouth,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("sales.csv", true);
    let before = std::fs::read(&csv).unwrap();

    let m = semantic::create_metric("revenue", "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
        .expect("creates");
    semantic::create_synonym("gmv", "revenue").expect("synonym");
    let _ = semantic::create_metric("select", "SUM(amount)", "", "sales", summary("q"), &["sales.csv".to_string()])
        .unwrap_err(); // a refusal too
    semantic::delete_metric(&m.id, true).expect("cascades");

    assert_eq!(
        std::fs::read(&csv).unwrap(),
        before,
        "source bytes identical after create/refusal/cascade-delete"
    );
    assert!(semantic::list().metrics.is_empty());
}
