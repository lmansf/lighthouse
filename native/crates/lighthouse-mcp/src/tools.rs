//! The v1 MCP tool set (openspec: add-automation §3.3) — a SMALL, read-only-
//! leaning surface, each tool a thin wrapper over one `lighthouse-core` entry:
//!
//! | tool                  | wraps                     | posture                                       |
//! |-----------------------|---------------------------|-----------------------------------------------|
//! | `ask_vault`           | `ask::run_headless_ask`   | audited + egress-attributed (the chokepoint)  |
//! | `list_files`          | `vault::list_nodes`       | on-device read                                |
//! | `list_investigations` | `investigations::listing` | on-device read (derived membership)           |
//! | `run_analytics_sql`   | `analytics::run_direct`   | guarded read-only SELECT (`guard_sql`)        |
//!
//! §3.4 — the two posture-bearing invariants live in the ENGINE, not here:
//!   * `ask_vault` reaches `synth::answer_pipeline` ONLY through
//!     `run_headless_ask`, so the ask is recorded in the audit + egress ledger
//!     exactly like an app ask — the MCP layer never calls the pipeline directly.
//!   * `run_analytics_sql` calls `analytics::run_direct`, whose `run_query` front
//!     door runs `guard_sql` FIRST: a statement that is not a read-only SELECT is
//!     refused THERE (the guard is the boundary), and this tool merely surfaces
//!     that refusal as a tool error — no MCP-side allowlist re-implements the gate.
//!
//! §3.3 — NO mutating tool in v1: no create/rename/archive/fork/export/
//! defineMetric/exportChat/upload/move. The only posture-bearing action is
//! `ask_vault`'s egress, which rides the same ledger as the app.

use futures::StreamExt;
use serde_json::{json, Value};

use lighthouse_core::ask::{run_headless_ask, AskOpts};
use lighthouse_core::contracts::{ChatChunk, ChunkMeta};

/// The four v1 tool names. A name OUTSIDE this set is a protocol error
/// (`-32602`, raised by the caller), distinct from a known tool that ran and
/// failed (which returns an `isError` result).
pub(crate) fn is_known(name: &str) -> bool {
    matches!(
        name,
        "ask_vault" | "list_files" | "list_investigations" | "run_analytics_sql"
    )
}

/// The `tools/list` schemas — name + description + JSON-Schema `inputSchema`.
pub(crate) fn schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "ask_vault",
            "description": "Answer a question over the vault through the shared, audited ask chokepoint (run_headless_ask). Returns the answer text, its engine-stamped provenance (origin, tokens, cost estimate), the cited references, and analytics provenance when the answer is analytical. Egresses exactly as an app ask would and is recorded in the audit + egress ledger; local:true (or a local-only investigation) forces the on-device, zero-network model.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question to answer over the vault." },
                    "local": { "type": "boolean", "description": "Force the on-device (key-less, zero-network) model. Most-restrictive wins: this OR a local-only investigation forces device." },
                    "investigation": { "type": "string", "description": "Run the ask inside this investigation id (its scope and provider policy apply)." },
                    "included_file_ids": { "type": "array", "items": { "type": "string" }, "description": "The RAG-included vault file ids to answer over (the transports' includedFileIds set)." }
                },
                "required": ["question"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_files",
            "description": "List the vault's file/folder nodes (on-device read, no egress). Each node carries id, name, kind, ragIncluded, and effective local-only state.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "list_investigations",
            "description": "List the investigations with their derived membership (pinRefs + noteRefs). On-device read, no egress.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "run_analytics_sql",
            "description": "Run a READ-ONLY SELECT over the given vault file ids with the on-device analytics engine (DataFusion). The analytics guard (guard_sql) refuses anything that is not a read-only SELECT. Returns result markdown, an optional chart spec, the provenance footer, and a result digest. No egress.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single read-only SELECT statement." },
                    "file_ids": { "type": "array", "items": { "type": "string" }, "description": "Vault file ids to register as tables for the query." }
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
        "ask_vault" => ask_vault(args).await,
        "list_files" => list_files(),
        "list_investigations" => list_investigations(),
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

// --- ask_vault (the chokepoint) ----------------------------------------------------

async fn ask_vault(args: &Value) -> Result<Value, String> {
    let question = args["question"].as_str().unwrap_or("").trim().to_string();
    if question.is_empty() {
        return Err("ask_vault requires a non-empty 'question'".to_string());
    }
    // `included_file_ids` ⇒ the `included_ids` positional (the RAG-included set
    // the transports pass from `includedFileIds`); attachments are not exposed
    // in v1, and the MCP server serves the AMBIENT vault (no per-call `--vault`).
    let included = string_array(&args["included_file_ids"]);
    let opts = AskOpts {
        local: args["local"].as_bool().unwrap_or(false),
        vault: None,
        investigation_id: args["investigation"].as_str().map(String::from),
        attachment_ids: Vec::new(),
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
        return Err("ask_vault produced no answer".to_string());
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

// --- reads -------------------------------------------------------------------------

fn list_files() -> Result<Value, String> {
    Ok(json!({ "files": lighthouse_core::vault::list_nodes() }))
}

fn list_investigations() -> Result<Value, String> {
    Ok(json!({ "investigations": lighthouse_core::investigations::listing() }))
}

// --- run_analytics_sql (guarded) ---------------------------------------------------

async fn run_analytics_sql(args: &Value) -> Result<Value, String> {
    let sql = args["sql"].as_str().unwrap_or("").trim().to_string();
    if sql.is_empty() {
        return Err("run_analytics_sql requires a non-empty 'sql'".to_string());
    }
    let file_ids = string_array(&args["file_ids"]);
    // `run_direct` → `run_query` → `guard_sql`: a non-SELECT is refused at the
    // guard (the boundary), and its message flows out as this tool's error.
    let r = lighthouse_core::analytics::run_direct(&sql, &file_ids).await?;
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
    /// is a SEPARATE test binary with its own process-global statics (the walk
    /// cache, the env), so it serializes its own store-touching tests on its own
    /// lock. Non-reentrant — never nest it within a test.
    fn lock_env(vault: &Path) -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        std::env::set_var("VAULT_DIR", vault);
        std::env::remove_var("LIGHTHOUSE_API_TOKEN");
        std::env::remove_var("LIGHTHOUSE_DESKTOP");
        lighthouse_core::vault::invalidate_walk_cache();
        guard
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The two-file model-free meta fixture (the shared `ask_test` / provenance
    /// idiom): both files included + searchable, so a `--local` ask answers
    /// on-device with ZERO network and cites both.
    fn seed_meta_vault(dir: &Path) {
        write(
            &dir.join("sales.csv"),
            "date,region,amount\n2026-01-05,NE,100\n2026-01-06,NW,50\n",
        );
        write(&dir.join("notes.md"), "# planning\nsome prose\n");
        lighthouse_core::vault::invalidate_walk_cache();
        lighthouse_core::vault::set_included("sales.csv", true);
        lighthouse_core::vault::set_included("notes.md", true);
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

    /// §3.6 — `ask_vault` returns a GROUNDED answer + provenance over a fixture
    /// vault with `local:true`, through the shared chokepoint. The `device`
    /// origin + the two cited fixture files are the grounding proof.
    #[tokio::test]
    async fn ask_vault_returns_grounded_device_answer_with_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
        std::env::remove_var("LIGHTHOUSE_PROFILE_FILE");
        lighthouse_core::answer_cache::reset_store();
        seed_meta_vault(dir.path());

        let resp = crate::protocol::handle(tool_call(
            "ask_vault",
            json!({
                "question": "What's new this week?",
                "local": true,
                "included_file_ids": ["sales.csv", "notes.md"]
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
            "the model-free meta answer cites both included fixture files (grounded): {p}"
        );
        // Provenance is a first-class field with the cost shape, present even on
        // a device answer (the "always emit provenance" rule).
        assert!(p["provenance"].get("sourceFileCount").is_some(), "provenance carries the source count: {p}");
    }

    /// §3.6 — `list_files` returns the vault node list in the `FileNode` shape.
    #[tokio::test]
    async fn list_files_returns_vault_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        write(&dir.path().join("sales.csv"), "region,amount\nNE,100\n");
        lighthouse_core::vault::invalidate_walk_cache();

        let resp = crate::protocol::handle(tool_call("list_files", json!({}))).await;
        assert_eq!(resp["result"]["isError"], json!(false), "{resp}");
        let p = payload(&resp);
        let files = p["files"].as_array().expect("a files array");
        let node = files
            .iter()
            .find(|n| n["name"] == "sales.csv")
            .unwrap_or_else(|| panic!("the seeded file is listed: {p}"));
        assert!(
            node.get("id").is_some() && node.get("kind").is_some() && node.get("ragIncluded").is_some(),
            "each node carries the FileNode shape: {node}"
        );
    }

    /// §3.6 — `list_investigations` returns the enriched views (record +
    /// DERIVED pinRefs/noteRefs).
    #[tokio::test]
    async fn list_investigations_returns_views_with_derived_membership() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        lighthouse_core::vault::invalidate_walk_cache();
        lighthouse_core::investigations::create(
            "Q3 revenue",
            &[],
            lighthouse_core::investigations::ProviderPolicy::Default,
        )
        .expect("create an investigation");

        let resp = crate::protocol::handle(tool_call("list_investigations", json!({}))).await;
        assert_eq!(resp["result"]["isError"], json!(false), "{resp}");
        let p = payload(&resp);
        let invs = p["investigations"].as_array().expect("an investigations array");
        let inv = invs
            .iter()
            .find(|i| i["name"] == "Q3 revenue")
            .unwrap_or_else(|| panic!("the created investigation is listed: {p}"));
        assert!(
            inv["pinRefs"].is_array() && inv["noteRefs"].is_array(),
            "the view carries derived pinRefs + noteRefs: {inv}"
        );
        assert!(
            inv.get("id").is_some() && inv.get("scopeFileIds").is_some(),
            "the flattened record fields are present: {inv}"
        );
    }

    /// §3.6 / §3.4 — a read-only SELECT runs on-device; a non-SELECT is refused
    /// by `guard_sql` (the guard is the boundary, surfaced as an `isError`).
    #[tokio::test]
    async fn run_analytics_sql_runs_a_select_and_refuses_a_non_select() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = lock_env(dir.path());
        write(&dir.path().join("sales.csv"), "region,amount\nNE,100\nNW,50\n");
        lighthouse_core::vault::invalidate_walk_cache();
        lighthouse_core::vault::set_included("sales.csv", true);

        // A read-only SELECT runs and returns result markdown.
        let ok = crate::protocol::handle(tool_call(
            "run_analytics_sql",
            json!({
                "sql": "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC",
                "file_ids": ["sales.csv"]
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
            json!({ "sql": "DROP TABLE sales", "file_ids": ["sales.csv"] }),
        ))
        .await;
        assert_eq!(bad["result"]["isError"], json!(true), "a non-SELECT is refused: {bad}");
        let msg = bad["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(msg.contains("SELECT"), "the guard's reason is surfaced: {msg}");
    }
}
