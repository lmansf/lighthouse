//! Usage click-logging (port of `src/server/usage.ts`) — best-effort UI
//! telemetry. Consent is OFF by default (opted out); only coarse labels are
//! recorded, ring-buffered to `usage-events.jsonl` and batch-published on
//! launch. Nothing here may ever break a launch.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::config::{iso_now, read_json, state_dir, write_json};

const EVENT_TYPES: &[&str] = &["folder", "file", "toggle", "button", "link", "nav", "other"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEvent {
    pub at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub label: String,
}

// Ring-buffer caps — keep the MOST RECENT actions, trim the oldest on write.
const MAX_EVENTS: usize = 5000;
const MAX_BYTES: usize = 1_000_000;
const MAX_LABEL: usize = 200;

fn events_path() -> PathBuf {
    state_dir().join("usage-events.jsonl")
}
fn consent_path() -> PathBuf {
    state_dir().join("usage.json")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsageConsent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opt_out: Option<bool>,
    // The TS file writes camelCase `optOut`; accept both spellings on read.
    #[serde(default, rename = "optOut", skip_serializing_if = "Option::is_none")]
    opt_out_camel: Option<bool>,
}

impl UsageConsent {
    fn value(&self) -> Option<bool> {
        self.opt_out_camel.or(self.opt_out)
    }
}

/// Whether the user has opted OUT of usage logging. Default is opted OUT.
/// A managed `telemetry: "off"` policy reads as permanently opted out —
/// this one gate locks capture (append), publish, and the UI toggle state.
pub fn is_usage_opted_out() -> bool {
    if !crate::policy::telemetry_allowed() {
        return true;
    }
    read_json(&consent_path(), UsageConsent::default()).value() != Some(false)
}

/// Persist the consent flag. Opting out also drops any buffered events.
pub fn set_usage_opt_out(opt_out: bool) {
    write_json(&consent_path(), &serde_json::json!({ "optOut": opt_out }));
    if opt_out {
        clear_usage_buffer();
    }
}

/// Reset consent to the default (opted OUT) — called when a trial is minted.
pub fn reset_usage_consent() {
    write_json(&consent_path(), &serde_json::json!({ "optOut": true }));
}

fn clear_usage_buffer() {
    let _ = fs::remove_file(events_path());
}

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write text atomically (temp-then-rename) to avoid torn reads.
fn write_text_atomic(file: &PathBuf, text: &str) {
    let n = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = file.with_file_name(format!(
        "{}.{}.{}.tmp",
        file.file_name().and_then(|s| s.to_str()).unwrap_or("usage"),
        std::process::id(),
        n
    ));
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, file);
    } else {
        let _ = fs::remove_file(&tmp);
    }
}

/// Coerce one untrusted event from the renderer, or None if unusable.
fn sanitize(raw: &serde_json::Value) -> Option<UsageEvent> {
    let obj = raw.as_object()?;
    let event_type = obj
        .get("type")
        .and_then(|t| t.as_str())
        .filter(|t| EVENT_TYPES.contains(t))
        .unwrap_or("other")
        .to_string();
    let label = obj
        .get("label")
        .and_then(|l| l.as_str())
        .map(|l| {
            let collapsed: String = l.split_whitespace().collect::<Vec<_>>().join(" ");
            collapsed.chars().take(MAX_LABEL).collect::<String>()
        })
        .unwrap_or_default();
    if label.is_empty() {
        return None;
    }
    let at = obj
        .get("at")
        .and_then(|a| a.as_str())
        .filter(|a| crate::config::parse_ms(a).is_some())
        .map(String::from)
        .unwrap_or_else(iso_now);
    Some(UsageEvent {
        at,
        event_type,
        label,
    })
}

/// Read the raw buffer as lines (empty/partial lines dropped).
fn read_buffer_lines() -> Vec<String> {
    let Ok(text) = fs::read_to_string(events_path()) else {
        return Vec::new();
    };
    text.split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| serde_json::from_str::<serde_json::Value>(l).is_ok())
        .map(String::from)
        .collect()
}

/// Append captured events to the local buffer, then trim to the ring caps.
/// No-op when opted out.
pub fn append_usage_events(events: &[serde_json::Value]) {
    if is_usage_opted_out() {
        return;
    }
    let incoming: Vec<String> = events
        .iter()
        .filter_map(sanitize)
        .filter_map(|e| serde_json::to_string(&e).ok())
        .collect();
    if incoming.is_empty() {
        return;
    }
    let mut lines = read_buffer_lines();
    lines.extend(incoming);
    if lines.len() > MAX_EVENTS {
        lines = lines.split_off(lines.len() - MAX_EVENTS);
    }
    // Enforce the byte cap by dropping the oldest lines until under the limit.
    let mut text = lines.join("\n") + "\n";
    while text.len() > MAX_BYTES && lines.len() > 1 {
        lines.remove(0);
        text = lines.join("\n") + "\n";
    }
    write_text_atomic(&events_path(), &text);
}

/// The parsed buffer plus the line count, so a successful publish can purge it.
pub fn read_usage_buffer() -> (Vec<UsageEvent>, usize) {
    let lines = read_buffer_lines();
    let events = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| sanitize(&v))
        .collect();
    (events, lines.len())
}

/// Purge the first `published_line_count` lines (the oldest, just published),
/// preserving any events appended since the read.
pub fn purge_usage_buffer(published_line_count: usize) {
    if published_line_count == 0 {
        return;
    }
    let lines = read_buffer_lines();
    let remaining: Vec<String> = lines.into_iter().skip(published_line_count).collect();
    if remaining.is_empty() {
        clear_usage_buffer();
    } else {
        write_text_atomic(&events_path(), &(remaining.join("\n") + "\n"));
    }
}
