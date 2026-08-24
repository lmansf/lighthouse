//! The v1 MCP tool set (openspec: add-automation §3.3) — a SMALL, read-only-
//! leaning surface, each tool a thin wrapper over one `lighthouse-core` entry:
//!
//! | tool                  | wraps                     | posture                                       |
//! |-----------------------|---------------------------|-----------------------------------------------|
//! | `ask_files`           | `ask::run_headless_ask`   | audited + egress-attributed (the chokepoint)  |
//! | `run_analytics_sql`   | `analytics::run_direct`   | guarded read-only SELECT (`guard_sql`)        |
//!
//! `list_files` retired with the vault (openspec: refocus-chat-attachments
//! §3.2): there is no ambient folder to enumerate any more, and a caller
//! already knows the paths it is asking about — it names them per call.
//!
//! §3.4 — the two posture-bearing invariants live in the ENGINE, not here:
//!   * `ask_files` reaches `synth::answer_pipeline` ONLY through
//!     `run_headless_ask`, so the ask is recorded in the audit + egress ledger
//!     exactly like an app ask — the MCP layer never calls the pipeline directly.
//!   * `run_analytics_sql` calls `analytics::run_direct`, whose `run_query` front
//!     door runs `guard_sql` FIRST: a statement that is not a read-only SELECT is
//!     refused THERE (the guard is the boundary), and this tool merely surfaces
//!     that refusal as a tool error — no MCP-side allowlist re-implements the gate.
//!
//! §3.3 — NO mutating tool in v1: no create/rename/archive/fork/export/
//! exportChat/upload/move. The only posture-bearing action is `ask_files`'s
//! egress, which rides the same ledger as the app.

use futures::StreamExt;
use serde_json::{json, Value};

use lighthouse_core::ask::{run_headless_ask, AskOpts};
use lighthouse_core::contracts::{ChatChunk, ChunkMeta};

/// The v1 tool names. A name OUTSIDE this set is a protocol error
/// (`-32602`, raised by the caller), distinct from a known tool that ran and
/// failed (which returns an `isError` result).
pub(crate) fn is_known(name: &str) -> bool {
    matches!(
        name,
        "ask_files" | "run_analytics_sql"
    )
}

/// The `tools/list` schemas — name + description + JSON-Schema `inputSchema`.
pub(crate) fn schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "ask_files",
            "description": "Answer a question over a small group of files (up to 10) through the shared, audited ask chokepoint (run_headless_ask). The files are given by absolute PATH: each is attached to a scratch conversation, ingested, answered over, and detached. Returns the answer text, its engine-stamped provenance (origin, tokens, cost estimate), the cited references, and analytics provenance when the answer is analytical. Egresses exactly as an app ask would and is recorded in the audit + egress ledger; local:true forces the on-device, zero-network model.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question to answer over the given files." },
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Absolute paths of the files to answer over (at most 10)." },
                    "local": { "type": "boolean", "description": "Force the on-device (key-less, zero-network) model. Forces the device path." }
                },
                "required": ["question", "paths"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "run_analytics_sql",
            "description": "Run a READ-ONLY SELECT over the given files with the on-device analytics engine (DataFusion). Files are given by absolute path and attached the same way ask_files attaches them. The analytics guard (guard_sql) refuses anything that is not a read-only SELECT. Returns result markdown, an optional chart spec, the provenance footer, and a result digest. No egress.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single read-only SELECT statement." },
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "Absolute paths of the files to register as tables." }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }),
    ]
}

/// Dispatch a `tools/call` by name. `Ok(value)` is the structured tool output
/// (serialized into a text content block by the protocol layer); `Err(msg)` is a
/// tool-execution failure surfaced as an `isError` result — INCLUDING a
/// `guard_sql` refusal, whose message flows straight through.
pub(crate) async fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "ask_files" => ask_files(args).await,
        "run_analytics_sql" => run_analytics_sql(args).await,
        // The caller gates unknown names via `is_known`; kept total for safety.
        other => Err(format!("unknown tool: {other}")),
    }
}

fn string_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

// --- attaching by path -------------------------------------------------------------

/// Attach `paths` to a fresh scratch conversation and return its id plus the
/// minted attachment ids. Every MCP call is single-shot, so the conversation is
/// per-call: the blobs are content-addressed and shared, and the manifest is
/// swept with every other unreferenced one.
fn attach_scratch(paths: &[String]) -> Result<(String, Vec<String>), String> {
    if paths.len() > lighthouse_core::workspace::MAX_ATTACHMENTS {
        return Err(format!(
            "at most {} files per call",
            lighthouse_core::workspace::MAX_ATTACHMENTS
        ));
    }
    // A content-derived id, so the same file set reuses the same conversation
    // and therefore the same warm caches across repeated calls.
    let mut key = paths.to_vec();
    key.sort();
    let conversation_id = format!("mcp-{:x}", md5_like(&key.join("\u{0}")));
    let mut ids = Vec::new();
    for p in paths {
        let name = std::path::Path::new(p)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = std::fs::read(p).map_err(|e| format!("{name}: {e}"))?;
        let att = lighthouse_core::workspace::attach(&conversation_id, &name, &bytes)
            .map_err(|e| format!("{name}: {e}"))?;
        lighthouse_core::workspace::ingest(&att);
        ids.push(att.id);
    }
    Ok((conversation_id, ids))
}

/// A tiny, stable, NON-cryptographic hash for the scratch conversation id (it
/// only has to be deterministic and collision-unlikely across one user's calls;
/// nothing security-bearing keys off it).
fn md5_like(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// --- ask_files (the chokepoint) ----------------------------------------------------

async fn ask_files(args: &Value) -> Result<Value, String> {
    let question = args["question"].as_str().unwrap_or("").trim().to_string();
    if question.is_empty() {
        return Err("ask_files requires a non-empty 'question'".to_string());
    }
    let paths = string_array(&args["paths"]);
    if paths.is_empty() {
        return Err("ask_files requires at least one path".to_string());
    }
    let (conversation_id, attachment_ids) = attach_scratch(&paths)?;
    let included = Vec::new();
    let opts = AskOpts {
        local: args["local"].as_bool().unwrap_or(false),
        conversation_id: Some(conversation_id),
        attachment_ids,
    };

    // Drain the SAME stream the app sees. `run_headless_ask` is the ONLY path to
    // `answer_pipeline` from here, so this ask is audited + egress-attributed by
    // construction (§3.4). History is empty: a v1 tool call is single-shot.
    let mut stream = run_headless_ask(question, included, Vec::new(), opts);

    // Draft-aware assembly, verbatim from `synth.rs`: the local model's draft is
    // a provisional extractive answer REPLACED in place by the first
    // authoritative (non-draft) delta — concatenating blindly would duplicate it.
    let mut text = String::new();
    let mut draft_active = false;
    let mut final_chunk: Option<ChatChunk> = None;
    while let Some(c) = stream.next().await {
        if !c.delta.is_empty() {
            if c.draft == Some(true) {
                draft_active = true;
            } else if draft_active {
                draft_active = false;
                text.clear();
            }
            text.push_str(&c.delta);
        }
        if c.done {
            final_chunk = Some(c);
        }
    }
    let Some(done) = final_chunk else {
        return Err("ask_files produced no answer".to_string());
    };

    // Provenance is READ from the engine's final-chunk stamp — never recomputed.
    let provenance = provenance_of(done.meta.as_ref());
    let references = done.references.unwrap_or_default();
    let analytics = done.analytics;

    let mut result = serde_json::Map::new();
    result.insert("answer".into(), Value::String(text));
    result.insert("provenance".into(), provenance);
    result.insert("references".into(), json!(references));
    // Analytics provenance rides only an analytical answer.
    if let Some(a) = analytics {
        result.insert("analytics".into(), json!(a));
    }
    Ok(Value::Object(result))
}

/// The provenance object a caller reports, built from the engine's `ChunkMeta`
/// stamp (and its cost meter): `{origin, input/output/total tokens, reported,
/// costEstimateUsd, sourceFileCount}` — the same fields the `lighthouse` CLI's
/// `--json` provenance carries, so the two headless surfaces report identically.
fn provenance_of(meta: Option<&ChunkMeta>) -> Value {
    let origin = meta
        .map(|m| m.origin.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let source_file_count = meta.map(|m| m.source_file_count).unwrap_or(0);
    let cost = meta.and_then(|m| m.cost.as_ref());
    json!({
        "origin": origin,
        "inputTokens": cost.map(|c| c.input_tokens),
        "outputTokens": cost.map(|c| c.output_tokens),
        "totalTokens": cost.map(|c| c.total_tokens),
        "reported": cost.map(|c| c.reported).unwrap_or(false),
        "costEstimateUsd": cost.and_then(|c| c.cost_estimate_usd),
        "sourceFileCount": source_file_count,
    })
}

// --- run_analytics_sql (guarded) ---------------------------------------------------

async fn run_analytics_sql(args: &Value) -> Result<Value, String> {
    let sql = args["sql"].as_str().unwrap_or("").trim().to_string();
    if sql.is_empty() {
        return Err("run_analytics_sql requires a non-empty 'sql'".to_string());
    }
    let paths = string_array(&args["paths"]);
    let (conversation_id, file_ids) = attach_scratch(&paths)?;
    // `run_direct` → `run_query` → `guard_sql`: a non-SELECT is refused at the
    // guard (the boundary), and its message flows out as this tool's error.
    let r =
        lighthouse_core::analytics::run_direct(&conversation_id, &sql, &file_ids).await?;
    Ok(json!({
        "markdown": r.markdown,
        "chart": r.chart,
        "footer": r.footer,
        "resultDigest": r.result_digest,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    /// ONE guard per test. Mirrors lighthouse-core's `common::lock_env`, but this
    /// is a SEPARATE test binary with its own process-global statics (the caches,
    /// the env), so it serializes its own store-touching tests on its own lock.
    /// Non-reentrant — never nest it within a test.
    fn lock_env(dir: &Path) -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // Since the 0.15.0 re-root, engine state follows LIGHTHOUSE_APP_STATE_DIR
        // alone — keep it inside this test's own temp dir.
        std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", dir.join(".rag-vault"));
        std::env::remove_var("LIGHTHOUSE_API_TOKEN");
        std::env::remove_var("LIGHTHOUSE_DESKTOP");
        guard
    }

    fn write(path: &Path, text: &str) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        path.display().to_string()
    }

    /// The two-file model-free meta fixture (the shared `ask_test` / provenance
    /// idiom), written where a caller would keep its files. Returns the PATHS —
    /// since 0.15.0 a caller names files, and the tool attaches them itself.
    fn seed_files(dir: &Path) -> Vec<String> {
        vec![
            write(
                &dir.join("sales.csv"),
                "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
            ),
            write(&dir.join("notes.md"), "# planning\nsome prose\n"),
        ]
    }

    /// The result body of a `tools/call` response driven through the pure handler.
    fn tool_call(name: &str, args: Value) -> Value {
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": args }
        })
    }

    /// Parse the JSON structured output out of a tool result's text content block.
    fn payload(resp: &Value) -> Value {
        let text = resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("a text content block: {resp}"));
        serde_json::from_str(text).unwrap_or_else(|_| panic!("JSON in the text block: {text}"))
    }

    /// §3.6 — `ask_files` returns a GROUNDED answer + provenance over the files
    /// it was given with `local:true`, through the shared chokepoint. The
    /// `device` origin + the two cited fixture files are the grounding proof.
    #[tokio::test]
    async fn ask_files_returns_grounded_device_answer_with_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
        lighthouse_core::answer_cache::reset_store();
        let paths = seed_files(dir.path());

        let resp = crate::protocol::handle(tool_call(
            "ask_files",
            json!({
                "question": "What's new this week?",
                "local": true,
                "paths": paths
            }),
        ))
        .await;

        assert_eq!(resp["result"]["isError"], json!(false), "a grounded ask is not an error: {resp}");
        let p = payload(&resp);
        assert!(!p["answer"].as_str().unwrap_or("").is_empty(), "a non-empty answer: {p}");
        assert_eq!(p["provenance"]["origin"], "device", "local:true forces the device origin");
        assert_eq!(
            p["references"].as_array().map(|a| a.len()).unwrap_or(0),
            2,
            "the model-free meta answer cites both attached fixture files (grounded): {p}"
        );
        // Provenance is a first-class field with the cost shape, present even on
        // a device answer (the "always emit provenance" rule).
        assert!(p["provenance"].get("sourceFileCount").is_some(), "provenance carries the source count: {p}");
    }

    /// §3.2 — `list_files` retired with the vault: an ambient folder listing has
    /// no subject when the corpus is the caller's own named paths. It must be an
    /// UNKNOWN tool (a protocol error), never a tool that quietly returns
    /// nothing — a client that still calls it should be told, not misled.
    #[tokio::test]
    async fn list_files_is_gone_from_the_surface() {
        assert!(!crate::tools::is_known("list_files"));
        assert!(!crate::tools::is_known("ask_vault"), "the vault ask retired with it");
        let names: Vec<String> = crate::tools::schemas()
            .iter()
            .map(|s| s["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, vec!["ask_files".to_string(), "run_analytics_sql".to_string()]);

        let resp = crate::protocol::handle(tool_call("list_files", json!({}))).await;
        assert!(
            resp["error"].is_object(),
            "an unknown tool is a protocol error, not an empty success: {resp}"
        );
    }

    /// §3.6 / §3.4 — a read-only SELECT runs on-device; a non-SELECT is refused
    /// by `guard_sql` (the guard is the boundary, surfaced as an `isError`).
    #[tokio::test]
    async fn run_analytics_sql_runs_a_select_and_refuses_a_non_select() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        let sales = write(&dir.path().join("sales.csv"), "region,amount\nNE,100\nNW,50\n");

        // A read-only SELECT runs and returns result markdown.
        let ok = crate::protocol::handle(tool_call(
            "run_analytics_sql",
            json!({
                "sql": "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC",
                "paths": [sales]
            }),
        ))
        .await;
        assert_eq!(ok["result"]["isError"], json!(false), "a SELECT runs: {ok}");
        let p = payload(&ok);
        assert!(p["markdown"].as_str().unwrap_or("").contains("NE"), "result markdown present: {p}");

        // A non-SELECT is refused by the guard — the boundary is the analytics
        // layer, not the MCP layer; nothing is written.
        let bad = crate::protocol::handle(tool_call(
            "run_analytics_sql",
            json!({ "sql": "DROP TABLE sales", "paths": [sales] }),
        ))
        .await;
        assert_eq!(bad["result"]["isError"], json!(true), "a non-SELECT is refused: {bad}");
        let msg = bad["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(msg.contains("SELECT"), "the guard's reason is surfaced: {msg}");
    }
}
