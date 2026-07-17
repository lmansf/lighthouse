//! `lighthouse-mcp` — the Lighthouse MCP server (openspec: add-automation §3).
//!
//! An MCP server over STDIO (JSON-RPC 2.0 on stdin/stdout), IN-PROCESS against
//! `lighthouse-core` — NOT shelling `lighthouse-server`. Its tools therefore
//! inherit the engine's ask chokepoint directly: `ask_vault` answers through
//! `ask::run_headless_ask`, so it is audited + egress-attributed exactly like an
//! app ask, and there is a single answer path to reason about (no second
//! transport to re-audit or secure). See `protocol` for the wire handling and
//! the §3.5 transport-posture note, and `tools` for the read-only-leaning v1
//! tool set (`ask_vault`, `list_files`, `list_investigations`,
//! `run_analytics_sql`) — no vault- or store-mutating tool ships in v1.
//!
//! §3.5 (detailed in `protocol`): v1 is STDIO ONLY — no listening port, hence no
//! network-auth surface. A future port MUST bind loopback and adopt `auth.rs`'s
//! loopback-host allowlist + same-port origin + `LIGHTHOUSE_API_TOKEN`.

mod protocol;
mod tools;

use std::io::Write;

/// The stdio JSON-RPC loop: read one request per input line, write one response
/// per output line. Stdin/stdout use the BLOCKING `std::io` handles — the
/// workspace `tokio` has no `io-std` feature and this crate adds no dependency —
/// while the runtime still drives each tool's async work inside `handle`. The
/// server is inherently serial (one request, one response), so blocking between
/// requests to wait for the next line is the natural shape here.
#[tokio::main]
async fn main() {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break,  // EOF — the client closed the pipe.
            Ok(_) => {}
            Err(_) => break, // an unreadable stdin ends the session.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(request) => protocol::handle(request).await,
            Err(err) => protocol::parse_error(err),
        };
        // A notification yields Null — write nothing (JSON-RPC 2.0 §4.1).
        if !response.is_null() {
            write_line(&response);
        }
    }
}

/// Serialize one JSON-RPC message as a single stdout line, then flush so the
/// client sees it immediately (stdio MCP is line-framed by convention).
fn write_line(message: &serde_json::Value) {
    let text = serde_json::to_string(message).unwrap_or_else(|_| {
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"failed to serialize response"}}"#
            .to_string()
    });
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}
