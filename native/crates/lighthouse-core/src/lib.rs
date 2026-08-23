//! Lighthouse core engine — Rust port of the TypeScript backend in `src/server/`.
//!
//! Semantics mirror the TS implementation module-for-module (vault.ts,
//! extract.ts, llm.ts, …) so the two engines can run side-by-side against the
//! same on-disk state (`.rag-vault/state.json`, `profile.json`, …) and the same
//! wire protocol during the migration. Where behavior is intentionally
//! different it is called out with a `PARITY:` comment.

pub mod analytics;
pub mod answer_cache;
pub mod ask;
pub mod beam;
pub mod budget;
pub mod catalog;
pub mod config;
pub mod contracts;
pub mod embed;
pub mod audit;
pub mod egress;
pub mod extract;
pub mod index;
pub mod inspect;
pub mod ledger;
pub mod llm;
pub mod meta;
pub mod local_model;
pub mod numguard;
pub mod ocr;
pub mod pdf_tables;
pub mod profile;
pub mod provider_auth;
pub mod quotes;
pub mod recipes;
pub mod reports;
pub mod policy;
pub mod secrets;
pub mod updates;
pub mod settings;
pub mod sources;
pub mod sqlfmt;
pub mod synth;
pub mod table_profile;
pub mod vault;
pub mod watch;
pub mod workspace;

/// One process-wide lock for lib tests that mutate process environment
/// (VAULT_DIR and friends). A module-local lock only serializes its own
/// module — the parallel runner interleaves modules, and env vars are
/// process state, so every env-touching lib test shares this one.
/// Non-reentrant: take it once at the top of the test, never nested.
#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}
