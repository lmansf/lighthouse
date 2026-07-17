//! Minimal MCP over JSON-RPC 2.0 (openspec: add-automation §3.2). One request
//! per stdin line in, one response per stdout line out; NO listening port.
//!
//! Handled methods:
//!   * `initialize`  → protocolVersion + serverInfo + capabilities.tools
//!   * `tools/list`  → the §3.3 tool schemas
//!   * `tools/call`  → dispatch by name (see `crate::tools`), returning an MCP
//!                     `content:[{type:"text", text}]` result. A known tool that
//!                     RUNS and FAILS (e.g. a `guard_sql` refusal, a bad arg)
//!                     returns `isError:true` — NOT a JSON-RPC error; only
//!                     protocol misuse (unknown method/tool, unparseable line)
//!                     is a JSON-RPC error.
//!   * `ping`        → `{}` (liveness)
//!   * notifications (a request with no `id`, e.g. `notifications/initialized`)
//!                     → no response at all.
//!
//! §3.5 — TRANSPORT POSTURE. v1 is STDIO ONLY. It binds no TCP port, so there is
//! NO network-auth surface to defend — no LAN listener a peer could reach, no
//! origin to check, no token to verify. This is deliberate: the safest port is
//! the one that does not exist. IF a future version serves MCP over a port, it
//! MUST bind loopback ONLY and adopt `lighthouse_server::auth`'s model verbatim —
//! the loopback-host allowlist (which defeats DNS rebinding), the same-port
//! origin check, and the `LIGHTHOUSE_API_TOKEN` shared secret — never a bare LAN
//! bind. Recorded here as a design constraint so a later port cannot skip it.

use serde_json::{json, Value};

use crate::tools;

/// The MCP protocol version this v1 server speaks. Answered on `initialize`.
pub(crate) const PROTOCOL_VERSION: &str = "2024-11-05";
/// The server identity reported in the `initialize` `serverInfo`.
pub(crate) const SERVER_NAME: &str = "lighthouse-mcp";

/// The pure request→response core (no stdio), so tests drive it directly. A
/// NOTIFICATION (a request with no `id`) yields `Value::Null`: the stdio loop
/// writes nothing for it, and because every real JSON-RPC response is an object,
/// `Null` is an unambiguous "no reply".
pub(crate) async fn handle(request: Value) -> Value {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // No `id` ⇒ a notification: never answered (JSON-RPC 2.0 §4.1). An `id` that
    // is present-but-null is a (discouraged) request and still gets a response.
    let Some(id) = request.get("id").cloned() else {
        return Value::Null;
    };
    match method.as_str() {
        "initialize" => success(id, initialize_result()),
        "tools/list" => success(id, json!({ "tools": tools::schemas() })),
        "tools/call" => tools_call(id, &request).await,
        "ping" => success(id, json!({})),
        other => error_response(id, -32601, format!("method not found: {other}")),
    }
}

/// The `initialize` result. Capabilities advertise TOOLS only (no
/// resources/prompts). We answer with our own supported protocol version rather
/// than echoing the client's — deterministic and honest about what we speak; the
/// client's `protocolVersion`/`clientInfo` are accepted but need no negotiation
/// in v1.
fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        "capabilities": { "tools": {} }
    })
}

async fn tools_call(id: Value, request: &Value) -> Value {
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    // Absent/null `arguments` ⇒ an empty object (a no-arg tool call is valid).
    let args = match params.get("arguments") {
        Some(a) if !a.is_null() => a.clone(),
        _ => json!({}),
    };
    // An unknown TOOL NAME is protocol misuse (invalid params); a KNOWN tool that
    // runs and fails is a tool-level `isError` result (below).
    if !tools::is_known(name) {
        return error_response(id, -32602, format!("unknown tool: {name}"));
    }
    match tools::call(name, &args).await {
        Ok(value) => success(id, tool_result(value, false)),
        Err(message) => success(id, tool_result(Value::String(message), true)),
    }
}

/// Wrap a tool's output in the MCP `tools/call` result shape. Structured output
/// (a JSON object) is serialized into a single text content block; an error
/// carries its message as the text with `isError:true`.
fn tool_result(value: Value, is_error: bool) -> Value {
    let text = match value {
        Value::String(s) => s,
        other => serde_json::to_string(&other).unwrap_or_default(),
    };
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": is_error
    })
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// A JSON-RPC parse error (`-32700`, `id: null`) — the stdin line was not JSON.
pub(crate) fn parse_error(detail: impl std::fmt::Display) -> Value {
    json!({
        "jsonrpc": "2.0", "id": Value::Null,
        "error": { "code": -32700, "message": format!("parse error: {detail}") }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initialize_advertises_tools_capability_and_server_info() {
        let resp = handle(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } }
        }))
        .await;
        let r = &resp["result"];
        assert_eq!(r["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(r["serverInfo"]["name"], SERVER_NAME);
        assert!(r["capabilities"]["tools"].is_object(), "tools capability advertised: {resp}");
    }

    #[tokio::test]
    async fn tools_list_returns_the_four_tools_with_schemas() {
        let resp = handle(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        let tools = resp["result"]["tools"].as_array().expect("a tools array");
        assert_eq!(tools.len(), 4, "exactly the v1 tool set");
        let names: std::collections::BTreeSet<&str> =
            tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(
            names,
            ["ask_vault", "list_files", "list_investigations", "run_analytics_sql"]
                .into_iter()
                .collect()
        );
        for t in tools {
            assert!(t["description"].is_string(), "each tool documents itself: {t}");
            assert_eq!(t["inputSchema"]["type"], "object", "each tool has an object inputSchema: {t}");
        }
        // The load-bearing required fields.
        let by_name = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap().clone();
        assert_eq!(by_name("ask_vault")["inputSchema"]["required"], json!(["question"]));
        assert_eq!(by_name("run_analytics_sql")["inputSchema"]["required"], json!(["sql"]));
        // No mutating tool leaked into the v1 surface (§3.3).
        for banned in [
            "create", "rename", "fork", "export", "define_metric", "export_chat", "upload", "move", "set_archived",
        ] {
            assert!(!names.contains(banned), "v1 exposes no mutating tool ({banned})");
        }
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let resp = handle(json!({ "jsonrpc": "2.0", "id": 7, "method": "does/not/exist" })).await;
        assert_eq!(resp["error"]["code"], json!(-32601), "{resp}");
    }

    #[tokio::test]
    async fn unknown_tool_is_invalid_params() {
        let resp = handle(json!({
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": { "name": "delete_everything", "arguments": {} }
        }))
        .await;
        assert_eq!(resp["error"]["code"], json!(-32602), "{resp}");
    }

    #[tokio::test]
    async fn a_notification_gets_no_response() {
        let resp = handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(resp, Value::Null, "a notification (no id) is not answered");
    }

    #[tokio::test]
    async fn an_unparseable_line_is_a_parse_error() {
        let resp = parse_error("expected value");
        assert_eq!(resp["error"]["code"], json!(-32700));
        assert_eq!(resp["id"], Value::Null);
    }
}
