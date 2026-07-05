//! Lighthouse core engine — Rust port of the TypeScript backend in `src/server/`.
//!
//! Semantics mirror the TS implementation module-for-module (vault.ts,
//! extract.ts, llm.ts, …) so the two engines can run side-by-side against the
//! same on-disk state (`.rag-vault/state.json`, `profile.json`, …) and the same
//! wire protocol during the migration. Where behavior is intentionally
//! different it is called out with a `PARITY:` comment.

pub mod config;
pub mod contracts;
pub mod experiment;
pub mod extract;
pub mod license;
pub mod llm;
pub mod local_model;
pub mod profile;
pub mod settings;
pub mod sources;
pub mod tts;
pub mod usage;
pub mod vault;
