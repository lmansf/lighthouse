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
pub fn state_dir() -> PathBuf {
    let dir = vault_dir().join(".rag-vault");
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

/// Root of the bundled offline resources (local model binary, TTS voice).
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
