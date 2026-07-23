//! Server-side configuration (port of `src/server/config.ts`).
//!
//! Everything is stored on the local filesystem; the vault is a plain directory
//! of the user's files and derived state lives in a hidden `.rag-vault/`
//! subfolder beside the documents.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// The single logical source id for the local vault folder.
pub const VAULT_SOURCE_ID: &str = "vault";
/// The logical source id for the Microsoft SharePoint / OneDrive connector.
pub const SHAREPOINT_SOURCE_ID: &str = "sharepoint";

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Absolute path to the vault directory holding the user's documents.
pub fn vault_dir() -> PathBuf {
    let dir = match env_trimmed("VAULT_DIR") {
        Some(v) => {
            // Expand a leading `~` like the TS implementation.
            let expanded = if v == "~" || v.starts_with("~/") || v.starts_with("~\\") {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_default();
                format!("{home}{}", &v[1..])
            } else {
                v
            };
            let p = PathBuf::from(expanded);
            if p.is_absolute() {
                p
            } else {
                std::env::current_dir().unwrap_or_default().join(p)
            }
        }
        None => std::env::current_dir().unwrap_or_default().join("vault"),
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Hidden state directory for inclusion flags, profile, and indexes.
///
/// §41: platform-aware. Desktop (and the web/dev twin) keeps the historical
/// in-vault `.rag-vault` — byte-identical behavior. iOS moves engine state
/// OUT of the user-visible Documents vault into the app's Application
/// Support container: the shell's `bootstrap_env` points
/// `LIGHTHOUSE_APP_STATE_DIR` there before any engine call, so the Files-app
/// door ("On My iPhone → Lighthouse") shows only the user's documents. The
/// env var is read directly — NOT via [`app_state_dir`], whose fallback is
/// this very function (a cycle). Unset env on iOS (bare engine under a test
/// harness) falls back to the historical in-vault location so the engine
/// still boots; the shell always sets it in the app. The one-shot CLI
/// `--vault` flow (ask.rs) re-points LIGHTHOUSE_APP_STATE_DIR in-vault —
/// desktop-only (no CLI ships on iOS), so the iOS arm never sees it.
/// `LIGHTHOUSE_STATE_HOME_LEGACY=1` is the migration's fail-open switch
/// (lighthouse-shell::state_home): a failed Documents→App Support migration
/// keeps this launch running from the legacy dir — never a refuse-to-boot.
pub fn state_dir() -> PathBuf {
    let dir = if cfg!(target_os = "ios") {
        let legacy = std::env::var("LIGHTHOUSE_STATE_HOME_LEGACY")
            .map(|v| v == "1")
            .unwrap_or(false);
        match env_trimmed("LIGHTHOUSE_APP_STATE_DIR") {
            Some(p) if !legacy => PathBuf::from(p).join(".rag-vault"),
            _ => vault_dir().join(".rag-vault"),
        }
    } else {
        vault_dir().join(".rag-vault")
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn state_path() -> PathBuf {
    state_dir().join("state.json")
}

pub fn profile_path() -> PathBuf {
    // The signed-in profile (identity + onboarding completion) must persist
    // INDEPENDENT of the vault folder — a vault can be moved, re-pointed, or
    // cloud-synced, and `current_dir()`-relative resolution can differ between
    // launches, any of which would strand the profile and force a fresh
    // sign-in. This is the same rule connector credentials already follow
    // (see connectors_dir). The desktop shell sets LIGHTHOUSE_PROFILE_FILE to
    // its private data dir; the web/dev build (no shell) falls back to the
    // vault's .rag-vault for parity.
    if let Some(p) = env_trimmed("LIGHTHOUSE_PROFILE_FILE") {
        return PathBuf::from(p);
    }
    state_dir().join("profile.json")
}

/// Install-global state (signed-in profile, sealed secrets, settings) that
/// must persist across vault switches. This state belongs to the user's
/// install, not to whichever folder happens to be the vault — storing it
/// in-vault meant "Choose vault folder…" re-pointed the engine at a folder
/// with none of it and silently signed the user out. Same rule the profile
/// and connector credentials already follow (see profile_path/connectors_dir):
/// the desktop shell sets LIGHTHOUSE_APP_STATE_DIR to its private data dir;
/// web/dev falls back to the in-vault state dir for parity.
pub fn app_state_dir() -> PathBuf {
    if let Some(p) = env_trimmed("LIGHTHOUSE_APP_STATE_DIR") {
        let dir = PathBuf::from(p);
        let _ = fs::create_dir_all(&dir);
        return dir;
    }
    state_dir()
}

/// Public Entra client id for the SharePoint connector (public PKCE-class
/// client — carries no secret; overridable for self-hosters).
pub fn sharepoint_client_id() -> String {
    env_trimmed("SHAREPOINT_CLIENT_ID")
        .unwrap_or_else(|| "d25817ff-a0ed-4458-9282-41a18ce6d48a".to_string())
}

pub fn sharepoint_authority() -> String {
    env_trimmed("SHAREPOINT_AUTHORITY")
        .unwrap_or_else(|| "https://login.microsoftonline.com/common".to_string())
}

/// Per-connector state directory (OAuth tokens, mirrored content, inclusion).
/// Prefers LIGHTHOUSE_CONNECTORS_DIR (the desktop shell's private userData dir)
/// so long-lived credentials never ride along in a cloud-synced vault.
pub fn connectors_dir() -> PathBuf {
    let dir = match env_trimmed("LIGHTHOUSE_CONNECTORS_DIR") {
        Some(v) => PathBuf::from(v),
        None => state_dir().join("connectors"),
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

/// True only when running inside the packaged desktop app.
pub fn is_desktop_app() -> bool {
    std::env::var("LIGHTHOUSE_DESKTOP")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// The ONE engine-reported platform signal (iOS field patch 1 §1): the form
/// factor this engine was compiled into — `"desktop"`, `"ios"`, or
/// `"android"`. Deliberately distinct from [`is_desktop_app`] /
/// LIGHTHOUSE_DESKTOP=1, which mean "embedded shell" (true on iOS too): this
/// is WHICH shell. Compile-time by design — no UA sniffing, no window-size
/// proxies — so pure platform verdicts (local_model::local_model_supported,
/// profile's default provider) can be unit-tested against all three values
/// while call sites read the build's own. PARITY: the TS twin's
/// config.ts::platformKind is the constant "desktop" (it only runs in the web
/// dev flow on a computer).
pub fn platform_kind() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

/// Root of the bundled offline resources (local model binary).
pub fn resources_dir() -> PathBuf {
    match env_trimmed("LIGHTHOUSE_RESOURCES_PATH") {
        Some(v) => PathBuf::from(v),
        None => std::env::current_dir()
            .unwrap_or_default()
            .join("resources"),
    }
}

/// The app version stamped on telemetry rows. Mirrors the TS
/// `process.env.npm_package_version`, falling back to this crate's version.
pub fn app_version() -> String {
    env_trimmed("npm_package_version").unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

/// Read a JSON file, returning `fallback` if it is missing or unparseable.
pub fn read_json<T: DeserializeOwned>(file: &Path, fallback: T) -> T {
    match fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write a JSON file atomically and durably (temp file with owner-only 0600
/// permissions, fsync data before rename, best-effort directory fsync after).
pub fn write_json<T: Serialize>(file: &Path, value: &T) {
    let data = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    write_atomic(file, data);
}

/// Compact sibling of [`write_json`] for large machine-only files (the
/// retrieval index): identical atomic+durable path, without pretty-print
/// inflation — on a big corpus the index is tens-to-hundreds of MB, where
/// the pretty form costs real serialize time and disk bandwidth per flush.
pub fn write_json_compact<T: Serialize>(file: &Path, value: &T) {
    let data = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    write_atomic(file, data);
}

fn write_atomic(file: &Path, data: String) {
    let n = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = file.with_file_name(format!(
        "{}.{}.{}.tmp",
        file.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("state.json"),
        std::process::id(),
        n
    ));
    let write = || -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        use std::io::Write;
        f.write_all(data.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, file)?;
        // Make the rename itself durable (unsupported on some platforms).
        if let Some(dir) = file.parent() {
            if let Ok(d) = fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    };
    if write().is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// UTC timestamp in the ISO-8601 shape JS `Date.toISOString()` produces
/// (`YYYY-MM-DDTHH:MM:SS.sssZ`).
pub fn iso_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// UTC calendar day (`YYYY-MM-DD`).
pub fn utc_day() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Milliseconds since the Unix epoch (JS `Date.now()`).
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse a date string to epoch milliseconds (JS `Date.parse`), or None.
pub fn parse_ms(s: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    // Bare `YYYY-MM-DD` parses as UTC midnight, like JS.
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §1/§3 pin: the platform signal is exactly one of the three literals the
    /// UI branches on, and it agrees with the compile target — under a mobile
    /// cross-compile (`cargo test --target aarch64-apple-ios`) the same assert
    /// pins the mobile arms.
    #[test]
    fn platform_kind_matches_compile_target() {
        let k = platform_kind();
        assert!(["desktop", "ios", "android"].contains(&k));
        if cfg!(target_os = "ios") {
            assert_eq!(k, "ios");
        } else if cfg!(target_os = "android") {
            assert_eq!(k, "android");
        } else {
            assert_eq!(k, "desktop");
        }
    }

    /// §41 pin: everywhere EXCEPT iOS the state home is the historical
    /// in-vault `.rag-vault` — and neither the app-state env var nor the
    /// migration's fail-open switch may leak into that resolution. On an iOS
    /// cross-compile (`cargo test --target aarch64-apple-ios`) the same test
    /// pins the RELOCATED home instead: `LIGHTHOUSE_APP_STATE_DIR/.rag-vault`,
    /// with the legacy switch restoring the in-vault dir.
    #[test]
    fn state_dir_platform_seam() {
        // Process-global env: mutate under distinctive values and restore, so
        // parallel tests that also read VAULT_DIR see it back untouched.
        let prev_vault = std::env::var("VAULT_DIR").ok();
        let prev_app = std::env::var("LIGHTHOUSE_APP_STATE_DIR").ok();
        let prev_legacy = std::env::var("LIGHTHOUSE_STATE_HOME_LEGACY").ok();
        let vault = std::env::temp_dir().join("lh-s41-vault");
        let appstate = std::env::temp_dir().join("lh-s41-appstate");
        std::env::set_var("VAULT_DIR", &vault);
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", &appstate);
        std::env::remove_var("LIGHTHOUSE_STATE_HOME_LEGACY");

        let resolved = state_dir();
        if cfg!(target_os = "ios") {
            assert_eq!(resolved, appstate.join(".rag-vault"));
            std::env::set_var("LIGHTHOUSE_STATE_HOME_LEGACY", "1");
            assert_eq!(state_dir(), vault.join(".rag-vault"));
        } else {
            // Desktop/web byte-identical: in-vault, env vars irrelevant here.
            assert_eq!(resolved, vault.join(".rag-vault"));
            std::env::set_var("LIGHTHOUSE_STATE_HOME_LEGACY", "1");
            assert_eq!(state_dir(), vault.join(".rag-vault"));
        }

        match prev_vault {
            Some(v) => std::env::set_var("VAULT_DIR", v),
            None => std::env::remove_var("VAULT_DIR"),
        }
        match prev_app {
            Some(v) => std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", v),
            None => std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR"),
        }
        match prev_legacy {
            Some(v) => std::env::set_var("LIGHTHOUSE_STATE_HOME_LEGACY", v),
            None => std::env::remove_var("LIGHTHOUSE_STATE_HOME_LEGACY"),
        }
    }
}
