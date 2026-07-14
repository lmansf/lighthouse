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
}
