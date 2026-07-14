//! Managed-policy end-to-end (openspec: add-managed-policy, task 4.3): the
//! spec's load-bearing scenario is a profile stored BEFORE the policy landed
//! — provider `openai`, key sealed — that must still be blocked at the
//! engine when `forceLocalOnly` arrives, with the ask answered by the
//! extractive path instead of dying. Plus: selectModel op rejection,
//! vaultRoots link rejection at the route, telemetry reading locked-off,
//! and the `{op:"policy"}` snapshot shape.
//!
//! One combined test: the policy file path + vault env are process-global
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
    // --- World: a vault with one included doc, and a SEPARATE allowed-roots
    // area so the vault itself doesn't satisfy vaultRoots by accident.
    let vault = tempfile::tempdir().unwrap();
    let allowed_root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        vault.path().join("budget.md"),
        "# Budget\n\nThe revenue targets are 42 million dollars for Q3.\n",
    )
    .unwrap();
    std::fs::write(
        allowed_root.path().join("linkme.md"),
        "a linkable document inside the allowed root\n",
    )
    .unwrap();
    std::fs::write(
        outside.path().join("forbidden.md"),
        "a document outside every allowed root\n",
    )
    .unwrap();

    std::env::set_var("VAULT_DIR", vault.path());
    std::env::remove_var("LICENSE_API_URL");
    std::env::remove_var("LICENSE_ENFORCE");
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");
    let state_dir = vault.path().join(".rag-vault");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("experiments.json"),
        r#"{ "onboarding": "key_first", "default_inclusion": "opt_in", "source": "override" }"#,
    )
    .unwrap();
    lighthouse_core::vault::invalidate_walk_cache();

    // --- A PRE-POLICY profile: openai selected, key sealed. Written before
    // the policy file exists (select_model would refuse afterwards).
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    lighthouse_core::policy::reset_for_tests();
    let sel = lighthouse_core::profile::select_model("openai", "gpt-5-mini", "sk-managed-test");
    assert_eq!(sel.provider, "openai", "pre-policy selection persists");

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

    // Include the doc so the ask has grounded context.
    let r = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "include", "nodeId": "budget.md", "included": true }))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());

    // --- 1. The ask: no cloud call, extractive answer WITH references.
    let res = client
        .post(format!("{base}/api/chat"))
        .json(&json!({
            "question": "what are the revenue targets?",
            "includedFileIds": ["budget.md"],
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
        last["references"][0]["fileId"], "budget.md",
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

    // --- 3. vaultRoots: linking outside every allowed root is refused
    // server-side; inside an allowed root works. Linking is desktop-gated
    // (403 otherwise), so flip the desktop marker for this section only —
    // AFTER the ask above, which must run non-desktop to keep semantic
    // retrieval (and its embed-server dial) out of the test.
    std::env::set_var("LIGHTHOUSE_DESKTOP", "1");
    let res = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "addReference", "path": outside.path().join("forbidden.md").to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400, "out-of-root link must be rejected");
    let err = res.text().await.unwrap();
    assert!(err.contains("organization"), "error names the managed restriction: {err}");
    let res = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "addReference", "path": allowed_root.path().join("linkme.md").to_string_lossy() }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "in-root link is allowed");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");

    // --- 4. Telemetry reads locked-off even after an explicit opt-in write.
    lighthouse_core::usage::set_usage_opt_out(false);
    assert!(
        lighthouse_core::usage::is_usage_opted_out(),
        "telemetry: \"off\" pins the opt-out regardless of the user flag"
    );

    // --- 5. The policy op reports the locks the UI renders.
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
