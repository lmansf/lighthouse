//! In-memory session egress registry (roadmap S3 / phase 1.2): every
//! outbound-HTTP call site reports through `record()` just before dialing,
//! and the UI's header shield + widget footer render `snapshot()` — turning
//! "nothing leaves this machine unless you chose a cloud provider" from an
//! architectural claim into something the user can watch.
//!
//! Deliberately minimal: destination host + purpose + count + last time.
//! NEVER content, questions, file names, or full URLs. Session memory only —
//! no persistence, no rotation (the audit log, add-audit-log, is the durable
//! record and consumes the same registry). Loopback traffic (llama/embed
//! servers) is not egress and is never recorded here.
//!
//! KEEP IN SYNC with src/server/egress.ts (purpose labels are byte-identical
//! — they render in the panel).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::json;

use crate::config::now_ms;

/// Purpose labels (user-visible in the panel; byte-identical in the twin).
pub const PURPOSE_AI_PROVIDER: &str = "AI provider";
pub const PURPOSE_LICENSE: &str = "License & trial";
pub const PURPOSE_TELEMETRY: &str = "Telemetry";
pub const PURPOSE_CHECKOUT: &str = "Checkout";
pub const PURPOSE_UPDATE_CHECK: &str = "Update check";
pub const PURPOSE_UPDATE_DOWNLOAD: &str = "Update download";
pub const PURPOSE_MODEL_DOWNLOAD: &str = "Model download";
pub const PURPOSE_SHAREPOINT: &str = "SharePoint / OneDrive";

#[derive(Clone)]
struct Entry {
    count: u64,
    last_ms: i64,
}

fn registry() -> &'static Mutex<HashMap<(String, String), Entry>> {
    static REG: OnceLock<Mutex<HashMap<(String, String), Entry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Report one outbound request about to be made to `host` for `purpose`.
/// `host` may be a full URL — only the host part is kept (never the path,
/// which could carry identifiers).
pub fn record(host: &str, purpose: &str) {
    let host = host_of(host);
    if host.is_empty() {
        return;
    }
    let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    let e = reg
        .entry((host, purpose.to_string()))
        .or_insert(Entry { count: 0, last_ms: 0 });
    e.count += 1;
    e.last_ms = now_ms();
}

/// Reduce a URL or host string to its bare host (drop scheme/path/port).
fn host_of(input: &str) -> String {
    let s = input.trim();
    let s = s.split("://").nth(1).unwrap_or(s);
    let s = s.split('/').next().unwrap_or(s);
    let s = s.split('@').next_back().unwrap_or(s); // never keep userinfo
    s.split(':').next().unwrap_or(s).to_ascii_lowercase()
}

/// The panel payload: total request count plus per-(host, purpose) rows,
/// most-recent first. `{ total: 0, destinations: [] }` renders "All local".
pub fn snapshot() -> serde_json::Value {
    let reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    let mut rows: Vec<_> = reg
        .iter()
        .map(|((host, purpose), e)| (host.clone(), purpose.clone(), e.count, e.last_ms))
        .collect();
    rows.sort_by(|a, b| b.3.cmp(&a.3));
    let total: u64 = rows.iter().map(|r| r.2).sum();
    json!({
        "total": total,
        "destinations": rows
            .into_iter()
            .map(|(host, purpose, count, last)| json!({
                "host": host,
                "purpose": purpose,
                "count": count,
                "lastAt": last,
            }))
            .collect::<Vec<_>>(),
    })
}

/// Per-host total request counts (host → count). The audit log snapshots
/// this before an answer and diffs after, so a host whose count rose is an
/// egress for that specific question.
pub fn host_counts() -> HashMap<String, u64> {
    let reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    let mut out: HashMap<String, u64> = HashMap::new();
    for ((host, _purpose), e) in reg.iter() {
        *out.entry(host.clone()).or_insert(0) += e.count;
    }
    out
}

/// Hosts whose request count rose between `before` and now — the egress
/// attributable to one question. Sorted for a stable record.
pub fn hosts_since(before: &HashMap<String, u64>) -> Vec<String> {
    let now = host_counts();
    let mut hosts: Vec<String> = now
        .iter()
        .filter(|(h, &c)| c > before.get(*h).copied().unwrap_or(0))
        .map(|(h, _)| h.clone())
        .collect();
    hosts.sort();
    hosts
}

/// Test seam: clear the session registry.
#[cfg(debug_assertions)]
pub fn reset_for_tests() {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_aggregate_by_host_and_purpose_and_never_keep_paths() {
        reset_for_tests();
        assert_eq!(snapshot()["total"], 0, "fresh session reads All local");

        record(
            "https://api.anthropic.com/v1/messages?secret=nope",
            PURPOSE_AI_PROVIDER,
        );
        record("https://api.anthropic.com/v1/models", PURPOSE_AI_PROVIDER);
        record("https://user:pw@api.github.com:443/repos/x", PURPOSE_UPDATE_CHECK);

        let snap = snapshot();
        assert_eq!(snap["total"], 3);
        let rows = snap["destinations"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "same host+purpose aggregates");
        let flat = snap.to_string();
        assert!(flat.contains("api.anthropic.com"));
        assert!(flat.contains("api.github.com"));
        assert!(!flat.contains("/v1/"), "paths never stored: {flat}");
        assert!(!flat.contains("secret"), "query strings never stored");
        assert!(!flat.contains("user:pw"), "userinfo never stored");
        let anthropic = rows
            .iter()
            .find(|r| r["host"] == "api.anthropic.com")
            .unwrap();
        assert_eq!(anthropic["count"], 2);
        assert!(anthropic["lastAt"].as_i64().unwrap() > 0);
        reset_for_tests();
    }
}
