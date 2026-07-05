//! Usage telemetry buffer parity: consent default, sanitization, ring caps.

mod common;

use lighthouse_core::usage;
use serde_json::json;

#[test]
fn consent_defaults_to_opted_out_and_gates_capture() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());

    assert!(
        usage::is_usage_opted_out(),
        "capture is off until an explicit opt-in"
    );
    usage::append_usage_events(&[json!({ "type": "button", "label": "Ask" })]);
    let (events, _) = usage::read_usage_buffer();
    assert!(events.is_empty(), "opted out ⇒ nothing buffered");

    usage::set_usage_opt_out(false);
    usage::append_usage_events(&[json!({ "type": "button", "label": "Ask" })]);
    let (events, _) = usage::read_usage_buffer();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].label, "Ask");

    // Opting back out drops what was buffered, so nothing leaks later.
    usage::set_usage_opt_out(true);
    let (events, _) = usage::read_usage_buffer();
    assert!(events.is_empty());
}

#[test]
fn events_are_sanitized_and_labels_clamped() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    usage::set_usage_opt_out(false);

    usage::append_usage_events(&[
        json!({ "type": "not-a-type", "label": "  spaced   out  " }),
        json!({ "type": "file", "label": "x".repeat(500) }),
        json!({ "type": "file" }), // no label ⇒ dropped
        json!("not an object"),    // ⇒ dropped
    ]);
    let (events, _) = usage::read_usage_buffer();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].event_type, "other",
        "unknown types coerce to other"
    );
    assert_eq!(events[0].label, "spaced out", "whitespace collapsed");
    assert_eq!(events[1].label.len(), 200, "labels are hard-clamped");
}

#[test]
fn ring_buffer_keeps_most_recent_and_purge_preserves_tail() {
    let vault_dir = tempfile::tempdir().unwrap();
    let _guard = common::lock_env(vault_dir.path());
    usage::set_usage_opt_out(false);

    let batch: Vec<serde_json::Value> = (0..60)
        .map(|i| json!({ "type": "button", "label": format!("evt-{i}") }))
        .collect();
    usage::append_usage_events(&batch);
    let (events, count) = usage::read_usage_buffer();
    assert_eq!(count, 60);

    // Purging the first 50 (a published batch) preserves the newest 10.
    usage::purge_usage_buffer(50);
    let (remaining, _) = usage::read_usage_buffer();
    assert_eq!(remaining.len(), 10);
    assert_eq!(remaining[0].label, "evt-50");
    assert_eq!(events[59].label, "evt-59");
}
