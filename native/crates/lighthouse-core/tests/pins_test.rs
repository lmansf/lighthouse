//! Pinned questions over a real temp vault: prime → change → alert; identical
//! recheck stays quiet; a vanished file marks the pin stale and never alerts
//! (openspec: add-pinned-questions).

mod common;

use lighthouse_core::pins;

fn write(path: &std::path::Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn pins_prime_alert_on_change_and_go_stale() {
    let vault = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault.path());
    write(&vault.path().join("tickets.csv"), "priority,count\nP1,3\nP2,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    // Rechecks honor AI visibility — only included files register.
    lighthouse_core::vault::set_included("tickets.csv", true);

    let sql = "SELECT priority, SUM(count) AS total FROM tickets GROUP BY priority ORDER BY priority";
    let ids = vec!["tickets.csv".to_string()];

    // Cap + replace semantics.
    let pin = pins::add("open tickets by priority", sql, &ids).expect("adds");
    let again = pins::add("open tickets by priority", sql, &ids).expect("re-pin replaces");
    assert_eq!(pin.id, again.id, "same SQL ⇒ same pin id");
    assert_eq!(pins::list().len(), 1);

    // First recheck PRIMES the digest — nothing to compare, no alert.
    assert!(pins::recheck_one(&pin.id).await.is_none(), "priming never alerts");
    let primed = &pins::list()[0];
    assert!(primed.last_digest.is_some());
    assert_eq!(primed.last_summary.as_deref(), Some("P1 3 · P2 7"));

    // Identical data ⇒ identical digest ⇒ no alert.
    assert!(pins::recheck_all().await.is_empty(), "no change, no alert");

    // The number moves ⇒ one changed pin with before/after summaries.
    write(&vault.path().join("tickets.csv"), "priority,count\nP1,5\nP2,7\n");
    lighthouse_core::vault::invalidate_walk_cache();
    let changed = pins::recheck_all().await;
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].before.as_deref(), Some("P1 3 · P2 7"));
    assert_eq!(changed[0].after, "P1 5 · P2 7");

    // The file vanishes ⇒ stale with the engine's reason, alerts suppressed.
    std::fs::remove_file(vault.path().join("tickets.csv")).unwrap();
    lighthouse_core::vault::invalidate_walk_cache();
    assert!(pins::recheck_all().await.is_empty(), "stale pins never alert");
    let stale = &pins::list()[0];
    assert!(stale.stale_reason.as_deref().unwrap_or("").contains("available"), "{stale:?}");

    // Corrupt store resets to empty instead of blocking.
    std::fs::write(vault.path().join(".rag-vault/pins.json"), "{not json").unwrap();
    assert!(pins::list().is_empty());

    // Cap enforced with a human-readable reason.
    for i in 0..pins::MAX_PINS {
        pins::add(&format!("q{i}"), &format!("SELECT {i}"), &ids).expect("under cap");
    }
    let err = pins::add("one more", "SELECT 999", &ids).unwrap_err();
    assert!(err.contains("pin limit"), "{err}");

    // Removal is idempotent and frees a slot.
    let victim = pins::list()[0].id.clone();
    pins::remove(&victim);
    pins::remove(&victim);
    assert_eq!(pins::list().len(), pins::MAX_PINS - 1);
}
