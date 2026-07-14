//! End-to-end wire-protocol tests: the axum façade mounted on an ephemeral
//! loopback port, exercised over real HTTP exactly as the React UI does —
//! including the NDJSON chat stream, the layered local-API auth, uploads, and
//! the curation ops.

use std::sync::{Mutex, MutexGuard, OnceLock};

use serde_json::{json, Value};

/// The engine reads VAULT_DIR (and the auth token) from process env at call
/// time, so tests that each want their own vault must not overlap.
static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// A live server on an ephemeral loopback port with a fresh vault.
async fn spawn_server() -> (String, tempfile::TempDir) {
    let vault_dir = tempfile::tempdir().unwrap();
    std::env::set_var("VAULT_DIR", vault_dir.path());
    std::env::remove_var("LICENSE_API_URL");
    std::env::remove_var("LICENSE_ENFORCE");
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    std::env::remove_var("ANTHROPIC_API_KEY");
    // Pin default inclusion to opt_in (default-excluded) for determinism.
    let state_dir = vault_dir.path().join(".rag-vault");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("experiments.json"),
        r#"{ "onboarding": "key_first", "default_inclusion": "opt_in", "source": "override" }"#,
    )
    .unwrap();
    lighthouse_core::vault::invalidate_walk_cache();

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, lighthouse_server::app())
            .await
            .unwrap();
    });
    (format!("http://127.0.0.1:{port}"), vault_dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wire_protocol_end_to_end() {
    let _env = lock_env();
    let (base, vault_dir) = spawn_server().await;
    let client = reqwest::Client::new();

    // --- GET /api/rag: empty vault lists cleanly -------------------------------
    let rag: Value = client
        .get(format!("{base}/api/rag"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rag["desktop"], false);
    assert_eq!(rag["sources"][0]["id"], "vault");
    assert_eq!(rag["sources"][0]["name"], "Local Vault");
    assert!(rag["nodes"].as_array().unwrap().is_empty());

    // --- POST /api/upload: multipart with folder structure ---------------------
    let form = reqwest::multipart::Form::new()
        .part(
            "files",
            reqwest::multipart::Part::bytes(
                b"The lighthouse budget forecast lists revenue targets for the quarter.".to_vec(),
            )
            .file_name("budget.md"),
        )
        .text("paths", "finance/budget.md")
        .part(
            "files",
            reqwest::multipart::Part::bytes(b"Sourdough recipes and baking notes.".to_vec())
                .file_name("recipe.md"),
        )
        .text("paths", "recipe.md");
    let up: Value = client
        .post(format!("{base}/api/upload"))
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        up["added"][0]["newId"], "finance/budget.md",
        "folder structure recreated"
    );
    assert_eq!(up["added"][1]["newId"], "recipe.md");
    assert!(up["skipped"].as_array().unwrap().is_empty());
    assert!(vault_dir.path().join("finance/budget.md").exists());

    // --- POST /api/rag include + search ----------------------------------------
    for (op, extra) in [
        ("include", json!({ "nodeId": "finance", "included": true })),
        (
            "include",
            json!({ "nodeId": "recipe.md", "included": true }),
        ),
    ] {
        let mut body = json!({ "op": op });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let r = client
            .post(format!("{base}/api/rag"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert!(r.status().is_success());
    }
    let search: Value = client
        .post(format!("{base}/api/rag"))
        .json(&json!({
            "op": "search",
            "query": "what are the revenue targets?",
            "includedFileIds": ["finance/budget.md", "recipe.md"],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(search["references"][0]["fileId"], "finance/budget.md");

    // --- POST /api/chat: NDJSON stream, extractive fallback (no key) -----------
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "what are the revenue targets?",
            "includedFileIds": ["finance/budget.md", "recipe.md"],
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
    assert!(
        lines.len() > 3,
        "streamed word-by-word, got {} lines",
        lines.len()
    );
    for l in &lines[..lines.len() - 1] {
        assert_eq!(l["done"], false);
        assert!(l["references"].is_null());
    }
    let last = lines.last().unwrap();
    assert_eq!(last["done"], true);
    assert_eq!(last["delta"], "");
    assert_eq!(last["references"][0]["fileId"], "finance/budget.md");
    let answer: String = lines[..lines.len() - 1]
        .iter()
        .map(|l| l["delta"].as_str().unwrap_or(""))
        .collect();
    assert!(
        answer.contains("revenue targets"),
        "extractive answer quotes the passage"
    );

    // --- Listing intent over the wire -------------------------------------------
    // Anchored inventory asks are answered by the deterministic vault
    // meta-answer stage (openspec: add-vault-meta-answers) — instant, no
    // model, real references — instead of the retrieval-context listing.
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "show me all files",
            "includedFileIds": ["finance/budget.md", "recipe.md"],
        }))
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

    // --- /api/profile lifecycle --------------------------------------------------
    let p: Value = client
        .get(format!("{base}/api/profile"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p["step"], "sign-in");
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
    assert_eq!(p["step"], "done");
    assert_eq!(p["hasApiKey"], true, "key presence surfaces, never the key");
    // 0.11: keys persist SEALED in the install-global secrets store, never as
    // plaintext in profile.json (and so survive sign-out / vault switches).
    let raw = std::fs::read_to_string(vault_dir.path().join(".rag-vault/profile.json")).unwrap();
    assert!(!raw.contains("sk-test"), "raw key must not sit in profile.json");
    let sealed =
        std::fs::read_to_string(vault_dir.path().join(".rag-vault/secrets.json")).unwrap();
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

    // --- /api/license disabled mode + /api/register unconfigured ----------------
    let lic: Value = client
        .post(format!("{base}/api/license"))
        .json(&json!({ "op": "check" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(lic["status"], "disabled");
    let reg: Value = client
        .get(format!("{base}/api/register"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reg["configured"], false);

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

    // --- /api/tts without a bundled voice → 501 (Web Speech fallback contract) ---
    let res = client
        .post(format!("{base}/api/tts"))
        .json(&json!({ "text": "hello" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 501);

    // --- /api/open is desktop-gated ----------------------------------------------
    let res = client
        .post(format!("{base}/api/open"))
        .json(&json!({ "nodeId": "recipe.md" }))
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

    // --- /api/usage consent round-trip ---------------------------------------------
    let u: Value = client
        .get(format!("{base}/api/usage"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(u["optOut"], true, "capture is opt-in");
    let u: Value = client
        .post(format!("{base}/api/usage"))
        .json(&json!({ "op": "consent", "optOut": false }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(u["optOut"], false);

    // --- /api/connect status (not connected) ----------------------------------------
    let c: Value = client
        .post(format!("{base}/api/connect"))
        .json(&json!({ "op": "status" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(c["connected"], false);
    assert_eq!(c["pending"], false);

    // --- remove to trash over the wire ------------------------------------------------
    let r = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "remove", "nodeId": "recipe.md" }))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());
    assert!(!vault_dir.path().join("recipe.md").exists());
    assert!(vault_dir.path().join(".rag-vault/trash").exists());
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
        .json(&json!({ "op": "include", "nodeId": "x", "included": true }))
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
        .json(&json!({ "op": "include", "nodeId": "x", "included": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);

    // A same-port loopback Origin passes (the renderer's own requests).
    let res = client
        .post(format!("{base}/api/rag"))
        .header("origin", base.clone())
        .json(&json!({ "op": "source", "available": true }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());

    // With a token configured, header-less callers must present it.
    std::env::set_var("LIGHTHOUSE_API_TOKEN", "sekret");
    let res = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "source", "available": true }))
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
        .json(&json!({ "op": "source", "available": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 403);
    let res = client
        .post(format!("{base}/api/rag"))
        .header("x-lighthouse-token", "sekret")
        .json(&json!({ "op": "source", "available": true }))
        .send()
        .await
        .unwrap();
    assert!(
        res.status().is_success(),
        "the shell's per-launch token authenticates"
    );
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
}
