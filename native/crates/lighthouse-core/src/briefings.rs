//! Briefings: a titled selection of pinned questions composed into one report
//! (openspec: add-briefings).
//!
//! A briefing references pins by id and, when run, re-executes each pin's stored
//! SQL through the SAME guarded, model-free path pins rechecks use
//! (`analytics::run_direct`) and composes the results into one markdown report.
//! Every number in a briefing therefore comes from a VERIFIED query result, not
//! model text — the same trust invariant pins and charts hold.
//!
//! A briefing carries an optional cadence (daily/weekly). The desktop shell owns
//! the timer; the engine exposes the pure `due()` decision it polls, so the
//! scheduling logic is testable without a clock.
//!
//! PARITY: composition runs DataFusion (Rust-engine-only). The TS twin
//! (src/server/briefings.ts, KEEP IN SYNC) implements CRUD + `due` and composes
//! from each pin's last known summary, since it can't re-run the SQL.

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::config::{now_ms, state_dir};

/// A working set of briefings, not a reporting suite.
pub const MAX_BRIEFINGS: usize = 20;

const DAY_MS: i64 = 86_400_000;
const WEEK_MS: i64 = 7 * DAY_MS;

/// Serializes load-modify-save on the store (mirrors pins' STORE_LOCK).
fn store_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// How often a briefing wants to be regenerated. `Manual` never comes due on
/// its own — the user runs it from the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Cadence {
    #[default]
    Manual,
    Daily,
    Weekly,
}

impl Cadence {
    fn interval_ms(self) -> Option<i64> {
        match self {
            Cadence::Manual => None,
            Cadence::Daily => Some(DAY_MS),
            Cadence::Weekly => Some(WEEK_MS),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Briefing {
    pub id: String,
    pub title: String,
    /// Pin ids to include, in report order.
    pub pin_ids: Vec<String>,
    #[serde(default)]
    pub cadence: Cadence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ms: Option<i64>,
    pub created_ms: i64,
}

/// One question's slot in a composed report: the question and its current
/// result markdown, or an `error` when the pin is gone or its query failed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingSection {
    pub question: String,
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A freshly composed briefing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingReport {
    pub id: String,
    pub title: String,
    pub generated_ms: i64,
    pub sections: Vec<BriefingSection>,
}

fn briefings_path() -> PathBuf {
    state_dir().join("briefings.json")
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    briefings: Vec<Briefing>,
}

/// All briefings, oldest first. A missing or corrupt store reads as empty.
pub fn list() -> Vec<Briefing> {
    std::fs::read_to_string(briefings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Store>(&s).ok())
        .map(|s| s.briefings)
        .unwrap_or_default()
}

fn save(briefings: &[Briefing]) {
    let path = briefings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&Store { briefings: briefings.to_vec() }) {
        // Atomic temp+rename: a crash mid-write must never truncate the store,
        // since list() reads a corrupt file as empty (silent data loss).
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Stable id from the (lowercased) title, so saving the same-titled briefing
/// replaces it rather than duplicating — the FE edits by re-saving.
fn briefing_id(title: &str) -> String {
    let digest = Sha1::digest(title.to_lowercase().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("brief-{}", &hex[..12])
}

/// Create or replace a briefing. Fails past the cap or on empty input with a
/// human-readable reason.
pub fn add(title: &str, pin_ids: &[String], cadence: Cadence) -> Result<Briefing, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("a briefing needs a title".to_string());
    }
    let pin_ids: Vec<String> = pin_ids.iter().filter(|p| !p.trim().is_empty()).cloned().collect();
    if pin_ids.is_empty() {
        return Err("a briefing needs at least one pinned question".to_string());
    }
    let _guard = store_lock();
    let mut briefings = list();
    let id = briefing_id(title);
    // Preserve created_ms/last_run when replacing an existing briefing.
    let existing = briefings.iter().find(|b| b.id == id).cloned();
    briefings.retain(|b| b.id != id);
    if briefings.len() >= MAX_BRIEFINGS {
        return Err(format!(
            "briefing limit reached ({MAX_BRIEFINGS}) — remove one first"
        ));
    }
    let briefing = Briefing {
        id,
        title: title.to_string(),
        pin_ids,
        cadence,
        last_run_ms: existing.as_ref().and_then(|b| b.last_run_ms),
        created_ms: existing.map(|b| b.created_ms).unwrap_or_else(now_ms),
    };
    briefings.push(briefing.clone());
    save(&briefings);
    Ok(briefing)
}

/// Remove a briefing by id (idempotent).
pub fn remove(id: &str) {
    let _guard = store_lock();
    let mut briefings = list();
    briefings.retain(|b| b.id != id);
    save(&briefings);
}

/// Stamp a briefing as run now (called after a successful compose).
fn mark_run(id: &str) {
    let _guard = store_lock();
    let mut briefings = list();
    if let Some(b) = briefings.iter_mut().find(|b| b.id == id) {
        b.last_run_ms = Some(now_ms());
        save(&briefings);
    }
}

/// Briefings due to regenerate at `now`: a scheduled briefing never run, or one
/// whose cadence interval has elapsed since its last run. Pure — the shell
/// timer passes the clock so this is testable without one.
pub fn due(now: i64) -> Vec<String> {
    list()
        .into_iter()
        .filter_map(|b| {
            let interval = b.cadence.interval_ms()?;
            match b.last_run_ms {
                None => Some(b.id),
                Some(last) if now.saturating_sub(last) >= interval => Some(b.id),
                _ => None,
            }
        })
        .collect()
}

/// Run a briefing now: re-execute each referenced pin's SQL and compose the
/// results. `None` when the id is unknown. A removed pin or a failed query
/// becomes an error section rather than sinking the whole report.
pub async fn run(id: &str) -> Option<BriefingReport> {
    let briefing = list().into_iter().find(|b| b.id == id)?;
    let pins = crate::pins::list();
    let mut sections = Vec::with_capacity(briefing.pin_ids.len());
    for pid in &briefing.pin_ids {
        match pins.iter().find(|p| &p.id == pid) {
            None => sections.push(BriefingSection {
                question: format!("(removed pin {pid})"),
                markdown: String::new(),
                error: Some("this pinned question was removed".to_string()),
            }),
            Some(pin) => match crate::analytics::run_direct(&pin.sql, &pin.file_ids).await {
                Ok(res) => sections.push(BriefingSection {
                    question: pin.question.clone(),
                    markdown: res.markdown,
                    error: None,
                }),
                Err(e) => sections.push(BriefingSection {
                    question: pin.question.clone(),
                    markdown: String::new(),
                    error: Some(e),
                }),
            },
        }
    }
    mark_run(id);
    Some(BriefingReport {
        id: briefing.id,
        title: briefing.title,
        generated_ms: now_ms(),
        sections,
    })
}

/// Render a report as a standalone markdown document (the exportable artifact).
/// Callers prepend a human-formatted generation time from `generated_ms`.
pub fn render_markdown(report: &BriefingReport) -> String {
    let mut out = format!("# {}\n", report.title);
    for s in &report.sections {
        out.push_str(&format!("\n## {}\n\n", s.question));
        match &s.error {
            Some(e) => out.push_str(&format!("_{e}_\n")),
            None if s.markdown.trim().is_empty() => out.push_str("_no rows_\n"),
            None => {
                out.push_str(s.markdown.trim_end());
                out.push('\n');
            }
        }
    }
    out
}

// --- Briefing NOTE (G5, openspec: add-briefing-note) -------------------------
//
// A single, refreshed-in-place markdown note ("Lighthouse Briefing.md" under
// "Lighthouse Notes/") composed from the pins that changed since the last note.
// The composer is deterministic and model-free — every value is a pin's VERIFIED
// before/after summary. The desktop shell writes it on pin change at most once
// per user-set daily hour; the pins dialog can refresh it on demand.

/// Escape a cell for a GFM table row (only the pipe can break a row).
fn esc_cell(s: &str) -> String {
    s.replace('|', "\\|")
}

/// Render the "Lighthouse Briefing" note from the pins that changed since the
/// last note: one before→after table per pin, a freshness footer. Deterministic,
/// NO model call. `now_ms` stamps the footer (UTC, so it is TZ-independent and
/// byte-reproducible). KEEP BYTE-IDENTICAL with src/server/briefings.ts::
/// composeBriefingNote.
pub fn compose_briefing_note(changed: &[crate::pins::ChangedPin], now_ms: i64) -> String {
    let mut out = String::from("# Lighthouse Briefing\n");
    if changed.is_empty() {
        out.push_str("\n_No pinned questions changed since the last check._\n");
    } else {
        for c in changed {
            let before = c.before.as_deref().unwrap_or("—");
            out.push_str(&format!(
                "\n## {}\n\n|        | Value |\n| ------ | ----- |\n| Before | {} |\n| Now | {} |\n",
                esc_cell(&c.question),
                esc_cell(before),
                esc_cell(&c.after),
            ));
        }
    }
    let stamp = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    out.push_str(&format!(
        "\n*As of {stamp}. Every value is computed directly from your files — no AI.*\n"
    ));
    out
}

/// True when a scheduled note may be written now: the LOCAL hour is at or past
/// `hour` AND the note hasn't been written yet today (never written, or last
/// written on an earlier local day). `chrono::Local`, so "9" means the user's
/// 9am. Pure — the desktop timer polls it; testable without a real clock.
pub fn note_due(last_note_ms: Option<i64>, now_ms: i64, hour: u32) -> bool {
    use chrono::{Datelike, Local, TimeZone, Timelike};
    let Some(now) = Local.timestamp_millis_opt(now_ms).single() else {
        return false;
    };
    if now.hour() < hour {
        return false;
    }
    match last_note_ms.and_then(|m| Local.timestamp_millis_opt(m).single()) {
        None => true, // never written, and it's past the hour today
        Some(last) => (last.year(), last.ordinal()) < (now.year(), now.ordinal()),
    }
}

fn note_state_path() -> PathBuf {
    state_dir().join("briefing-note.json")
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NoteState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_note_ms: Option<i64>,
}

/// When the scheduled briefing note was last written (state/briefing-note.json).
/// Kept engine-side (not in settings) so the daily gate is in-container testable.
pub fn last_note_ms() -> Option<i64> {
    std::fs::read_to_string(note_state_path())
        .ok()
        .and_then(|s| serde_json::from_str::<NoteState>(&s).ok())
        .and_then(|s| s.last_note_ms)
}

/// Persist the note's last-written time (atomic temp+rename, like the store).
pub fn mark_note_run(now_ms: i64) {
    let _guard = store_lock();
    let path = note_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&NoteState { last_note_ms: Some(now_ms) }) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// VAULT_DIR is process-global — serialize the store-touching tests.
    fn test_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn with_temp_vault(f: impl FnOnce()) {
        let _guard = test_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("VAULT_DIR", dir.path());
        // Start from an empty store every time.
        let _ = std::fs::remove_file(briefings_path());
        f();
        std::env::remove_var("VAULT_DIR");
    }

    #[test]
    fn crud_and_replace_by_title() {
        with_temp_vault(|| {
            assert!(list().is_empty());
            let b = add("Weekly Sales", &["pin-a".into(), "pin-b".into()], Cadence::Weekly).unwrap();
            assert_eq!(b.pin_ids.len(), 2);
            assert_eq!(list().len(), 1);

            // Same title (case-insensitive) replaces, preserving created_ms.
            let created = b.created_ms;
            let b2 = add("weekly sales", &["pin-c".into()], Cadence::Daily).unwrap();
            assert_eq!(b2.id, b.id, "same title → same id → replace");
            assert_eq!(b2.created_ms, created, "created_ms preserved on edit");
            assert_eq!(list().len(), 1);
            assert_eq!(list()[0].pin_ids, vec!["pin-c"]);
            assert_eq!(list()[0].cadence, Cadence::Daily);

            remove(&b.id);
            assert!(list().is_empty());
        });
    }

    #[test]
    fn rejects_empty_and_over_cap() {
        with_temp_vault(|| {
            assert!(add("", &["pin-a".into()], Cadence::Manual).is_err());
            assert!(add("Has no pins", &[], Cadence::Manual).is_err());
            for i in 0..MAX_BRIEFINGS {
                add(&format!("b{i}"), &["pin-a".into()], Cadence::Manual).unwrap();
            }
            assert!(
                add("one too many", &["pin-a".into()], Cadence::Manual).is_err(),
                "cap enforced"
            );
        });
    }

    #[test]
    fn due_respects_cadence_and_last_run() {
        with_temp_vault(|| {
            add("manual", &["p".into()], Cadence::Manual).unwrap();
            add("daily", &["p".into()], Cadence::Daily).unwrap();
            let now = now_ms();

            // Never-run scheduled briefings are due; manual ones never are.
            let due_ids = due(now);
            assert_eq!(due_ids.len(), 1, "only the daily is due: {due_ids:?}");
            assert_eq!(due_ids[0], briefing_id("daily"));

            // Mark the daily as just run → no longer due; still due a day later.
            mark_run(&briefing_id("daily"));
            assert!(due(now_ms()).is_empty(), "just-run daily isn't due");
            assert_eq!(due(now + DAY_MS + 1000).len(), 1, "due again after a day");
        });
    }

    #[tokio::test]
    async fn run_marks_missing_pins_without_sinking_the_report() {
        with_temp_vault(|| {}); // isolate; set VAULT_DIR for the async body below
        let _guard = test_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("VAULT_DIR", dir.path());
        let _ = std::fs::remove_file(briefings_path());

        add("Q3", &["pin-missing".into()], Cadence::Manual).unwrap();
        let report = run(&briefing_id("Q3")).await.expect("known id runs");
        assert_eq!(report.sections.len(), 1);
        assert!(report.sections[0].error.is_some(), "missing pin → error section");
        assert!(run("brief-nope").await.is_none(), "unknown id → None");

        // A run stamps last_run_ms so the schedule advances.
        assert!(list()[0].last_run_ms.is_some());
        std::env::remove_var("VAULT_DIR");
    }

    #[test]
    fn render_markdown_shapes_sections() {
        let report = BriefingReport {
            id: "b".into(),
            title: "My Briefing".into(),
            generated_ms: 0,
            sections: vec![
                BriefingSection {
                    question: "Revenue by region".into(),
                    markdown: "| R | v |\n| - | - |\n| NE | 1 |".into(),
                    error: None,
                },
                BriefingSection {
                    question: "Gone".into(),
                    markdown: String::new(),
                    error: Some("this pinned question was removed".into()),
                },
            ],
        };
        let md = render_markdown(&report);
        assert!(md.starts_with("# My Briefing\n"));
        assert!(md.contains("## Revenue by region"));
        assert!(md.contains("| NE | 1 |"));
        assert!(md.contains("_this pinned question was removed_"));
    }

    // --- G5 briefing note ---------------------------------------------------

    fn changed(id: &str, q: &str, before: Option<&str>, after: &str) -> crate::pins::ChangedPin {
        crate::pins::ChangedPin {
            id: id.into(),
            question: q.into(),
            before: before.map(String::from),
            after: after.into(),
        }
    }

    #[test]
    fn compose_note_renders_before_after_tables_and_footer() {
        // now_ms = 2026-07-15 09:03:00 UTC (1_784_106_180_000).
        let now = 1_784_106_180_000i64;
        let md = compose_briefing_note(
            &[
                changed("p1", "Revenue by region", Some("NE 120 · SE 300"), "NE 150 · SE 480"),
                changed("p2", "New signups", None, "42"),
            ],
            now,
        );
        assert!(md.starts_with("# Lighthouse Briefing\n"));
        assert!(md.contains("## Revenue by region"));
        assert!(md.contains("| Before | NE 120 · SE 300 |"));
        assert!(md.contains("| Now | NE 150 · SE 480 |"));
        // A pin with no prior summary renders "—" for Before.
        assert!(md.contains("## New signups"));
        assert!(md.contains("| Before | — |"));
        assert!(md.contains("| Now | 42 |"));
        // Deterministic UTC footer + the "no AI" honesty line.
        assert!(md.contains("*As of 2026-07-15 09:03 UTC."));
        assert!(md.contains("no AI"));
    }

    #[test]
    fn compose_note_empty_set_is_coherent() {
        let md = compose_briefing_note(&[], 1_784_106_180_000);
        assert!(md.starts_with("# Lighthouse Briefing\n"));
        assert!(md.contains("_No pinned questions changed since the last check._"));
        assert!(md.contains("no AI"));
    }

    #[test]
    fn note_due_gates_on_hour_and_day() {
        use chrono::{Local, TimeZone};
        // Build local timestamps so the assertions are TZ-independent.
        let at = |y, mo, d, h, mi| {
            Local
                .with_ymd_and_hms(y, mo, d, h, mi, 0)
                .single()
                .unwrap()
                .timestamp_millis()
        };
        let hour = 9u32;
        // Before the hour: not due, even if never written.
        assert!(!note_due(None, at(2026, 7, 15, 8, 0), hour));
        // At/after the hour, never written: due.
        assert!(note_due(None, at(2026, 7, 15, 9, 30), hour));
        // Written earlier the SAME day: not due again.
        let today_9 = at(2026, 7, 15, 9, 5);
        assert!(!note_due(Some(today_9), at(2026, 7, 15, 15, 0), hour));
        // Written yesterday: due again today after the hour.
        let yesterday = at(2026, 7, 14, 9, 5);
        assert!(note_due(Some(yesterday), at(2026, 7, 15, 9, 5), hour));
    }

    #[test]
    fn note_state_round_trips() {
        with_temp_vault(|| {
            assert_eq!(last_note_ms(), None);
            mark_note_run(1_784_106_180_000);
            assert_eq!(last_note_ms(), Some(1_784_106_180_000));
        });
    }
}
