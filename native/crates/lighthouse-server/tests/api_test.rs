//! End-to-end wire-protocol tests: the axum façade mounted on an ephemeral
//! loopback port, exercised over real HTTP exactly as the React UI does —
//! including the NDJSON chat stream, the layered local-API auth, and uploads.
//!
//! Since 0.15.0 the wire has no tree: the include / localOnly / rules / source
//! / move / rename / newFolder / addReference / remove / restore ops went with
//! the vault, and what a client does instead is upload into a CONVERSATION and
//! ask over it. The cases that exercised those ops are gone with them; what
//! survives is the flow that replaced them.

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};

/// The engine reads its state root (and the auth token) from process env at
/// call time, so tests that each want their own state must not overlap.
static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// A live server on an ephemeral loopback port with a fresh state root.
async fn spawn_server() -> (String, tempfile::TempDir) {
    let state_dir = tempfile::tempdir().unwrap();
    // Since the 0.15.0 re-root, engine state (and the workspace) follow
    // LIGHTHOUSE_APP_STATE_DIR alone — keep each server's state inside its own
    // temp dir so tests stay isolated from the developer's real data home.
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", state_dir.path().join(".rag-vault"));
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    std::env::remove_var("ANTHROPIC_API_KEY");

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, lighthouse_server::app())
            .await
            .unwrap();
    });
    (format!("http://127.0.0.1:{port}"), state_dir)
}

/// Upload one file into a conversation's workspace and return the reply.
async fn attach(
    client: &reqwest::Client,
    base: &str,
    conv: &str,
    name: &str,
    body: &str,
) -> Value {
    let form = reqwest::multipart::Form::new()
        .part(
            "files",
            reqwest::multipart::Part::bytes(body.as_bytes().to_vec()).file_name(name.to_string()),
        )
        .text("conversationId", conv.to_string());
    client
        .post(format!("{base}/api/upload"))
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_protocol_end_to_end() {
    let _env = lock_env();
    let (base, state_dir) = spawn_server().await;
    let client = reqwest::Client::new();

    // --- GET /api/rag: the tree is gone; the payload keeps its SHAPE ----------
    let rag: Value = client
        .get(format!("{base}/api/rag"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rag["desktop"], false);
    assert!(rag["sources"].as_array().unwrap().is_empty(), "no sources since 0.15.0");
    assert!(rag["nodes"].as_array().unwrap().is_empty(), "no tree since 0.15.0");

    // --- POST /api/upload: multipart into a conversation's workspace ----------
    const CONV: &str = "conv-wire";
    let up = attach(
        &client,
        &base,
        CONV,
        "budget.md",
        "The lighthouse budget forecast lists revenue targets for the quarter.",
    )
    .await;
    let budget_id = up["added"][0]["newId"].as_str().unwrap().to_string();
    assert!(budget_id.starts_with("att-"), "an attachment id, not a path: {budget_id}");
    assert!(up["skipped"].as_array().unwrap().is_empty());
    let recipe = attach(&client, &base, CONV, "recipe.md", "Sourdough recipes and baking notes.").await;
    let recipe_id = recipe["added"][0]["newId"].as_str().unwrap().to_string();

    // The user's own filesystem is untouched — the bytes live in the workspace.
    assert!(!state_dir.path().join("budget.md").exists());
    assert!(
        state_dir.path().join(".rag-vault/workspace/blobs").exists(),
        "the blob store is where attachments land"
    );

    // --- POST /api/chat: NDJSON stream, extractive fallback (no key) -----------
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "what are the revenue targets?",
            "conversationId": CONV,
            "history": [],
        }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("application/x-ndjson"));
    let body = res.text().await.unwrap();
    let lines: Vec<Value> = body
        .lines()
        .map(|l| serde_json::from_str(l).expect("every line is a ChatChunk"))
        .collect();
    assert!(lines.len() > 3, "streamed word-by-word, got {} lines", lines.len());
    for l in &lines[..lines.len() - 1] {
        assert_eq!(l["done"], false);
        assert!(l["references"].is_null());
    }
    let last = lines.last().unwrap();
    assert_eq!(last["done"], true);
    assert_eq!(last["delta"], "");
    assert_eq!(last["references"][0]["fileId"], budget_id.as_str());
    let answer: String = lines[..lines.len() - 1]
        .iter()
        .map(|l| l["delta"].as_str().unwrap_or(""))
        .collect();
    assert!(answer.contains("revenue targets"), "extractive answer quotes the passage");

    // --- Another conversation's attachments are never candidates --------------
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "what are the revenue targets?",
            "conversationId": "conv-stranger",
        }))
        .send()
        .await
        .unwrap();
    let body = res.text().await.unwrap();
    let cited: Vec<String> = body
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|c| c["references"].as_array().cloned())
        .flatten()
        .filter_map(|r| r["name"].as_str().map(String::from))
        .collect();
    assert!(cited.is_empty(), "a conversation with nothing attached cites nothing: {cited:?}");

    // --- Inventory intent over the wire ---------------------------------------
    // Anchored inventory asks are answered by the deterministic meta-answer
    // stage (openspec: add-vault-meta-answers) — instant, no model, real
    // references — instead of the retrieval-context listing.
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({ "question": "show me all files", "conversationId": CONV }))
        .send()
        .await
        .unwrap();
    let body = res.text().await.unwrap();
    let lines: Vec<Value> = body
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let full: String = lines
        .iter()
        .filter_map(|l| l["delta"].as_str().map(String::from))
        .collect();
    assert!(
        full.contains("**2 files** visible to AI"),
        "meta inventory answer enumerates, got: {full}"
    );
    assert!(
        full.contains("budget.md") && full.contains("recipe.md"),
        "both names listed: {full}"
    );
    let refs = &lines.last().unwrap()["references"];
    assert_eq!(refs.as_array().map(|a| a.len()), Some(2), "both files cited: {refs}");

    // --- The inspector reads one attachment, scoped to its conversation -------
    let insp: Value = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "inspect", "conversationId": CONV, "fileId": recipe_id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(insp["name"], "recipe.md");
    assert_eq!(insp["chunkMode"], "prose");
    assert!(
        insp.get("included").is_none() && insp.get("localOnly").is_none(),
        "the inclusion gate's fields went with it: {insp}"
    );

    // --- /api/profile lifecycle --------------------------------------------------
    let p: Value = client
        .get(format!("{base}/api/profile"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p["step"], "mode", "first run starts at the interface-mode chooser");
    assert_eq!(p["hasApiKey"], false);
    let p: Value = client
        .post(format!("{base}/api/profile"))
        .json(&json!({ "op": "selectModel", "providerId": "anthropic", "modelId": "claude-haiku-4-5", "apiKey": "sk-test" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Picking a model is the LAST onboarding step since 0.15.0 — the
    // default-inclusion screen that used to follow it retired with the vault.
    assert_eq!(p["step"], "done");
    assert_eq!(p["hasApiKey"], true, "key presence surfaces, never the key");
    // 0.11: keys persist SEALED in the install-global secrets store, never as
    // plaintext in profile.json (and so survive sign-out / vault switches).
    let raw = std::fs::read_to_string(state_dir.path().join(".rag-vault/profile.json")).unwrap();
    assert!(!raw.contains("sk-test"), "raw key must not sit in profile.json");
    let sealed =
        std::fs::read_to_string(state_dir.path().join(".rag-vault/secrets.json")).unwrap();
    assert!(!sealed.contains("sk-test"), "raw key must not sit in secrets.json");
    assert_eq!(
        lighthouse_core::profile::resolved_key_for("anthropic").as_deref(),
        Some("sk-test"),
        "key resolvable by the engine at request time"
    );
    assert!(
        !serde_json::to_string(&p).unwrap().contains("sk-test"),
        "key never in a response"
    );

    // --- /api/model status (no model in this environment) ------------------------
    let model: Value = client
        .get(format!("{base}/api/model"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(model["status"], "absent");

    // --- /api/open is desktop-gated ----------------------------------------------
    let res = client
        .post(format!("{base}/api/open"))
        .json(&json!({ "conversationId": CONV, "nodeId": recipe_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status().as_u16(),
        403,
        "web build must refuse to open local files"
    );

    // --- /api/settings no-ops off desktop -----------------------------------------
    let s: Value = client
        .get(format!("{base}/api/settings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(s["desktop"], false);
    assert_eq!(s["runOnStartup"], true, "defaults on");
    assert_eq!(s["uiMode"], Value::Null, "no mode until the chooser answers");
    assert_eq!(
        s["summonShortcut"], "ctrl+super+shift+space",
        "the default keyed summon chord when none is set"
    );

}

/// The export door (openspec: add-answer-artifacts, re-pointed by
/// refocus-chat-attachments): a client-composed artifact is handed BACK for the
/// OS save dialog rather than written into a vault allowlist folder. The ext
/// allowlist stays the APP's — a client never names an arbitrary extension —
/// and anything off it is a 400 that returns nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_chat_returns_the_artifact_and_holds_the_ext_allowlist() {
    let _env = lock_env();
    let (base, state_dir) = spawn_server().await;
    let client = reqwest::Client::new();
    let post = |body: Value| client.post(format!("{base}/api/rag")).json(&body).send();

    // --- Default (no ext): a markdown note, returned not written. ----------
    let res: Value = post(json!({ "op": "exportChat", "title": "Team sync", "markdown": "# hi" }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(res["savedName"], "Team sync.md");
    assert_eq!(res["content"], "# hi", "the content rides back for the save dialog");
    assert!(res["savedId"].is_null(), "nothing was written, so there is no id");

    // --- html is the other allowed type; a hostile title is inert because the
    //     app writes nothing — the name is a HINT the save dialog pre-fills. --
    let res: Value = post(json!({
        "op": "exportChat",
        "title": "../revenue by region",
        "markdown": "<!doctype html>\n<html lang=\"en\"></html>",
        "ext": "html",
    }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(res["savedName"].as_str().unwrap().ends_with(".html"));
    assert!(res["content"].as_str().unwrap().contains("<!doctype html>"));

    // --- Off-allowlist ext rejects with 400 and returns no content. --------
    for bad in [
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "ext": "exe" }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "ext": 5 }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "ext": null }),
        json!({ "op": "exportChat", "title": "x", "markdown": "   " }),
    ] {
        let res = post(bad.clone()).await.unwrap();
        assert_eq!(res.status().as_u16(), 400, "must reject: {bad}");
    }

    // The whole point: the app's own state dir gained no export files at all.
    assert!(
        !state_dir.path().join("Lighthouse Notes").exists()
            && !state_dir.path().join("Lighthouse Results").exists(),
        "0.15.0 exports write nothing — the user's save dialog does"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_layers_reject_cross_origin_and_bad_tokens() {
    let _env = lock_env();
    let (base, _vault) = spawn_server().await;
    let client = reqwest::Client::new();

    // A cross-site Origin is rejected even from loopback (CSRF defense).
    let res = client
        .post(format!("{base}/api/rag"))
        .header("origin", "https://evil.example.com")
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["error"], "cross-origin request rejected");

    // A loopback Origin on a DIFFERENT port is rejected (port pinning).
    let res = client
        .post(format!("{base}/api/rag"))
        .header("origin", "http://127.0.0.1:1")
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);

    // A same-port loopback Origin passes (the renderer's own requests).
    let res = client
        .post(format!("{base}/api/rag"))
        .header("origin", base.clone())
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());

    // With a token configured, header-less callers must present it.
    std::env::set_var("LIGHTHOUSE_API_TOKEN", "sekret");
    let res = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status().as_u16(),
        403,
        "no Origin + no token ⇒ rejected"
    );
    let res = client
        .post(format!("{base}/api/rag"))
        .header("x-lighthouse-token", "wrong")
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = client
        .post(format!("{base}/api/rag"))
        .header("x-lighthouse-token", "sekret")
        .json(&json!({ "op": "listReports" }))
        .send()
        .await
        .unwrap();
    assert!(
        res.status().is_success(),
        "the shell's per-launch token authenticates"
    );
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
}

/// The 0.15.0 flow over the wire (openspec: refocus-chat-attachments): an
/// upload that names a conversation lands in that conversation's WORKSPACE,
/// not the vault folder, and the ask that follows answers from it — with the
/// 10-file cap refusing the eleventh.
#[tokio::test]
async fn uploading_to_a_conversation_attaches_and_answers() {
    let _guard = lock_env();
    let (base, vault_dir) = spawn_server().await;
    let client = reqwest::Client::new();

    let upload = |name: &'static str, body: &'static str, conv: Option<&'static str>| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let mut form = reqwest::multipart::Form::new().part(
                "files",
                reqwest::multipart::Part::bytes(body.as_bytes().to_vec()).file_name(name),
            );
            if let Some(c) = conv {
                form = form.text("conversationId", c);
            }
            client
                .post(format!("{base}/api/upload"))
                .multipart(form)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };

    let up = upload(
        "quarterly.md",
        "# Q3 revenue\nNortheast revenue rose sharply this quarter.\n",
        Some("conv-1"),
    )
    .await;
    let new_id = up["added"][0]["newId"].as_str().unwrap().to_string();
    assert!(new_id.starts_with("att-"), "an attachment id, not a vault path: {new_id}");
    assert!(
        !vault_dir.path().join("quarterly.md").exists(),
        "the user's folder is untouched — bytes live in the workspace"
    );

    // The ask names the conversation, and answers from its attachment.
    let chat: String = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "What happened to Northeast revenue?",
            "conversationId": "conv-1",
        }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        chat.contains("quarterly.md"),
        "the answer cites the conversation's attachment: {chat}"
    );

    // The engine's cap holds over the wire: the eleventh file is refused with
    // a reason, and the first ten stay attached.
    for i in 1..MAX_ATTACHMENTS_OVER_WIRE {
        let body: &'static str = Box::leak(format!("filler {i}\n").into_boxed_str());
        let name: &'static str = Box::leak(format!("f{i}.md").into_boxed_str());
        let r = upload(name, body, Some("conv-1")).await;
        assert!(r["skipped"].as_array().unwrap().is_empty(), "file {i} attached");
    }
    let over = upload("one-more.md", "too many\n", Some("conv-1")).await;
    assert!(over["added"].as_array().unwrap().is_empty(), "the eleventh is refused");
    assert!(
        over["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("at most 10 files"),
        "the refusal says why: {over}"
    );
}

/// The engine's cap, restated where the wire test can read it.
const MAX_ATTACHMENTS_OVER_WIRE: usize = lighthouse_core::workspace::MAX_ATTACHMENTS;
