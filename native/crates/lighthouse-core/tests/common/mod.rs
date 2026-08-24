//! Shared test scaffolding. The engine reads its paths from env vars (like the
//! TS server), so tests that touch engine state serialize on a global lock and
//! point LIGHTHOUSE_APP_STATE_DIR at their own temp directory.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Lock the process env and root ALL engine state under `dir`. The parameter
/// is still named for the directory a case owns; since the vault was deleted in
/// 0.15.0 it is simply the state root — the workspace (blobs + manifests), the
/// caches, the reports and the audit all live under it.
pub fn lock_env(dir: &Path) -> MutexGuard<'static, ()> {
    let guard = ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", dir.join(".rag-vault"));
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    guard
}

/// Attach `files` (name, bytes) to `conversation` and return their ids — the
/// one-line corpus setup every ask-shaped test now needs.
#[allow(dead_code)]
pub fn attach_all(conversation: &str, files: &[(&str, &[u8])]) -> Vec<String> {
    files
        .iter()
        .map(|(name, bytes)| {
            let att = lighthouse_core::workspace::attach(conversation, name, bytes)
                .unwrap_or_else(|e| panic!("attach {name}: {e}"));
            lighthouse_core::workspace::ingest(&att);
            att.id
        })
        .collect()
}
