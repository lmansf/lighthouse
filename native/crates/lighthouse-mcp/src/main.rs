//! `lighthouse-mcp` — the MCP stdio server (openspec: add-automation §3).
//!
//! Scaffold only. §3 implements the JSON-RPC-over-stdio loop (initialize + tool
//! listing + tool call) and a small read-only-leaning tool set — `ask_vault`
//! (over `lighthouse_core::ask::run_headless_ask`, so it inherits the audited
//! chokepoint), `list_files`, `list_investigations`, `run_analytics_sql` (guarded
//! read-only SELECT). Stdio only in v1; a future port adopts `auth.rs`.
fn main() {
    eprintln!("lighthouse-mcp: server not yet implemented");
    std::process::exit(2);
}
