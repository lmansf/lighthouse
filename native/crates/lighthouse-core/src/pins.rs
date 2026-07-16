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
//! implements CRUD only — rechecks need DataFusion, which is Rust-engine-only
//! (PARITY).

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir};

/// Serializes every load-modify-save on the store (adds, removes, recheck
/// merges). Never held across an await — rechecks snapshot under the lock,
/// run their queries unlocked, then merge under the lock again.
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn store_lock() -> MutexGuard<'static, ()> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    /// The investigation this pin belongs to (openspec: add-investigations):
    /// the SINGLE source of truth for pin membership — the investigation view
    /// derives its `pinRefs` from this field at read time, never the other
    /// way round. Serde-default so pins written before the field existed load
    /// unchanged and stay uncategorized; skipped when absent so their store
    /// round-trips byte-identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub investigation_id: Option<String>,
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

/// The `listPins` op's read: `Some(id)` filters to the pins carrying that
/// investigation (openspec: add-investigations); `None` is the unchanged
/// "all" behavior — byte-identical to `list()`. KEEP IN SYNC with
/// src/server/pins.ts::listPins.
pub fn list_for(investigation_id: Option<&str>) -> Vec<Pin> {
    let pins = list();
    match investigation_id {
        None => pins,
        Some(id) => pins
            .into_iter()
            .filter(|p| p.investigation_id.as_deref() == Some(id))
            .collect(),
    }
}

fn save(pins: &[Pin]) {
    let path = pins_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&Store { pins: pins.to_vec() }) {
        // Atomic temp+rename: a crash mid-write must never leave truncated
        // JSON, because list() treats a corrupt store as empty (data loss).
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
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
/// `investigation_id` (openspec: add-investigations) records the current
/// investigation on the pin — blank/absent leaves it uncategorized, and a
/// re-pin adopts the NEW ask's investigation (replace semantics, like every
/// other field). The id is stored as given, dangling-tolerant like scope
/// file ids: an id naming nothing simply never matches a derived view.
pub fn add(
    question: &str,
    sql: &str,
    file_ids: &[String],
    investigation_id: Option<&str>,
) -> Result<Pin, String> {
    let question = question.trim();
    let sql = sql.trim();
    if question.is_empty() || sql.is_empty() {
        return Err("a pin needs the question and its SQL".to_string());
    }
    let _guard = store_lock();
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
        investigation_id: investigation_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };
    pins.push(pin.clone());
    save(&pins);
    Ok(pin)
}

/// Remove a pin by id (idempotent).
pub fn remove(id: &str) {
    let _guard = store_lock();
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

/// Re-run one pin in place. The alert (`Some` = the result digest CHANGED
/// since the last run; a first run only primes the digest — nothing to
/// compare yet, no alert) rides alongside the full deterministic result:
/// boards' refresh (openspec: add-boards) renders the rows/chart/footer
/// that rechecks deliberately never persist, and returning them from the
/// ONE execution keeps a board refresh from running every query twice.
/// Errors mark the pin stale (reason kept) and never alert.
async fn recheck_pin(
    pin: &mut Pin,
) -> (
    Option<ChangedPin>,
    Result<crate::analytics::DirectResult, String>,
) {
    match crate::analytics::run_direct(&pin.sql, &pin.file_ids).await {
        Ok(res) => {
            // Full-fidelity digest (the whole execution-capped result), NOT
            // the narration-clipped markdown — a change in row 45 of 60 must
            // alert even though the narration only carries the first 40 rows.
            let digest = res.result_digest.clone();
            let summary = summarize(&res.markdown);
            let changed = pin.last_digest.as_deref().is_some_and(|d| d != digest);
            let before = pin.last_summary.clone();
            pin.last_run_ms = Some(now_ms());
            pin.last_digest = Some(digest);
            pin.last_summary = Some(summary.clone());
            pin.stale_reason = None;
            (
                changed.then(|| ChangedPin {
                    id: pin.id.clone(),
                    question: pin.question.clone(),
                    before,
                    after: summary,
                }),
                Ok(res),
            )
        }
        Err(e) => {
            pin.last_run_ms = Some(now_ms());
            pin.stale_reason = Some(e.clone());
            (None, Err(e))
        }
    }
}

/// Recheck every pin sequentially (≤20 local queries) and persist the new
/// digests. Returns the pins whose computed result changed.
///
/// The snapshot is taken under the store lock, the (potentially slow) queries
/// run UNLOCKED, and the recomputed state is then merged onto a fresh load BY
/// ID — so a pin added mid-pass is kept, a pin removed mid-pass stays removed
/// (and never alerts), and nothing is clobbered by the pass's stale snapshot.
pub async fn recheck_all() -> Vec<ChangedPin> {
    let mut snapshot = {
        let _guard = store_lock();
        list()
    };
    if snapshot.is_empty() {
        return Vec::new();
    }
    let mut changed = Vec::new();
    for p in &mut snapshot {
        if let (Some(c), _) = recheck_pin(p).await {
            changed.push(c);
        }
    }
    let merged: std::collections::HashSet<String> = {
        let _guard = store_lock();
        let mut current = list();
        let mut merged = std::collections::HashSet::new();
        for c in &mut current {
            if let Some(updated) = snapshot.iter().find(|u| u.id == c.id) {
                // Copy back ONLY the recheck outputs, and only when the pin is
                // the same instance we rechecked — a re-pin mid-pass resets
                // created_ms / file_ids, and its digest was computed against
                // the OLD state, so applying it (or overwriting the edited
                // question/files with the stale snapshot) would be wrong.
                if c.created_ms == updated.created_ms && c.file_ids == updated.file_ids {
                    c.last_run_ms = updated.last_run_ms;
                    c.last_digest = updated.last_digest.clone();
                    c.last_summary = updated.last_summary.clone();
                    c.stale_reason = updated.stale_reason.clone();
                    merged.insert(c.id.clone());
                }
            }
        }
        save(&current);
        merged
    };
    // Only pins we actually re-primed can alert (a re-pinned/removed pin's
    // alert was computed against stale data — drop it).
    changed.retain(|c| merged.contains(&c.id));
    changed
}

/// Merge one re-run pin's outputs back onto a fresh load — the guard
/// `recheck_all` applies per pin, factored for the single-pin paths: copy
/// ONLY the recheck outputs, and only when the pin wasn't removed or
/// re-pinned (same created_ms / file_ids) while the query ran. `false` =
/// the update was dropped and nothing was saved.
fn merge_recheck(pin: &Pin) -> bool {
    let _guard = store_lock();
    let mut current = list();
    let mut merged = false;
    for c in &mut current {
        if c.id == pin.id && c.created_ms == pin.created_ms && c.file_ids == pin.file_ids {
            c.last_run_ms = pin.last_run_ms;
            c.last_digest = pin.last_digest.clone();
            c.last_summary = pin.last_summary.clone();
            c.stale_reason = pin.stale_reason.clone();
            merged = true;
        }
    }
    if merged {
        save(&current);
    }
    merged
}

/// Recheck a single pin (used to prime a fresh pin's summary on add). Merges
/// like `recheck_all`: if the pin was removed while its query ran, the update
/// is dropped and nothing alerts.
pub async fn recheck_one(id: &str) -> Option<ChangedPin> {
    let mut pin = {
        let _guard = store_lock();
        list().into_iter().find(|p| p.id == id)
    }?;
    let (changed, _) = recheck_pin(&mut pin).await;
    if !merge_recheck(&pin) {
        return None; // removed or re-pinned while the query ran
    }
    changed
}

/// One pin's guarded re-execution WITH its full deterministic result — the
/// boards refresh path (openspec: add-boards). A manual board refresh IS a
/// recheck: the same `run_direct` guard, the same `summarize`, the same
/// digest/summary/lastRun/staleReason write-back (merged under the
/// `recheck_all` guard) — plus the rows/chart/footer the recheck loop
/// deliberately never persists, returned to the caller for rendering.
/// `None` = no such pin (the caller renders a tombstone). A pin removed or
/// re-pinned while the query ran keeps the store untouched (merge dropped)
/// but still answers with what was computed — the next refresh tombstones.
pub async fn refresh_one(
    id: &str,
) -> Option<(Pin, Result<crate::analytics::DirectResult, String>)> {
    let mut pin = {
        let _guard = store_lock();
        list().into_iter().find(|p| p.id == id)
    }?;
    let (_, outcome) = recheck_pin(&mut pin).await;
    let _ = merge_recheck(&pin);
    Some((pin, outcome))
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
