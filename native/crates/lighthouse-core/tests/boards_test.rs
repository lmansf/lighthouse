//! Boards store + refresh over a real temp vault (openspec: add-boards):
//! round trip with order and sizes, unknown-version/corrupt bak-on-write,
//! card-removal-preserves-pin, per-scope name collisions, lazy virtual
//! defaults materializing under their deterministic ids, and the
//! refreshCards desktop path — a real DataFusion re-execution that returns
//! live rows AND advances the pin's stored digest exactly like a recheck.
//! Mirrored by the TS twin's test/boards.test.mjs (PARITY).

mod common;

use lighthouse_core::boards::{self, CardRef, CardSize};
use lighthouse_core::investigations::{self, ProviderPolicy};
use lighthouse_core::pins;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn card(pin_id: &str, size: CardSize) -> CardRef {
    CardRef {
        pin_id: pin_id.to_string(),
        size,
    }
}

/// Paths of `boards.json.bak-<epochms>` siblings in the state dir.
fn bak_files(state: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(state)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("boards.json.bak-"))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn round_trips_byte_stable_with_order_and_sizes() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());

    let created = boards::create("Ops overview", None).expect("creates");
    assert!(created.id.starts_with("board-"), "{}", created.id);
    assert_eq!(created.investigation_id, None);
    assert!(created.cards.is_empty());

    // Three cards S, M, L…
    boards::set_cards(
        &created.id,
        vec![
            card("pin-aaa", CardSize::S),
            card("pin-bbb", CardSize::M),
            card("pin-ccc", CardSize::L),
        ],
    )
    .expect("sets cards");
    // …then reordered (one op for reorder/resize/add/remove alike).
    let reordered = vec![
        card("pin-ccc", CardSize::L),
        card("pin-aaa", CardSize::S),
        card("pin-bbb", CardSize::M),
    ];
    boards::set_cards(&created.id, reordered.clone()).expect("reorders");

    // Re-read from disk: exact order and sizes preserved.
    let listed = boards::list();
    assert_eq!(listed.len(), 1);
    let board = &listed[0];
    assert_eq!(board.id, created.id);
    assert_eq!(board.name, "Ops overview");
    assert_eq!(board.created_ms, created.created_ms);
    assert_eq!(board.cards, reordered, "order and sizes round-trip exactly");

    // The on-disk envelope is the byte contract with the TS twin: v1, then
    // the records, camelCase keys in declaration order, 2-space pretty,
    // sizes as bare "S"/"M"/"L" strings, investigationId omitted (global).
    let raw = std::fs::read_to_string(vault.path().join(".rag-vault/boards.json")).unwrap();
    assert!(raw.starts_with("{\n  \"v\": 1,\n  \"boards\": ["), "{raw}");
    for pair in [
        ("\"id\"", "\"name\""),
        ("\"name\"", "\"cards\""),
        ("\"cards\"", "\"createdMs\""),
        ("\"pinId\"", "\"size\""),
    ] {
        let (a, b) = (raw.find(pair.0), raw.find(pair.1));
        assert!(a.is_some() && a < b, "{} must precede {}", pair.0, pair.1);
    }
    assert!(!raw.contains("\"investigationId\""), "global boards omit the scope: {raw}");
    assert!(raw.contains("\"size\": \"L\""), "{raw}");

    // A scoped board carries its investigationId on disk.
    let inv = investigations::create("Q3 audit", &[], ProviderPolicy::Default).unwrap();
    boards::create("Q3 numbers", Some(&inv.id)).expect("creates scoped");
    let raw = std::fs::read_to_string(vault.path().join(".rag-vault/boards.json")).unwrap();
    assert!(
        raw.contains(&format!("\"investigationId\": \"{}\"", inv.id)),
        "{raw}"
    );

    // Rename keeps the id; blank scope normalizes to global on create.
    let renamed = boards::rename(&created.id, "Ops, renamed").expect("renames");
    assert_eq!(renamed.id, created.id, "rename keeps the id");
    assert_eq!(boards::list()[0].name, "Ops, renamed");
    let blank = boards::create("Blank scope", Some("  ")).expect("creates");
    assert_eq!(blank.investigation_id, None, "blank scope = global");
}

#[test]
fn unknown_version_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    let newer = r#"{"v":99,"boards":[{"id":"board-from-the-future"}]}"#;
    std::fs::write(state.join("boards.json"), newer).unwrap();

    // Session reads empty — never a crash, never a partial parse. The
    // listing still serves the virtual global default (lazy, not stored).
    assert!(boards::list().is_empty(), "v99 loads empty");
    let listing = boards::list_for(None);
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].id, "default-global");

    // The first write preserves the unreadable file, then writes fresh v1.
    boards::create("Fresh", None).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "exactly one bak: {baks:?}");
    assert_eq!(
        std::fs::read_to_string(&baks[0]).unwrap(),
        newer,
        "newer data recoverable byte-for-byte"
    );
    let raw = std::fs::read_to_string(state.join("boards.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["v"], 1);
    assert_eq!(parsed["boards"][0]["name"], "Fresh");
    assert_eq!(boards::list().len(), 1);
}

#[test]
fn corrupt_json_loads_empty_and_baks_on_write() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let state = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("boards.json"), "{ not json").unwrap();

    assert!(boards::list().is_empty(), "corrupt loads empty");
    boards::create("After corruption", None).expect("creates");
    let baks = bak_files(&state);
    assert_eq!(baks.len(), 1, "corrupt file preserved: {baks:?}");
    assert_eq!(std::fs::read_to_string(&baks[0]).unwrap(), "{ not json");
    assert_eq!(boards::list().len(), 1);
}

/// Cards are pure references: removing one never touches the pin — the
/// pins.json bytes (stored digest and summary included) stay identical.
#[tokio::test]
async fn card_removal_preserves_the_pin() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("tickets.csv"), "priority,count\nP1,3\nP2,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("tickets.csv", true);

    // A real pin with a primed digest + summary on disk.
    let pin = pins::add(
        "open tickets by priority",
        "SELECT priority, SUM(count) AS total FROM tickets GROUP BY priority ORDER BY priority",
        &["tickets.csv".to_string()],
        None,
    )
    .expect("adds");
    pins::recheck_one(&pin.id).await;
    let before = std::fs::read_to_string(vault.path().join(".rag-vault/pins.json")).unwrap();
    assert!(before.contains("lastDigest"), "primed: {before}");

    // A board card referencing it, then a full-list replace WITHOUT it.
    let board = boards::create("Tickets", None).expect("creates");
    boards::set_cards(&board.id, vec![card(&pin.id, CardSize::M)]).expect("adds card");
    boards::set_cards(&board.id, vec![]).expect("removes card");
    assert!(boards::list()[0].cards.is_empty());

    // The pin is untouched — byte-for-byte.
    let after = std::fs::read_to_string(vault.path().join(".rag-vault/pins.json")).unwrap();
    assert_eq!(before, after, "pins.json untouched by card removal");
    assert_eq!(pins::list().len(), 1);
    assert_eq!(pins::list()[0].id, pin.id);

    // Deleting the whole board doesn't touch the pin either.
    boards::delete(&board.id).expect("deletes");
    assert_eq!(
        std::fs::read_to_string(vault.path().join(".rag-vault/pins.json")).unwrap(),
        before
    );
}

#[test]
fn names_are_unique_per_scope_only() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let inv_a = investigations::create("Alpha", &[], ProviderPolicy::Default).unwrap();
    let inv_b = investigations::create("Beta", &[], ProviderPolicy::Default).unwrap();

    // The same name lives happily in the global scope AND in each
    // investigation — scopes validate separately.
    boards::create("Ops", None).expect("global");
    boards::create("Ops", Some(&inv_a.id)).expect("scoped to Alpha");
    boards::create("Ops", Some(&inv_b.id)).expect("scoped to Beta");

    // WITHIN a scope: case-insensitive, trim-aware rejection.
    let err = boards::create("ops", None).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    let err = boards::create("  OPS  ", Some(&inv_a.id)).unwrap_err();
    assert!(err.contains("already exists"), "trimmed collision: {err}");
    assert!(boards::create("", None).is_err());
    assert!(boards::create("   ", Some(&inv_a.id)).is_err());

    // Rename obeys the same per-scope rule; its own name (a case change) is
    // allowed; the SAME name in another scope is not a collision.
    let second = boards::create("Second", Some(&inv_a.id)).expect("creates");
    let err = boards::rename(&second.id, "OPS").unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    let renamed = boards::rename(&second.id, "SECOND").expect("case change of own name");
    assert_eq!(renamed.name, "SECOND");
    assert_eq!(renamed.id, second.id, "rename keeps the id");
    boards::rename(&second.id, "Global twin").expect("renames");
    boards::create("Global twin", None).expect("same name, other scope");
    assert!(boards::rename("board-nope", "X").is_err());
}

#[test]
fn virtual_defaults_list_lazily_and_materialize_on_first_mutation() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    let inv = investigations::create("Harbor case", &[], ProviderPolicy::Default).unwrap();

    // Nothing persisted: the "all" listing synthesizes the global "My
    // board" plus one default per investigation, deterministic ids, empty
    // cards, createdMs 0 — and writes NOTHING.
    let all = boards::list_for(None);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, "default-global");
    assert_eq!(all[0].name, "My board");
    assert_eq!(all[0].investigation_id, None);
    assert!(all[0].cards.is_empty());
    assert_eq!(all[0].created_ms, 0, "virtual = never persisted");
    assert_eq!(all[1].id, format!("default-{}", inv.id));
    assert_eq!(all[1].name, "Harbor case", "scoped default named after the investigation");
    assert_eq!(all[1].investigation_id.as_deref(), Some(inv.id.as_str()));
    assert!(
        !vault.path().join(".rag-vault/boards.json").exists(),
        "listing never writes"
    );

    // The scoped listing returns just that scope's virtual default; an
    // unknown investigation yields nothing to name a default after.
    let scoped = boards::list_for(Some(&inv.id));
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].id, format!("default-{}", inv.id));
    assert!(boards::list_for(Some("inv-nope")).is_empty());

    // First mutation targeting the virtual id materializes it AS that id —
    // the client mutates exactly what list returned.
    let saved = boards::set_cards("default-global", vec![card("pin-x", CardSize::S)])
        .expect("materializes");
    assert_eq!(saved.id, "default-global");
    assert_eq!(saved.name, "My board");
    assert!(saved.created_ms > 0, "materialized = persisted");
    let records = boards::list();
    assert_eq!(records.len(), 1, "now a real record");
    assert_eq!(records[0].cards.len(), 1);

    // The listing no longer synthesizes a global virtual (the scope has a
    // board), while the investigation's default stays virtual.
    let all = boards::list_for(None);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, "default-global");
    assert_eq!(all[0].cards.len(), 1);
    assert_eq!(all[1].id, format!("default-{}", inv.id));
    assert_eq!(all[1].created_ms, 0, "still virtual");

    // Renaming a virtual default materializes it under the new name.
    let named = boards::rename(&format!("default-{}", inv.id), "Harbor wall").expect("renames");
    assert_eq!(named.id, format!("default-{}", inv.id));
    assert_eq!(named.name, "Harbor wall");
    assert_eq!(boards::list().len(), 2);

    // Deleting a default — materialized or virtual — is a reset: the next
    // listing synthesizes a fresh empty virtual default again.
    boards::delete("default-global").expect("deletes materialized default");
    boards::delete("default-global").expect("virtual default: Ok no-op");
    let all = boards::list_for(None);
    let fresh = all.iter().find(|b| b.id == "default-global").expect("relisted");
    assert!(fresh.cards.is_empty() && fresh.created_ms == 0, "reset to virtual");

    // A default id for an unknown investigation names nothing.
    let err = boards::set_cards("default-inv-nope", vec![]).unwrap_err();
    assert_eq!(err, "board not found");
    assert!(boards::rename("default-inv-nope", "X").is_err());
    assert!(boards::delete("default-inv-nope").is_err());
}

/// The desktop refresh path over a real fixture vault: refreshCards re-runs
/// the pin's stored SQL through DataFusion (run_direct — the recheck guard),
/// returns the live rows/digest/footer, AND advances the pin's stored
/// digest/summary/lastRun exactly like a recheck; failures answer
/// staleReason-style and mark the pin stale; unknown pins tombstone.
#[tokio::test]
async fn refresh_cards_computes_live_and_advances_the_stored_pin() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("tickets.csv"), "priority,count\nP1,3\nP2,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    lighthouse_core::vault::set_included("tickets.csv", true);

    let pin = pins::add(
        "open tickets by priority",
        "SELECT priority, SUM(count) AS total FROM tickets GROUP BY priority ORDER BY priority",
        &["tickets.csv".to_string()],
        None,
    )
    .expect("adds");
    assert!(pins::list()[0].last_digest.is_none(), "unprimed");

    // Live refresh: real rows, a digest, the engine footer, live: true.
    let cards = boards::refresh_cards(&[pin.id.clone(), "pin-nope".to_string()]).await;
    assert_eq!(cards.len(), 2);
    let live = &cards[0];
    assert_eq!(live.pin_id, pin.id);
    assert!(live.live);
    assert_eq!(live.tombstone, None);
    assert_eq!(live.question.as_deref(), Some("open tickets by priority"));
    let markdown = live.markdown.as_deref().expect("rows");
    assert!(markdown.contains("P1") && markdown.contains('3'), "{markdown}");
    assert!(live.footer.is_some(), "freshness line rides the footer");
    assert!(live.error.is_none());
    let digest = live.result_digest.clone().expect("digest");
    assert!(live.last_run_ms.is_some());

    // A manual board refresh IS a recheck: the stored pin advanced.
    let stored = &pins::list()[0];
    assert_eq!(stored.last_digest.as_deref(), Some(digest.as_str()));
    assert_eq!(stored.last_summary.as_deref(), Some("P1 3 · P2 7"));
    assert!(stored.last_run_ms.is_some());
    assert!(stored.stale_reason.is_none());

    // Unknown pin → tombstone, and it never blocks the rest of the board.
    let gone = &cards[1];
    assert_eq!(gone.pin_id, "pin-nope");
    assert_eq!(gone.tombstone, Some(true));
    assert!(gone.markdown.is_none() && gone.error.is_none());

    // The data moves → the next refresh returns the NEW digest and the
    // store follows (change detection is the recheck loop's, unchanged).
    write(&vault.path().join("tickets.csv"), "priority,count\nP1,5\nP2,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    let cards = boards::refresh_cards(std::slice::from_ref(&pin.id)).await;
    let fresh_digest = cards[0].result_digest.clone().expect("digest");
    assert_ne!(fresh_digest, digest, "result changed ⇒ digest changed");
    assert_eq!(
        pins::list()[0].last_digest.as_deref(),
        Some(fresh_digest.as_str()),
        "stored digest advanced with the refresh"
    );
    assert_eq!(pins::list()[0].last_summary.as_deref(), Some("P1 5 · P2 7"));

    // The file vanishes → the card answers the failure staleReason-style
    // (error text, freshness kept, live — the engine DID try) and the pin
    // goes stale in the store, exactly like a watcher recheck.
    std::fs::remove_file(vault.path().join("tickets.csv")).unwrap();
    lighthouse_core::vault::invalidate_walk_cache();
    let cards = boards::refresh_cards(std::slice::from_ref(&pin.id)).await;
    let failed = &cards[0];
    assert!(failed.live);
    let reason = failed.error.as_deref().expect("failure reason");
    assert!(failed.markdown.is_none() && failed.result_digest.is_none());
    assert!(failed.last_run_ms.is_some(), "freshness line kept");
    let stored = &pins::list()[0];
    assert_eq!(stored.stale_reason.as_deref(), Some(reason), "pin marked stale");
}
