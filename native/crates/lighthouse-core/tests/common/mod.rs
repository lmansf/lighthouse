//! Shared test scaffolding. The engine reads its paths from env vars (like the
//! TS server), so tests that touch the vault serialize on a global lock and
//! point VAULT_DIR at their own temp directory.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn lock_env(vault: &Path) -> MutexGuard<'static, ()> {
    let guard = ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var("VAULT_DIR", vault);
    // Since the 0.15.0 re-root, engine state comes from LIGHTHOUSE_APP_STATE_DIR
    // alone. Point it inside the test's own temp vault so each case still gets
    // an isolated store (and the historical `.rag-vault` layout assertions
    // keep meaning what they say).
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", vault.join(".rag-vault"));
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    // With experiments removed, default inclusion is a fixed privacy-preserving
    // default (exclude): newly-added files start EXCLUDED until included, so the
    // inclusion tests below are deterministic without pinning anything.
    lighthouse_core::vault::invalidate_walk_cache();
    guard
}
