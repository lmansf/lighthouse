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
pub mod boards;
pub mod briefings;
pub mod catalog;
pub mod config;
pub mod contracts;
pub mod embed;
pub mod audit;
pub mod egress;
pub mod extract;
pub mod index;
pub mod insights;
pub mod inspect;
pub mod investigations;
pub mod ledger;
pub mod llm;
pub mod local_model;
pub mod meta;
pub mod ocr;
pub mod pdf_tables;
pub mod pins;
pub mod profile;
pub mod provider_auth;
pub mod recipes;
pub mod policy;
pub mod secrets;
pub mod semantic;
pub mod updates;
pub mod settings;
pub mod sources;
pub mod synth;
pub mod table_profile;
pub mod vault;
pub mod views;
pub mod watch;
