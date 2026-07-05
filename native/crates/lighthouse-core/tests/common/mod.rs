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
    std::env::remove_var("LICENSE_API_URL");
    std::env::remove_var("LICENSE_ENFORCE");
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    // Pin the default_inclusion experiment to `opt_in` (default-excluded) so
    // inclusion tests are deterministic regardless of the random contact id.
    let state_dir = vault.join(".rag-vault");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("experiments.json"),
        r#"{ "onboarding": "key_first", "default_inclusion": "opt_in", "source": "override" }"#,
    )
    .unwrap();
    lighthouse_core::vault::invalidate_walk_cache();
    guard
}
