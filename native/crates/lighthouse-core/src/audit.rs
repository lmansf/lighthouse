//! Local audit log (openspec: add-audit-log, S2) — a tamper-evident,
//! append-only, local-only record answering "what did the AI read, what left
//! the machine, and when." One JSONL record per answered question, written at
//! the transport choke point (see design D1). Off by default; on by the
//! `audit_enabled` setting or the managed policy key `auditLog: "on"`.
//!
//! Each record chains an HMAC-SHA256 to the previous record (key derived from
//! the install secrets store), so editing any record breaks verification from
//! that point on. A link binds a record only to its PREDECESSOR, though, so any
//! PREFIX of a valid chain is itself a valid chain — dropping the newest N
//! records, or the whole file, would recompute perfectly (red-team:
//! audit-anchor). `audit/head.json` narrows that: the chain's LENGTH and head
//! hmac are anchored OUTSIDE the log, keyed the same way, so truncating or
//! deleting the log fails verification and keeps failing across later appends.
//! Detective control, not anti-root DRM (the doc states the threat model) —
//! and honestly bounded: deleting or corrupting head.json ALONE re-opens
//! truncation permanently (an absent anchor fails open so pre-anchor logs stay
//! honest, and the next append then re-anchors the shortened log), only the
//! ACTIVE month is anchored, and an attacker who controls the clock can retire
//! the anchor to a future month. It raises the cost of casual tampering; it
//! does not stop a determined local attacker.
//!
//! KEEP IN SYNC with src/server/audit.ts (same record shape at the same
//! choke point; the TS twin omits the HMAC chain — PARITY, it is not a
//! security surface).

use std::io::Write as _;
use std::path::PathBuf;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::config::{app_state_dir, now_ms, write_json};
use crate::contracts::{ChunkMeta, CostMeta};

type HmacSha256 = Hmac<Sha256>;

const HMAC_LABEL: &str = "lighthouse-audit-hmac-v1";
/// Key label for the out-of-log anchor — separate from the record label so an
/// anchor hmac can never be replayed as a record hmac, or the reverse.
const HEAD_LABEL: &str = "lighthouse-audit-head-v1";
/// The first record chains to this fixed genesis instead of a prior hmac.
const GENESIS: &str = "genesis";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub ts: i64,
    pub question_sha256: String,
    /// Verbatim question text — present ONLY when auditVerbatim is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub file_ids: Vec<String>,
    pub provider: String,
    /// `["none"]` or the hosts newly contacted answering this question.
    pub egress: Vec<String>,
    pub artifacts: Vec<String>,
    /// The NEW cost this answer incurred (openspec: add-beam-loop §3.2): the
    /// per-ask cost meter, so a running total can be derived across records.
    /// Absent for a cache REPLAY (0 new tokens / $0 — it computed nothing) and
    /// for older records written before the meter existed; a local answer
    /// carries its tokens with `$0.00`, an unreported one stays `reported:false`.
    /// NOT part of the HMAC chain below — the chain protects the privacy/egress
    /// ledger ("what the AI read, what left the machine"); cost is a derived,
    /// informational estimate, and keeping it outside keeps pre-cost records
    /// verifying byte-for-byte after the upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<CostMeta>,
    pub prev_hmac: String,
    pub hmac: String,
}

/// What the choke point assembles; the chain fields are filled by `append`.
pub struct AuditInput {
    pub question: String,
    pub include_verbatim: bool,
    pub file_ids: Vec<String>,
    pub provider: String,
    pub egress: Vec<String>,
    pub artifacts: Vec<String>,
    /// The NEW cost this answer incurred (openspec: add-beam-loop §3.2); None
    /// for a cache replay (0 new) or when the meter is unavailable.
    pub cost: Option<CostMeta>,
}

/// The NEW cost an answered question incurred, read from its final chunk's
/// provenance stamp for the cumulative running total (openspec: add-beam-loop
/// §3.2/§3.3). A live answer's metered cost; a cache REPLAY (its final chunk
/// carries `cached_at`) computed nothing, so its NEW cost is 0 — returned as
/// None so the running total never double-counts a replayed answer.
pub fn ask_new_cost(meta: &ChunkMeta) -> Option<CostMeta> {
    if meta.cached_at.is_some() {
        return None;
    }
    meta.cost.clone()
}

fn audit_dir() -> PathBuf {
    app_state_dir().join("audit")
}

/// Month-bucketed file; the ts prefix keeps files bounded without a rotation
/// daemon. Test override so the suite doesn't touch a real install.
fn audit_path() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("LIGHTHOUSE_AUDIT_FILE") {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    audit_dir().join(format!("audit-{}.jsonl", month_stamp()))
}

/// `YYYY-MM` from the current time (no chrono dep — integer date math).
fn month_stamp() -> String {
    // Days since the Unix epoch → civil year/month (Howard Hinnant's algo).
    let days = now_ms() / 86_400_000;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}")
}

/// True when a record should be written (setting or policy).
pub fn enabled() -> bool {
    crate::settings::read_desktop_settings().audit_enabled == Some(true)
        || crate::policy::audit_forced_on()
}

fn hmac_key() -> [u8; 32] {
    crate::secrets::derived_key(HMAC_LABEL)
}

fn head_key() -> [u8; 32] {
    crate::secrets::derived_key(HEAD_LABEL)
}

/// HMAC-SHA256 over the record's canonical bytes (everything but `hmac`) plus
/// the previous hmac — the chain link.
fn compute_hmac(rec: &AuditRecord) -> String {
    let mut mac = HmacSha256::new_from_slice(&hmac_key()).expect("hmac key");
    let canonical = serde_json::json!({
        "ts": rec.ts,
        "questionSha256": rec.question_sha256,
        "question": rec.question,
        "fileIds": rec.file_ids,
        "provider": rec.provider,
        "egress": rec.egress,
        "artifacts": rec.artifacts,
        "prevHmac": rec.prev_hmac,
    });
    mac.update(canonical.to_string().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The chain's head, anchored OUTSIDE the log (red-team: audit-anchor). A link
/// binds a record only to its predecessor, so a truncated log re-chains
/// perfectly; pinning the LENGTH and the head hmac in a separate file is what
/// makes dropping records — or the whole file — visible. `hmac` covers the
/// other three fields, so editing the anchor to match a shortened log costs the
/// install key, exactly like forging a record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditHead {
    month: String,
    count: usize,
    last_hmac: String,
    hmac: String,
}

/// One anchor per install, beside the month files, describing the ACTIVE month.
/// Anchored to `audit_path()`'s directory, not `audit_dir()`, so the test
/// override keeps the anchor next to the log it describes (identical in
/// production, where `audit_path().parent() == audit_dir()`).
fn head_path() -> PathBuf {
    audit_path()
        .parent()
        .map(|d| d.join("head.json"))
        .unwrap_or_else(|| audit_dir().join("head.json"))
}

/// HMAC-SHA256 over the anchor's canonical bytes (everything but `hmac`).
fn compute_head_hmac(head: &AuditHead) -> String {
    let mut mac = HmacSha256::new_from_slice(&head_key()).expect("hmac key");
    let canonical = serde_json::json!({
        "month": head.month,
        "count": head.count,
        "lastHmac": head.last_hmac,
    });
    mac.update(canonical.to_string().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The anchor as stored — `None` when absent or unreadable. Callers decide what
/// a stale or unauthenticated one means.
fn read_head() -> Option<AuditHead> {
    let text = std::fs::read_to_string(head_path()).ok()?;
    serde_json::from_str::<AuditHead>(&text).ok()
}

/// Anchor the new length + head after a record lands. Atomic and 0600 via the
/// same helper settings and secrets use; best-effort, like the append itself.
fn write_head(count: usize, last_hmac: &str) {
    let mut head = AuditHead {
        month: month_stamp(),
        count,
        last_hmac: last_hmac.to_string(),
        hmac: String::new(),
    };
    head.hmac = compute_head_hmac(&head);
    let path = head_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    write_json(&path, &head);
}

/// The count to anchor after appending onto a file that held `file_count`
/// records: one more than the file, but never fewer than one more than the
/// anchor already claims. Monotone on purpose — after a truncation the anchor
/// keeps counting, so the next legitimate append RECORDS the gap instead of
/// re-blessing the shortened log.
fn next_count(file_count: usize) -> usize {
    let anchored = read_head()
        .filter(|h| h.month == month_stamp() && h.hmac == compute_head_hmac(h))
        .map(|h| h.count)
        .unwrap_or(0);
    file_count.max(anchored) + 1
}

/// The active file's tail: the hmac the next record chains to (GENESIS when the
/// file is absent or holds no record), and how many records it holds.
fn tail() -> (String, usize) {
    let path = audit_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (GENESIS.to_string(), 0);
    };
    let mut last = GENESIS.to_string();
    let mut count = 0usize;
    for line in text.lines() {
        if let Ok(rec) = serde_json::from_str::<AuditRecord>(line) {
            last = rec.hmac;
            count += 1;
        }
    }
    (last, count)
}

/// Append one record for an answered question. Best-effort and gated: does
/// nothing when disabled, and a write failure is swallowed (the answer is
/// already in the user's hands — the log must never fail a question).
pub fn append(input: AuditInput) {
    if !enabled() {
        return;
    }
    let question_sha256 = {
        use sha2::Digest;
        hex::encode(Sha256::digest(input.question.as_bytes()))
    };
    let (prev, file_count) = tail();
    let mut rec = AuditRecord {
        ts: now_ms(),
        question_sha256,
        question: input.include_verbatim.then_some(input.question),
        file_ids: input.file_ids,
        provider: input.provider,
        egress: if input.egress.is_empty() {
            vec!["none".to_string()]
        } else {
            input.egress
        },
        artifacts: input.artifacts,
        cost: input.cost,
        prev_hmac: prev,
        hmac: String::new(),
    };
    rec.hmac = compute_hmac(&rec);

    let path = audit_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let line = match serde_json::to_string(&rec) {
        Ok(l) => l,
        Err(_) => return,
    };
    // Append 0600. O_APPEND makes concurrent single-line writes atomic.
    let opened = {
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&path)
    };
    if let Ok(mut f) = opened {
        // Anchor the new length + head OUTSIDE the log (red-team: audit-anchor),
        // and only once the record is really on disk — an anchor running ahead
        // of the log would read as a truncation, so the record is fsynced first
        // (`write_json` below fsyncs the anchor and this directory in turn). A
        // failed sync just skips the anchor: it lags, and `next_count`'s max()
        // heals that on the next append.
        if writeln!(f, "{line}").is_ok() && f.sync_all().is_ok() {
            write_head(next_count(file_count), &rec.hmac);
        }
    }
}

/// The two transport choke points (`chat_ask`, `chat_post`) share this: call
/// `AnswerAudit::start(question)` before driving the answer stream, then
/// `.finish(provider, file_ids, artifacts, cost)` once the final chunk lands. It
/// captures the egress baseline at start and records the per-question delta,
/// so the record's egress reflects exactly what this question sent. `cost` is
/// the NEW cost meter (openspec: add-beam-loop §3.2) — `ask_new_cost(&meta)`,
/// which is None for a cache replay so the running total never double-counts.
/// No-op (cheap) when the log is disabled — `start` still runs so the call sites
/// stay unconditional, but `finish` short-circuits in `append`.
pub struct AnswerAudit {
    question: String,
    egress_before: std::collections::HashMap<String, u64>,
}

impl AnswerAudit {
    pub fn start(question: &str) -> Self {
        Self {
            question: question.to_string(),
            egress_before: crate::egress::host_counts(),
        }
    }

    pub fn finish(
        self,
        provider: &str,
        file_ids: Vec<String>,
        artifacts: Vec<String>,
        cost: Option<CostMeta>,
    ) {
        if !enabled() {
            return;
        }
        let verbatim = crate::settings::read_desktop_settings()
            .extra
            .get("auditVerbatim")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        append(AuditInput {
            question: self.question,
            include_verbatim: verbatim,
            file_ids,
            provider: provider.to_string(),
            egress: crate::egress::hosts_since(&self.egress_before),
            artifacts,
            cost,
        });
    }
}

/// Verify the chain in a file, and — for the ACTIVE month — against the
/// out-of-log anchor. `Ok(n)` = n records, all intact. `Err(i)` = the chain
/// first breaks at record index `i` (0-based); for a truncation or a deletion
/// that is the first record the anchor accounts for that the file no longer has.
pub fn verify(path: &std::path::Path) -> Result<usize, usize> {
    // A missing file is NOT an intact empty chain (red-team: audit-anchor —
    // this used to `return Ok(0)`, so deleting the month certified as intact).
    // Walk it as zero records and let the anchor below return the verdict.
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut prev = GENESIS.to_string();
    let mut count = 0usize;
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<AuditRecord>(line) else {
            return Err(i);
        };
        if rec.prev_hmac != prev || compute_hmac(&rec) != rec.hmac {
            return Err(i);
        }
        prev = rec.hmac.clone();
        count += 1;
    }
    check_anchor(path, count, &prev)?;
    Ok(count)
}

/// Compare a verified chain against the out-of-log anchor: `Err(i)` when the
/// anchor says this file should be LONGER, or should END differently, than it
/// does — i.e. records were truncated away or the file was deleted (red-team:
/// audit-anchor; SECURITY.md's "deleting a record breaks verification"). Only
/// the active month's file is anchored; anything else verifies by chain alone.
fn check_anchor(path: &std::path::Path, count: usize, last: &str) -> Result<(), usize> {
    if path != audit_path() {
        return Ok(());
    }
    // No usable anchor: a log written before anchoring shipped, or an install
    // that has logged nothing yet. Verify by chain alone rather than flag every
    // pre-upgrade log as tampered — the next append anchors it.
    let Some(head) = read_head() else {
        return Ok(());
    };
    // A well-formed anchor that does not authenticate was hand-edited; nothing
    // in the file can be trusted, so the break is reported at the very start.
    if head.hmac != compute_head_hmac(&head) {
        return Err(0);
    }
    // A stale anchor from an earlier month describes a DIFFERENT file: this
    // month's bucket is new, not shortened.
    if head.month != month_stamp() {
        return Ok(());
    }
    if count < head.count {
        // The first record the anchor accounts for that the file no longer has.
        return Err(count);
    }
    // LONGER than anchored is a lagging anchor, not tampering: `append` is
    // best-effort, so a crash between the line and the anchor write leaves it
    // behind (the next append heals it). That direction only ever ADDS records,
    // and forging one still needs the chain key.
    if count == head.count && last != head.last_hmac {
        return Err(count.saturating_sub(1));
    }
    Ok(())
}

/// The running cost total across EVERY logged ask (openspec: add-beam-loop
/// §3.2), summed from each record's per-ask cost meter. Honest: an unreported
/// ask contributes 0 tokens (never a fabricated count), a local ask contributes
/// its tokens with `$0.00`, an unknown-model ask contributes tokens with no
/// dollars, and a cache replay (no `cost` node) contributes nothing.
fn cumulative_cost(records: &[AuditRecord]) -> serde_json::Value {
    let mut input = 0u64;
    let mut output = 0u64;
    let mut total = 0u64;
    let mut usd = 0f64;
    for c in records.iter().filter_map(|r| r.cost.as_ref()) {
        input += c.input_tokens;
        output += c.output_tokens;
        total += c.total_tokens;
        usd += c.cost_estimate_usd.unwrap_or(0.0);
    }
    serde_json::json!({
        "inputTokens": input,
        "outputTokens": output,
        "totalTokens": total,
        "costEstimateUsd": usd,
    })
}

/// The most recent `limit` records (for the viewer), newest first, the
/// chain-intact verdict, and the cumulative cost total across all asks.
pub fn recent(limit: usize) -> serde_json::Value {
    let path = audit_path();
    let intact = verify(&path).is_ok();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut records: Vec<AuditRecord> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Running total over the FULL file, before the recency window truncates.
    let cumulative = cumulative_cost(&records);
    records.reverse();
    records.truncate(limit);
    serde_json::json!({
        "enabled": enabled(),
        "intact": intact,
        "records": records,
        "cumulative": cumulative,
    })
}

/// Verify the active (current-month) file. `{ intact, breakAt, count }` where
/// `breakAt` is -1 when intact — backs the viewer's tamper badge and a
/// dedicated `auditVerify` op (the private path stays encapsulated here).
pub fn verify_active() -> serde_json::Value {
    let path = audit_path();
    match verify(&path) {
        Ok(n) => serde_json::json!({ "intact": true, "breakAt": -1, "count": n }),
        Err(i) => serde_json::json!({ "intact": false, "breakAt": i as i64, "count": i }),
    }
}

/// The full active-month log as CSV, for the security director's records.
/// Only the reporting fields — the HMAC chain columns verify integrity, they
/// aren't data to hand out. Verbatim question is emitted only where stored.
pub fn export_csv() -> String {
    let path = audit_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out = String::from("ts,provider,fileIds,egress,artifacts,question\n");
    for line in text.lines() {
        let Ok(rec) = serde_json::from_str::<AuditRecord>(line) else {
            continue;
        };
        let row = [
            rec.ts.to_string(),
            csv_field(&rec.provider),
            csv_field(&rec.file_ids.join(";")),
            csv_field(&rec.egress.join(";")),
            csv_field(&rec.artifacts.join(";")),
            csv_field(rec.question.as_deref().unwrap_or("")),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// Minimal RFC-4180 field escaping: quote when the value holds a comma, quote,
/// CR, or LF, doubling any inner quote.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// The audit path + settings + policy env are process-global — serialize.
    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    struct Ctx {
        _dir: tempfile::TempDir,
        file: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    fn setup(enabled: bool) -> Ctx {
        let _guard = test_lock();
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", &state);
        let file = dir.path().join("audit.jsonl");
        std::env::set_var("LIGHTHOUSE_AUDIT_FILE", &file);
        // Gate via the settings file so `enabled()` sees our choice.
        let settings = dir.path().join("settings.json");
        std::fs::write(
            &settings,
            if enabled {
                r#"{"auditEnabled":true}"#
            } else {
                "{}"
            },
        )
        .unwrap();
        std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &settings);
        std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
        crate::policy::reset_for_tests();
        Ctx { _dir: dir, file, _guard }
    }
    fn input(q: &str, provider: &str, egress: Vec<String>) -> AuditInput {
        AuditInput {
            question: q.to_string(),
            include_verbatim: false,
            file_ids: vec!["budget.md".to_string()],
            provider: provider.to_string(),
            egress,
            artifacts: vec![],
            cost: None,
        }
    }

    #[test]
    fn disabled_writes_nothing() {
        let c = setup(false);
        append(input("q", "local", vec![]));
        assert!(!c.file.exists(), "no file when disabled");
        assert!(!head_path().exists(), "no anchor while the log is off");
    }

    #[test]
    fn append_then_verify_intact_and_tamper_is_caught() {
        let c = setup(true);
        append(input("cloud question", "openai", vec!["api.openai.com".into()]));
        append(input("local question", "local", vec![]));
        append(input("third", "local", vec![]));

        assert_eq!(verify(&c.file), Ok(3), "chain intact after three appends");

        // Record contents: hash not text (default), egress none for local.
        let text = std::fs::read_to_string(&c.file).unwrap();
        assert!(!text.contains("cloud question"), "verbatim text not stored by default");
        let recs: Vec<AuditRecord> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(recs[0].provider, "openai");
        assert_eq!(recs[0].egress, vec!["api.openai.com"]);
        assert_eq!(recs[1].egress, vec!["none"], "local question logs egress:none");

        // Tamper: rewrite the MIDDLE record's provider on disk.
        let lines: Vec<String> = text.lines().map(String::from).collect();
        let mut mid: AuditRecord = serde_json::from_str(&lines[1]).unwrap();
        mid.provider = "anthropic".to_string(); // edited, hmac now stale
        let tampered = format!(
            "{}\n{}\n{}\n",
            lines[0],
            serde_json::to_string(&mid).unwrap(),
            lines[2]
        );
        std::fs::write(&c.file, tampered).unwrap();
        assert_eq!(verify(&c.file), Err(1), "edit of record 1 is caught at index 1");
    }

    /// Red-team (audit-anchor): each link binds a record only to its
    /// PREDECESSOR, so any PREFIX of a valid chain verifies on its own —
    /// dropping the newest records used to certify as INTACT, leaving the viewer
    /// showing "Chain verified" over a log missing the cloud ask. The out-of-log
    /// anchor pins the LENGTH and the head hmac, so the drop is caught.
    #[test]
    fn truncating_the_tail_is_caught() {
        let c = setup(true);
        append(input("cloud question", "openai", vec!["api.openai.com".into()]));
        append(input("local question", "local", vec![]));
        append(input("third", "local", vec![]));
        assert_eq!(verify(&c.file), Ok(3), "three appends verify");
        assert!(
            head_path().exists(),
            "every append anchors the chain outside the log"
        );

        // Drop the newest TWO records; the surviving prefix re-chains perfectly.
        let text = std::fs::read_to_string(&c.file).unwrap();
        let kept = text.lines().next().unwrap().to_string();
        std::fs::write(&c.file, format!("{kept}\n")).unwrap();

        assert_eq!(verify(&c.file), Err(1), "the anchor names the first missing record");
        let v = verify_active();
        assert_eq!(v["intact"], false, "the badge flips to tampering detected");
        assert_eq!(v["breakAt"], 1);
        assert_eq!(recent(10)["intact"], false, "the log viewer agrees");
    }

    /// Red-team (audit-anchor): deleting the month file used to certify as an
    /// intact EMPTY chain (`verify` returned Ok(0) on a read error), and
    /// re-creating it empty looked identical. SECURITY.md says deleting a record
    /// breaks verification — the anchor is what makes that true.
    #[test]
    fn deleting_the_log_is_caught_and_recreating_it_empty_stays_caught() {
        let c = setup(true);
        append(input("cloud question", "openai", vec!["api.openai.com".into()]));
        append(input("second", "local", vec![]));
        assert_eq!(verify(&c.file), Ok(2), "two appends verify");

        std::fs::remove_file(&c.file).unwrap();
        assert_eq!(verify(&c.file), Err(0), "a missing log is not an intact empty chain");
        assert_eq!(verify_active()["intact"], false);

        std::fs::write(&c.file, "").unwrap();
        assert_eq!(verify(&c.file), Err(0), "re-creating it empty restores nothing");
        assert_eq!(recent(10)["intact"], false);
    }

    /// The anchor's count only goes UP, so asking one more question after a
    /// truncation records the gap instead of erasing it.
    #[test]
    fn a_later_append_cannot_re_bless_a_truncated_log() {
        let c = setup(true);
        for q in ["one", "two", "three"] {
            append(input(q, "local", vec![]));
        }
        let text = std::fs::read_to_string(&c.file).unwrap();
        let kept = text.lines().next().unwrap().to_string();
        std::fs::write(&c.file, format!("{kept}\n")).unwrap();

        append(input("four", "local", vec![]));
        // Two well-chained records on disk, but the anchor has counted four.
        assert_eq!(verify(&c.file), Err(2), "the dropped records stay missing");
    }

    /// The anchor is keyed like the records, so rewriting it by hand to match a
    /// shortened log does not restore the verdict.
    #[test]
    fn a_hand_edited_anchor_does_not_bless_a_truncated_log() {
        let c = setup(true);
        append(input("one", "local", vec![]));
        append(input("two", "local", vec![]));

        let text = std::fs::read_to_string(&c.file).unwrap();
        let kept = text.lines().next().unwrap().to_string();
        let first: AuditRecord = serde_json::from_str(&kept).unwrap();
        std::fs::write(&c.file, format!("{kept}\n")).unwrap();

        // Point the anchor at the surviving prefix — without the key its hmac
        // cannot be recomputed, so the edit shows.
        let mut head = read_head().expect("the appends anchored the chain");
        head.count = 1;
        head.last_hmac = first.hmac.clone();
        write_json(&head_path(), &head);

        assert_eq!(verify(&c.file), Err(0), "an edited anchor is caught");
    }

    #[test]
    fn verbatim_is_opt_in() {
        let _c = setup(true);
        let mut inp = input("secret question text", "local", vec![]);
        inp.include_verbatim = true;
        append(inp);
        let snap = recent(10);
        let stored = snap["records"][0]["question"].as_str();
        assert_eq!(stored, Some("secret question text"), "verbatim stored when opted in");
    }

    #[test]
    fn answer_audit_records_only_hosts_dialed_during_the_answer() {
        let _c = setup(true);
        // Start capturing, dial a sentinel host mid-answer, then finish. We assert
        // membership of OUR sentinel (never recorded by any other test), so the
        // shared process-global egress registry can't make this flaky.
        let a = AnswerAudit::start("cloud question");
        crate::egress::record("https://audit-sentinel.example/v1", crate::egress::PURPOSE_AI_PROVIDER);
        a.finish("openai", vec!["budget.md".into()], vec![], None);

        let snap = recent(1);
        let hosts: Vec<&str> = snap["records"][0]["egress"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            hosts.contains(&"audit-sentinel.example"),
            "the host dialed during the answer is recorded: {hosts:?}"
        );
        assert_eq!(snap["records"][0]["provider"], "openai");
    }

    #[test]
    fn policy_forces_on_with_pref_off() {
        // The pref is OFF (setup(false) seeds auditEnabled absent)…
        let c = setup(false);
        assert!(!enabled(), "off by default when neither pref nor policy enables it");
        // …but a managed policy that forces the log on flips enabled().
        let pol = c._dir.path().join("policy.json");
        std::fs::write(&pol, r#"{"auditLog":"on"}"#).unwrap();
        std::env::set_var("LIGHTHOUSE_POLICY_FILE", &pol);
        crate::policy::reset_for_tests();

        assert!(enabled(), "policy auditLog:on forces the log on even with the pref off");
        append(input("forced by policy", "local", vec![]));
        assert_eq!(verify(&c.file), Ok(1), "a record is written under the forcing policy");

        std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
        crate::policy::reset_for_tests();
    }

    fn reported_cost(input: u64, output: u64, usd: Option<f64>) -> CostMeta {
        CostMeta {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
            reported: true,
            cost_estimate_usd: usd,
        }
    }

    #[test]
    fn ask_new_cost_is_the_meter_live_but_zero_for_a_replay() {
        // A live answer's NEW cost is its metered cost; a cache REPLAY (its final
        // chunk carries `cached_at`) computed nothing, so its NEW cost is 0 —
        // returned as None so the running total never double-counts it
        // (openspec: add-beam-loop §3.2/§3.3).
        let live = ChunkMeta {
            origin: "openai".into(),
            excerpt_count: 3,
            source_file_count: 2,
            cached_at: None,
            cost: Some(reported_cost(100, 50, Some(0.01))),
            manifest: None,
            chart: None,
            table: None,
        };
        assert_eq!(ask_new_cost(&live).map(|c| c.total_tokens), Some(150));
        // Same stored figures, but a replay stamp ⇒ 0 new tokens / $0.
        let replay = ChunkMeta { cached_at: Some(1_700_000_000_000), ..live };
        assert!(ask_new_cost(&replay).is_none(), "a replay reports 0 new");
    }

    #[test]
    fn recent_reports_a_cumulative_running_total_across_asks() {
        let _c = setup(true);
        // Two billable asks sum in the cumulative; a local ask contributes its
        // tokens with $0; a replay (cost None) contributes nothing.
        let mut billable = |q: &str, provider: &str, cost: Option<CostMeta>| {
            append(AuditInput { cost, ..input(q, provider, vec!["api.example".into()]) });
        };
        billable("a", "openai", Some(reported_cost(100, 40, Some(0.02))));
        billable("b", "anthropic", Some(reported_cost(200, 60, Some(0.05))));
        billable("local", "local", Some(reported_cost(300, 0, Some(0.0))));
        billable("replay", "openai", None);

        let snap = recent(10);
        let cum = &snap["cumulative"];
        assert_eq!(cum["inputTokens"], 600, "100 + 200 + 300 (replay adds none)");
        assert_eq!(cum["outputTokens"], 100);
        assert_eq!(cum["totalTokens"], 700, "the running total sums the asks");
        assert!(
            (cum["costEstimateUsd"].as_f64().unwrap() - 0.07).abs() < 1e-9,
            "labeled-estimate dollars sum; local is $0"
        );
    }
}
