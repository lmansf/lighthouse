//! Managed-policy end-to-end (openspec: add-managed-policy, task 4.3): the
//! spec's load-bearing scenario is a profile stored BEFORE the policy landed
//! — provider `openai`, key sealed — that must still be blocked at the
//! engine when `forceLocalOnly` arrives, with the ask answered by the
//! extractive path instead of dying. Plus: selectModel op rejection, the
//! `vaultRoots` attach refusal, and the `{op:"policy"}` snapshot shape
//! (including the telemetry lock it reports).
//!
//! `vaultRoots` re-pointed in 0.15.0 (openspec: refocus-chat-attachments):
//! it used to say where the vault FOLDER could live, and now says which of the
//! user's files may be ATTACHED — the same question, asked at the one door
//! files still come in through.
//!
//! One combined test: the policy file path + the state env are process-global
//! (same reasoning as the secrets suite).

use serde_json::{json, Value};

async fn spawn(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn managed_policy_is_enforced_at_the_engine() {
    // --- World: an ALLOWED root holding the doc the ask answers from, and a
    // separate area outside every allowed root.
    let state = tempfile::tempdir().unwrap();
    let allowed_root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        allowed_root.path().join("budget.md"),
        "# Budget\n\nThe revenue targets are 42 million dollars for Q3.\n",
    )
    .unwrap();
    std::fs::write(
        outside.path().join("forbidden.md"),
        "a document outside every allowed root\n",
    )
    .unwrap();

    // Since the 0.15.0 re-root, engine state follows LIGHTHOUSE_APP_STATE_DIR
    // alone — keep it inside this test's own temp dir.
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", state.path().join(".rag-vault"));
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");

    // --- A PRE-POLICY profile: openai selected, key sealed. Written before
    // the policy file exists (select_model would refuse afterwards).
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    lighthouse_core::policy::reset_for_tests();
    lighthouse_core::profile::select_model("openai", "gpt-5-mini", "sk-managed-test");
    assert_eq!(
        lighthouse_core::profile::model_config().provider_id.as_deref(),
        Some("openai"),
        "pre-policy selection persists"
    );

    // --- The policy lands.
    let policy_dir = tempfile::tempdir().unwrap();
    let policy_file = policy_dir.path().join("policy.json");
    std::fs::write(
        &policy_file,
        json!({
            "v": 1,
            "forceLocalOnly": true,
            "telemetry": "off",
            "vaultRoots": [allowed_root.path().to_string_lossy()],
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var("LIGHTHOUSE_POLICY_FILE", &policy_file);
    lighthouse_core::policy::reset_for_tests();

    // The stale profile still names openai with a resolvable key — exactly
    // the state llm.rs must refuse to act on.
    let cfg = lighthouse_core::profile::model_config();
    assert_eq!(cfg.provider_id.as_deref(), Some("openai"));
    assert!(cfg.api_key.as_deref().is_some_and(|k| !k.is_empty()));

    let base = spawn(lighthouse_server::app()).await;
    let client = reqwest::Client::new();

    // Attach the doc so the ask has grounded context. It sits INSIDE an
    // allowed root, so the vaultRoots gate lets it through (§3 below proves
    // the same door refuses a file outside every root).
    const CONV: &str = "conv-policy";
    let attached = lighthouse_shell::commands::attach_paths(
        CONV,
        vec![allowed_root.path().join("budget.md").to_string_lossy().to_string()],
    )
    .await;
    let budget_id = attached["added"][0]["newId"].as_str().unwrap().to_string();
    assert!(
        attached["skipped"].as_array().unwrap().is_empty(),
        "a file inside an allowed root attaches: {attached}"
    );

    // --- 1. The ask: no cloud call, extractive answer WITH references.
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
    let body = res.text().await.unwrap();
    let lines: Vec<Value> = body
        .lines()
        .map(|l| serde_json::from_str(l).expect("chat chunk"))
        .collect();
    let last = lines.last().unwrap();
    assert_eq!(last["done"], true);
    assert_eq!(
        last["references"][0]["fileId"], budget_id.as_str(),
        "the refused-cloud ask still answers grounded"
    );
    let answer: String = lines[..lines.len() - 1]
        .iter()
        .map(|l| l["delta"].as_str().unwrap_or(""))
        .collect();
    assert!(
        answer.contains("most relevant passages"),
        "the extractive path answered (no cloud provider was used): {answer}"
    );

    // --- 2. Selecting a disallowed provider is rejected at the op layer.
    let res = client
        .post(format!("{base}/api/profile"))
        .json(&json!({ "op": "selectModel", "providerId": "deepseek", "modelId": "deepseek-chat", "apiKey": "sk-x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let err = res.text().await.unwrap();
    assert!(err.contains("managed"), "error names the managed restriction: {err}");
    // Belt-and-braces: the engine-side guard also refused persistence.
    assert_eq!(
        lighthouse_core::profile::model_config().provider_id.as_deref(),
        Some("openai"),
        "profile unchanged after the rejected select"
    );

    // --- 3. vaultRoots: ATTACHING a file outside every allowed root is
    // refused, with a reason the user can act on — and the file never reaches
    // the workspace. The in-root half was proved by the attach above.
    let refused = lighthouse_shell::commands::attach_paths(
        CONV,
        vec![outside.path().join("forbidden.md").to_string_lossy().to_string()],
    )
    .await;
    assert!(
        refused["added"].as_array().unwrap().is_empty(),
        "out-of-root attach must be refused: {refused}"
    );
    assert!(
        refused["skipped"][0]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("organization"),
        "the refusal names the managed restriction: {refused}"
    );
    assert_eq!(
        lighthouse_core::workspace::list(CONV).len(),
        1,
        "the refused file never joined the conversation"
    );

    // --- 4. The policy op reports the locks the UI renders.
    let snap: Value = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "policy" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(snap["present"], true);
    assert_eq!(snap["error"], false);
    assert_eq!(snap["locks"]["allowedProviders"][0], "local");
    assert_eq!(snap["locks"]["telemetryOff"], true);
    assert_eq!(snap["locks"]["chatHistoryOff"], false);

    // Cleanup: leave no policy behind for other test binaries' processes.
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    lighthouse_core::policy::reset_for_tests();
}
