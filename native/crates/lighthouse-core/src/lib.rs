//! Lighthouse core engine — Rust port of the TypeScript backend in `src/server/`.
//!
//! Semantics mirror the TS implementation module-for-module (vault.ts,
//! extract.ts, llm.ts, …) so the two engines can run side-by-side against the
//! same on-disk state (`.rag-vault/state.json`, `profile.json`, …) and the same
//! wire protocol during the migration. Where behavior is intentionally
//! different it is called out with a `PARITY:` comment.

pub mod analytics;
pub mod catalog;
pub mod config;
pub mod contracts;
pub mod embed;
pub mod experiment;
pub mod audit;
pub mod egress;
pub mod extract;
pub mod index;
pub mod license;
pub mod llm;
pub mod local_model;
pub mod meta;
pub mod ocr;
pub mod pdf_tables;
pub mod pins;
pub mod profile;
pub mod policy;
pub mod secrets;
pub mod updates;
pub mod settings;
pub mod sources;
pub mod synth;
pub mod table_profile;
pub mod tts;
pub mod usage;
pub mod vault;
pub mod watch;
