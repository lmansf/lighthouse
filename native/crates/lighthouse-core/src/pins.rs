//! Pinned questions: persisted, watched analytics asks
//! (openspec: add-pinned-questions).
//!
//! A pin captures an analytics answer's question, its exact SQL, and the file
//! ids it read. Rechecks re-run the stored SQL through the SAME guarded,
//! model-free path as Edit SQL (`analytics::run_direct`) and compare a result
//! digest — an alert fires only when the computed result actually changed.
//! Failures mark the pin stale with the engine's reason and suppress its
//! alerts; a corrupt store resets to empty rather than blocking startup.
//!
//! The desktop shell owns the recheck scheduler (watch-generation sampling +
//! quiet debounce); the dev server twin (src/server/pins.ts, KEEP IN SYNC)
//! implements CRUD only — rechecks need DataFusion, which is desktop-only
//! (PARITY).

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

use crate::config::{now_ms, state_dir};

/// A briefing list, not a dashboard product.
pub const MAX_PINS: usize = 20;
/// Rows kept in the compact result summary shown by alerts and the dialog.
const SUMMARY_ROWS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: String,
    pub question: String,
    pub sql: String,
    pub file_ids: Vec<String>,
    pub created_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_summary: Option<String>,
    /// Why the last recheck couldn't run (file gone, schema drift, guard) —
    /// shown in the dialog; a stale pin never alerts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
}

/// One changed pin in a recheck pass — the alert payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPin {
    pub id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    pub after: String,
}

fn pins_path() -> PathBuf {
    state_dir().join("pins.json")
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    pins: Vec<Pin>,
}

/// All pins, oldest first. A missing or corrupt store reads as empty.
pub fn list() -> Vec<Pin> {
    std::fs::read_to_string(pins_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Store>(&s).ok())
        .map(|s| s.pins)
        .unwrap_or_default()
}

fn save(pins: &[Pin]) {
    let path = pins_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&Store { pins: pins.to_vec() }) {
        let _ = std::fs::write(path, json);
    }
}

/// Stable id from the pinned SQL, so re-pinning the same query replaces the
/// old pin instead of duplicating it.
fn pin_id(sql: &str) -> String {
    let digest = Sha1::digest(sql.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("pin-{}", &hex[..12])
}

/// Add (or replace) a pin. Fails past the cap with a human-readable reason.
pub fn add(question: &str, sql: &str, file_ids: &[String]) -> Result<Pin, String> {
    let question = question.trim();
    let sql = sql.trim();
    if question.is_empty() || sql.is_empty() {
        return Err("a pin needs the question and its SQL".to_string());
    }
    let mut pins = list();
    let id = pin_id(sql);
    pins.retain(|p| p.id != id); // re-pin replaces
    if pins.len() >= MAX_PINS {
        return Err(format!(
            "pin limit reached ({MAX_PINS}) — remove one in the pins dialog first"
        ));
    }
    let pin = Pin {
        id,
        question: question.to_string(),
        sql: sql.to_string(),
        file_ids: file_ids.to_vec(),
        created_ms: now_ms(),
        last_run_ms: None,
        last_digest: None,
        last_summary: None,
        stale_reason: None,
    };
    pins.push(pin.clone());
    save(&pins);
    Ok(pin)
}

/// Remove a pin by id (idempotent).
pub fn remove(id: &str) {
    let mut pins = list();
    pins.retain(|p| p.id != id);
    save(&pins);
}

/// Compact "NE 125 · NW 50" summary from the result's markdown table —
/// stored on the pin so alerts can say what changed without re-running.
fn summarize(markdown: &str) -> String {
    let rows: Vec<String> = markdown
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('|') && !l.contains("---"))
        .map(|l| {
            l.trim_matches('|')
                .split('|')
                .map(str::trim)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let summary = rows
        .iter()
        .skip(1) // header
        .take(SUMMARY_ROWS)
        .cloned()
        .collect::<Vec<_>>()
        .join(" · ");
    if !summary.is_empty() {
        return summary;
    }
    // Non-tabular render (shouldn't happen for guarded SELECTs, but degrade).
    markdown.lines().next().unwrap_or("").chars().take(80).collect()
}

/// Re-run one pin. `Some` = the result digest CHANGED since the last run (a
/// first run only primes the digest — nothing to compare yet, no alert).
/// Errors mark the pin stale (reason kept) and never alert.
async fn recheck_pin(pin: &mut Pin) -> Option<ChangedPin> {
    match crate::analytics::run_direct(&pin.sql, &pin.file_ids).await {
        Ok(res) => {
            let digest: String =
                Sha1::digest(res.markdown.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            let summary = summarize(&res.markdown);
            let changed = pin.last_digest.as_deref().is_some_and(|d| d != digest);
            let before = pin.last_summary.clone();
            pin.last_run_ms = Some(now_ms());
            pin.last_digest = Some(digest);
            pin.last_summary = Some(summary.clone());
            pin.stale_reason = None;
            changed.then(|| ChangedPin {
                id: pin.id.clone(),
                question: pin.question.clone(),
                before,
                after: summary,
            })
        }
        Err(e) => {
            pin.last_run_ms = Some(now_ms());
            pin.stale_reason = Some(e);
            None
        }
    }
}

/// Recheck every pin sequentially (≤20 local queries) and persist the new
/// digests. Returns the pins whose computed result changed.
pub async fn recheck_all() -> Vec<ChangedPin> {
    let mut pins = list();
    if pins.is_empty() {
        return Vec::new();
    }
    let mut changed = Vec::new();
    for p in &mut pins {
        if let Some(c) = recheck_pin(p).await {
            changed.push(c);
        }
    }
    save(&pins);
    changed
}

/// Recheck a single pin (used to prime a fresh pin's summary on add).
pub async fn recheck_one(id: &str) -> Option<ChangedPin> {
    let mut pins = list();
    let idx = pins.iter().position(|p| p.id == id)?;
    let changed = recheck_pin(&mut pins[idx]).await;
    save(&pins);
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_are_compact_rows() {
        let md = "| region | total |\n| --- | --- |\n| NE | 125 |\n| NW | 50 |\n| SE | 10 |\n| SW | 1 |";
        assert_eq!(summarize(md), "NE 125 · NW 50 · SE 10");
        // Degrades to the first line when there's no table.
        assert_eq!(summarize("plain text answer"), "plain text answer");
    }

    #[test]
    fn pin_ids_are_stable_per_sql() {
        assert_eq!(pin_id("SELECT 1"), pin_id("SELECT 1"));
        assert_ne!(pin_id("SELECT 1"), pin_id("SELECT 2"));
    }
}
