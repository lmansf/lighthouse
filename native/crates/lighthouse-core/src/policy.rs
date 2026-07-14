//! Managed policy (openspec: add-managed-policy) — machine-scope, admin-owned
//! restrictions the engine enforces server-side. A `policy.json` in the fixed
//! per-OS machine path overrides user preferences where set; the UI renders
//! affected controls locked ("Managed by your organization"), but every key
//! is enforced HERE (and in the shell for desktop-only keys), not by hiding
//! buttons.
//!
//! States: file absent ⇒ no restrictions (exactly pre-policy behavior);
//! valid ⇒ the set keys apply; malformed/unknown-version ⇒ FAIL CLOSED to
//! local-only + telemetry/history off and surface a managed-configuration
//! error. Loaded once per process (machine policy changes apply at next
//! launch — the MDM/GPO contract); the debug-only `LIGHTHOUSE_POLICY_FILE`
//! override exists for tests, and release builds deliberately ignore it so a
//! user-settable env var can't re-point policy discovery.
//!
//! Threat model (see docs/managed-deployment.md): configuration management —
//! the machine path is writable by root/Administrators only, and THAT is the
//! integrity boundary. This is not anti-tamper against a local admin.
//!
//! KEEP IN SYNC with src/server/policy.ts (dev twin enforces
//! providers/telemetry/history; hotkeys/OCR/notifications/vaultRoots are
//! desktop-shell concerns — PARITY).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicyFile {
    pub v: Option<u32>,
    pub allowed_providers: Option<Vec<String>>,
    pub force_local_only: Option<bool>,
    /// "off" silences ping/event/events/assign and locks the click-events
    /// opt-in off. License check/start/activate and explicit user
    /// submissions (feedback/bug) remain — documented in data-flows.md.
    pub telemetry: Option<String>,
    pub chat_history: Option<String>,
    pub widget_hotkeys: Option<String>,
    pub ocr: Option<String>,
    pub notifications: Option<String>,
    pub audit_log: Option<String>,
    pub vault_roots: Option<Vec<String>>,
    /// Unknown keys are tolerated (forward compatibility) and logged once.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum PolicyState {
    /// No machine policy — nothing is restricted.
    Absent,
    Active(PolicyFile),
    /// Present but unreadable/unparseable/unknown-version: fail closed
    /// (local-only, telemetry+history off) and surface the error state.
    Malformed,
}

fn machine_policy_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("ProgramData")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| r"C:\ProgramData".to_string());
        PathBuf::from(base).join("Lighthouse").join("policy.json")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/Lighthouse/policy.json")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/etc/lighthouse/policy.json")
    }
}

fn policy_path() -> PathBuf {
    // Debug-only test seam. Release builds read ONLY the machine path — an
    // env var a standard user controls must not re-point policy discovery.
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("LIGHTHOUSE_POLICY_FILE") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    machine_policy_path()
}

fn load() -> PolicyState {
    let path = policy_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return PolicyState::Absent; // absent (or unreadable-because-absent)
    };
    match serde_json::from_str::<PolicyFile>(&text) {
        Ok(p) if matches!(p.v, None | Some(1)) => {
            if !p.unknown.is_empty() {
                let keys: Vec<_> = p.unknown.keys().cloned().collect();
                eprintln!("[policy] ignoring unknown keys in {}: {keys:?}", path.display());
            }
            PolicyState::Active(p)
        }
        Ok(p) => {
            eprintln!(
                "[policy] MALFORMED: unsupported policy version {:?} in {} — failing closed",
                p.v,
                path.display()
            );
            PolicyState::Malformed
        }
        Err(e) => {
            eprintln!(
                "[policy] MALFORMED: {} in {} — failing closed (local-only, telemetry/history off)",
                e,
                path.display()
            );
            PolicyState::Malformed
        }
    }
}

// Mutex<Option<..>> rather than a plain OnceLock so debug/test builds can
// reset between cases; contention is one uncontended lock per enforcement
// check, which is noise next to the work each check gates.
fn cell() -> &'static Mutex<Option<Arc<PolicyState>>> {
    static CELL: OnceLock<Mutex<Option<Arc<PolicyState>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// The loaded machine policy (loaded once; restart applies changes).
pub fn policy() -> Arc<PolicyState> {
    let mut guard = cell().lock().unwrap_or_else(|p| p.into_inner());
    guard.get_or_insert_with(|| Arc::new(load())).clone()
}

/// Test seam: drop the cached policy so the next access reloads.
#[cfg(debug_assertions)]
pub fn reset_for_tests() {
    *cell().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// True when a policy file is present (valid or not).
pub fn present() -> bool {
    !matches!(*policy(), PolicyState::Absent)
}

/// True when the policy file exists but could not be used (fail-closed).
pub fn managed_error() -> bool {
    matches!(*policy(), PolicyState::Malformed)
}

/// May this provider id be selected AND called? `forceLocalOnly` and
/// `allowedProviders` intersect when both are set (a contradictory policy
/// behaves restrictively — fail-closed philosophy). Provider ids are the
/// engine's lowercase constants; matching is exact.
pub fn provider_allowed(provider_id: &str) -> bool {
    match &*policy() {
        PolicyState::Absent => true,
        PolicyState::Malformed => provider_id == "local",
        PolicyState::Active(p) => {
            if p.force_local_only == Some(true) && provider_id != "local" {
                return false;
            }
            match &p.allowed_providers {
                Some(list) => list.iter().any(|a| a == provider_id),
                None => true,
            }
        }
    }
}

fn key_is(state: &PolicyState, get: impl Fn(&PolicyFile) -> &Option<String>, value: &str) -> bool {
    matches!(state, PolicyState::Active(p) if get(p).as_deref() == Some(value))
}

/// ping/event/events/assign transmission allowed?
pub fn telemetry_allowed() -> bool {
    match &*policy() {
        PolicyState::Malformed => false,
        s => !key_is(s, |p| &p.telemetry, "off"),
    }
}

/// Persisting conversations allowed?
pub fn history_allowed() -> bool {
    match &*policy() {
        PolicyState::Malformed => false,
        s => !key_is(s, |p| &p.chat_history, "off"),
    }
}

/// Installing the Whisper hook / summon shortcut allowed?
pub fn hotkeys_allowed() -> bool {
    !key_is(&policy(), |p| &p.widget_hotkeys, "off")
}

/// OCR extraction allowed (policy side; the user toggle is separate)?
pub fn ocr_allowed() -> bool {
    !key_is(&policy(), |p| &p.ocr, "off")
}

/// Emitting OS notifications allowed?
pub fn notifications_allowed() -> bool {
    !key_is(&policy(), |p| &p.notifications, "off")
}

/// Does policy force the local audit log on (consumed by add-audit-log)?
pub fn audit_forced_on() -> bool {
    key_is(&policy(), |p| &p.audit_log, "on")
}

/// Component-boundary prefix test after best-effort canonicalization —
/// `/srv/vaults` admits `/srv/vaults/team` but never `/srv/vaults-evil`.
/// Windows compares case-insensitively. A path that cannot be canonicalized
/// (not yet created) is checked lexically on its absolute form.
fn is_under(child: &Path, root: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let c = canon(child);
    let r = canon(root);
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .map(|comp| {
                let s = comp.as_os_str().to_string_lossy().to_string();
                if cfg!(windows) {
                    s.to_ascii_lowercase()
                } else {
                    s
                }
            })
            .collect()
    };
    let (c, r) = (norm(&c), norm(&r));
    !r.is_empty() && c.len() >= r.len() && c[..r.len()] == r[..]
}

/// May the vault live at / a link point into this path?
pub fn vault_path_allowed(path: &Path) -> bool {
    match &*policy() {
        PolicyState::Active(p) => match &p.vault_roots {
            Some(roots) if !roots.is_empty() => {
                roots.iter().any(|r| is_under(path, Path::new(r)))
            }
            _ => true,
        },
        // vaultRoots is not part of the malformed fail-closed trio (see
        // design D3) — an unusable policy must not strand the current vault.
        _ => true,
    }
}

/// The `{op:"policy"}` payload: presence, error state, and per-control locks
/// the UI renders as "Managed by your organization".
pub fn snapshot() -> serde_json::Value {
    let state = policy();
    let (present, error) = match &*state {
        PolicyState::Absent => (false, false),
        PolicyState::Active(_) => (true, false),
        PolicyState::Malformed => (true, true),
    };
    let active = match &*state {
        PolicyState::Active(p) => Some(p),
        _ => None,
    };
    json!({
        "present": present,
        "error": error,
        "locks": {
            "allowedProviders": match &*state {
                PolicyState::Malformed => Some(vec!["local".to_string()]),
                PolicyState::Active(p) => {
                    if p.force_local_only == Some(true) {
                        Some(vec!["local".to_string()])
                            .map(|base| match &p.allowed_providers {
                                Some(list) => base.into_iter().filter(|b| list.contains(b)).collect(),
                                None => base,
                            })
                    } else {
                        p.allowed_providers.clone()
                    }
                }
                PolicyState::Absent => None,
            },
            "telemetryOff": !telemetry_allowed(),
            "chatHistoryOff": !history_allowed(),
            "widgetHotkeysOff": !hotkeys_allowed(),
            "ocrOff": !ocr_allowed(),
            "notificationsOff": !notifications_allowed(),
            "auditLogOn": audit_forced_on(),
            "vaultRoots": active.and_then(|p| p.vault_roots.clone()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex as TestMutex, OnceLock as TestOnce};

    /// Env + the process-global policy cache are shared — serialize tests.
    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: TestOnce<TestMutex<()>> = TestOnce::new();
        LOCK.get_or_init(|| TestMutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    fn with_policy_file(content: Option<&str>, f: impl FnOnce()) {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("policy.json");
        match content {
            Some(c) => {
                std::fs::write(&file, c).expect("write policy");
                std::env::set_var("LIGHTHOUSE_POLICY_FILE", &file);
            }
            None => {
                // Point at a path that does not exist → Absent.
                std::env::set_var("LIGHTHOUSE_POLICY_FILE", &file);
            }
        }
        reset_for_tests();
        f();
        std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
        reset_for_tests();
    }

    #[test]
    fn absent_policy_restricts_nothing() {
        let _g = test_lock();
        with_policy_file(None, || {
            assert!(!present());
            assert!(provider_allowed("deepseek"));
            assert!(telemetry_allowed());
            assert!(history_allowed());
            assert!(hotkeys_allowed());
            assert!(ocr_allowed());
            assert!(notifications_allowed());
            assert!(!audit_forced_on());
            assert!(vault_path_allowed(Path::new("/anywhere/at/all")));
        });
    }

    #[test]
    fn malformed_policy_fails_closed_to_the_trio() {
        let _g = test_lock();
        with_policy_file(Some("{ not json"), || {
            assert!(present());
            assert!(managed_error());
            assert!(provider_allowed("local"));
            assert!(!provider_allowed("anthropic"), "cloud refused under malformed policy");
            assert!(!telemetry_allowed());
            assert!(!history_allowed());
            // Not part of the fail-closed trio:
            assert!(hotkeys_allowed());
            assert!(ocr_allowed());
            assert!(vault_path_allowed(Path::new("/anywhere")));
        });
    }

    #[test]
    fn unknown_version_fails_closed_and_unknown_keys_do_not() {
        let _g = test_lock();
        with_policy_file(Some(r#"{"v": 9, "telemetry": "off"}"#), || {
            assert!(managed_error(), "unknown version is malformed");
        });
        with_policy_file(
            Some(r#"{"v": 1, "telemetry": "off", "futureKey": {"x": 1}}"#),
            || {
                assert!(!managed_error(), "unknown KEYS are tolerated");
                assert!(!telemetry_allowed());
                assert!(provider_allowed("openai"), "unset keys stay unrestricted");
            },
        );
    }

    #[test]
    fn provider_rules_force_local_and_allowlist_intersect() {
        let _g = test_lock();
        with_policy_file(Some(r#"{"forceLocalOnly": true}"#), || {
            assert!(provider_allowed("local"));
            assert!(!provider_allowed("openai"));
        });
        with_policy_file(
            Some(r#"{"allowedProviders": ["local", "anthropic"]}"#),
            || {
                assert!(provider_allowed("anthropic"));
                assert!(!provider_allowed("deepseek"));
            },
        );
        // Contradictory: intersection → nothing but what both admit.
        with_policy_file(
            Some(r#"{"forceLocalOnly": true, "allowedProviders": ["anthropic"]}"#),
            || {
                assert!(!provider_allowed("anthropic"), "not local");
                assert!(!provider_allowed("local"), "not in the allowlist — contradictory policy is restrictive");
            },
        );
    }

    #[test]
    fn vault_roots_respect_component_boundaries() {
        let _g = test_lock();
        let root = tempfile::tempdir().expect("root");
        let inside = root.path().join("team").join("vault");
        std::fs::create_dir_all(&inside).unwrap();
        let evil = PathBuf::from(format!("{}-evil", root.path().display()));
        let policy_json = format!(
            r#"{{"vaultRoots": ["{}"]}}"#,
            root.path().display().to_string().replace('\\', "\\\\")
        );
        with_policy_file(Some(&policy_json), || {
            assert!(vault_path_allowed(&inside));
            assert!(!vault_path_allowed(&evil), "sibling with the root as a string prefix must be rejected");
            assert!(!vault_path_allowed(Path::new("/somewhere/else")));
        });
    }

    #[test]
    fn snapshot_reports_locks_for_the_ui() {
        let _g = test_lock();
        with_policy_file(
            Some(r#"{"forceLocalOnly": true, "telemetry": "off", "auditLog": "on"}"#),
            || {
                let s = snapshot();
                assert_eq!(s["present"], true);
                assert_eq!(s["error"], false);
                assert_eq!(s["locks"]["allowedProviders"][0], "local");
                assert_eq!(s["locks"]["telemetryOff"], true);
                assert_eq!(s["locks"]["auditLogOn"], true);
                assert_eq!(s["locks"]["chatHistoryOff"], false);
            },
        );
    }
}
