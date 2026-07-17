//! `lighthouse` — the headless CLI (openspec: add-automation §2).
//!
//! Scaffold only. §2 implements the `ask` / `fork` / `export` subcommands over
//! `lighthouse_core::ask::run_headless_ask` (the shared audited chokepoint, §1)
//! and `lighthouse_core::investigations::{fork, export_markdown}` (§4), with the
//! `--local` / `--vault` / `--json` / `--investigation` / `--include` flags and a
//! provenance line read from the final `ChunkMeta`.
fn main() {
    eprintln!("lighthouse: CLI not yet implemented");
    std::process::exit(2);
}
