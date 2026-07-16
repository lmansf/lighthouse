//! Local audit log (openspec: add-audit-log, S2) — a tamper-evident,
//! append-only, local-only record answering "what did the AI read, what left
//! the machine, and when." One JSONL record per answered question, written at
//! the transport choke point (see design D1). Off by default; on by the
//! `audit_enabled` setting or the managed policy key `auditLog: "on"`.
//!
//! Each record chains an HMAC-SHA256 to the previous record (key derived from
//! the install secrets store), so deleting or editing any record breaks
//! verification from that point on. Detective control, not anti-root DRM
//! (the doc states the threat model).
//!
//! KEEP IN SYNC with src/server/audit.ts (same record shape at the same
//! choke point; the TS twin omits the HMAC chain — PARITY, it is not a
//! security surface).

use std::io::Write as _;
use std::path::PathBuf;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::config::{app_state_dir, now_ms};
use crate::contracts::{ChunkMeta, CostMeta};

type HmacSha256 = Hmac<Sha256>;

const HMAC_LABEL: &str = "lighthouse-audit-hmac-v1";
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

fn last_hmac() -> String {
    let path = audit_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return GENESIS.to_string();
    };
    text.lines()
        .rev()
        .find_map(|l| serde_json::from_str::<AuditRecord>(l).ok())
        .map(|r| r.hmac)
        .unwrap_or_else(|| GENESIS.to_string())
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
        prev_hmac: last_hmac(),
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
        let _ = writeln!(f, "{line}");
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

/// Verify the chain in a file. `Ok(n)` = n records, all intact. `Err(i)` =
/// the chain first breaks at record index `i` (0-based).
pub fn verify(path: &std::path::Path) -> Result<usize, usize> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(0);
    };
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
    Ok(count)
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
