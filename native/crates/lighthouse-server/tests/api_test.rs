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
    std::env::remove_var("LIGHTHOUSE_API_TOKEN");
    std::env::remove_var("LIGHTHOUSE_DESKTOP");
    std::env::remove_var("ANTHROPIC_API_KEY");
    // Default inclusion is the fixed exclude default (experiments removed), so
    // uploaded files start excluded — deterministic without any pin.
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
    assert_eq!(p["step"], "vault");
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
    // selectModel now advances to the final default-inclusion step (the client
    // then persists the choice and calls completeOnboarding → "done").
    assert_eq!(p["step"], "inclusion");
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

/// Investigations §2 over the real wire (openspec: add-investigations): an
/// ask carrying an `investigationId` resolves the investigation's scope
/// through the attachment machinery (citations come only from scope), and a
/// `local-only` investigation swaps the resolved model config to the private
/// path at the model_config() chokepoint — under a cloud-configured profile
/// with a (fake-keyed, never-dialed) provider, the final chunk's meta.origin
/// says "device". Zero network: if the swap ever regressed, origin would
/// stamp "anthropic" and this test fails before any citation check.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn investigation_scope_and_local_only_over_the_wire() {
    let _env = lock_env();
    let (base, _vault_dir) = spawn_server().await;
    let client = reqwest::Client::new();

    // Three fixture files; the decoy matches the probe query best and sits
    // OUTSIDE the investigation's scope.
    let form = reqwest::multipart::Form::new()
        .part(
            "files",
            reqwest::multipart::Part::bytes(
                b"the harbor ledger shows the missing shipment entries".to_vec(),
            )
            .file_name("alpha.md"),
        )
        .text("paths", "cases/alpha.md")
        .part(
            "files",
            reqwest::multipart::Part::bytes(
                b"harbor ledger notes about the missing shipment manifest".to_vec(),
            )
            .file_name("beta.md"),
        )
        .text("paths", "cases/beta.md")
        .part(
            "files",
            reqwest::multipart::Part::bytes(
                b"missing shipment missing shipment harbor ledger decoy dossier".to_vec(),
            )
            .file_name("decoy.md"),
        )
        .text("paths", "cases/decoy.md");
    let up: Value = client
        .post(format!("{base}/api/upload"))
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(up["skipped"].as_array().unwrap().is_empty());
    let r = client
        .post(format!("{base}/api/rag"))
        .json(&json!({ "op": "include", "nodeId": "cases", "included": true }))
        .send()
        .await
        .unwrap();
    assert!(r.status().is_success());
    let all = json!(["cases/alpha.md", "cases/beta.md", "cases/decoy.md"]);

    // Create the investigations over the wire (§1's op): one scoped to 2 of
    // the 3 files, one local-only over the whole vault.
    let created: Value = client
        .post(format!("{base}/api/rag"))
        .json(&json!({
            "op": "investigations",
            "action": "create",
            "name": "Harbor case",
            "scopeFileIds": ["cases/alpha.md", "cases/beta.md"],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scoped_id = created["investigation"]["id"].as_str().unwrap().to_string();
    let created: Value = client
        .post(format!("{base}/api/rag"))
        .json(&json!({
            "op": "investigations",
            "action": "create",
            "name": "Sealed",
            "providerPolicy": "local-only",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sealed_id = created["investigation"]["id"].as_str().unwrap().to_string();

    // NDJSON /api/chat helper: (final chunk, concatenated deltas).
    let chat = |body: Value| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let res = client
                .post(format!("{base}/api/chat"))
                .json(&body)
                .send()
                .await
                .unwrap();
            assert!(res.status().is_success());
            let text = res.text().await.unwrap();
            let lines: Vec<Value> = text
                .lines()
                .map(|l| serde_json::from_str(l).expect("every line is a ChatChunk"))
                .collect();
            let last = lines.last().unwrap().clone();
            assert_eq!(last["done"], true);
            let full: String = lines
                .iter()
                .filter_map(|l| l["delta"].as_str().map(String::from))
                .collect();
            (last, full)
        }
    };
    let ref_ids = |last: &Value| -> Vec<String> {
        last["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["fileId"].as_str().unwrap().to_string())
            .collect()
    };

    // Control (no investigationId): the out-of-scope decoy is a candidate.
    let (last, _) = chat(json!({
        "question": "where did the missing shipment go?",
        "includedFileIds": all,
    }))
    .await;
    assert!(
        ref_ids(&last).contains(&"cases/decoy.md".to_string()),
        "unscoped ask sees the decoy: {last}"
    );

    // Scoped ask: citations come ONLY from the investigation's scope — the
    // scope rode the existing attachment machinery, so every downstream
    // choke point (retrieval, honesty footers) applied verbatim.
    let (last, _) = chat(json!({
        "question": "what do the case notes say about the missing shipment?",
        "includedFileIds": all,
        "investigationId": scoped_id,
    }))
    .await;
    let cited = ref_ids(&last);
    assert!(!cited.is_empty(), "scoped ask still grounds: {last}");
    for id in &cited {
        assert!(
            id == "cases/alpha.md" || id == "cases/beta.md",
            "citation escaped the scope: {cited:?}"
        );
    }

    // Cloud-configure the profile with a FAKE key (spawn_server cleared the
    // env one). From here every ask would resolve a keyed anthropic config —
    // stamping origin "anthropic" — unless the investigation swaps it.
    let p: Value = client
        .post(format!("{base}/api/profile"))
        .json(&json!({ "op": "selectModel", "providerId": "anthropic", "modelId": "claude-haiku-4-5", "apiKey": "sk-test-fake" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p["hasApiKey"], true, "profile really is cloud-keyed now");

    // Local-only investigation, cloud profile: the cfg swap at the
    // model_config() chokepoint means no cloud transport is ever built — the
    // private path answers (local model absent here, so its extractive
    // fallback), grounded, and the provenance stamp is truthfully on-device.
    let (last, full) = chat(json!({
        "question": "what does the harbor ledger show?",
        "includedFileIds": all,
        "investigationId": sealed_id,
    }))
    .await;
    assert_eq!(
        last["meta"]["origin"], "device",
        "local-only must stamp on-device under a cloud profile: {last}"
    );
    assert!(!ref_ids(&last).is_empty(), "private path still grounds: {last}");
    assert!(!full.is_empty(), "private path still answers");
}

/// Beam §2 (evidence packs): the exportChat op's optional subdir/ext routing.
/// The default wire shape stays byte-compatible (markdown note into
/// Lighthouse Notes/); the html/Lighthouse Results pair rides the SAME
/// sanitized write_artifact path (hostile hints repaired, never a vault
/// escape); anything off the strict allowlist is a 400 that writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_chat_routes_artifacts_through_the_allowlist() {
    let _env = lock_env();
    let (base, vault_dir) = spawn_server().await;
    let client = reqwest::Client::new();
    let post = |body: Value| client.post(format!("{base}/api/rag")).json(&body).send();

    // --- Default (no subdir/ext): the original markdown-note behavior. -----
    let res: Value = post(json!({
        "op": "exportChat", "title": "Team sync", "markdown": "# hi"
    }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(res["savedId"], "Lighthouse Notes/Team sync.md");
    assert_eq!(res["savedName"], "Team sync.md");
    assert!(vault_dir
        .path()
        .join("Lighthouse Notes/Team sync.md")
        .exists());

    // --- Evidence pack: html into Lighthouse Results/, hostile hint repaired
    //     by write_artifact (reuse pinned: the file lands INSIDE the vault). --
    let res: Value = post(json!({
        "op": "exportChat",
        "title": "../revenue by region",
        "markdown": "<!doctype html>\n<html lang=\"en\"></html>",
        "subdir": "Lighthouse Results",
        "ext": "html",
    }))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let id = res["savedId"].as_str().unwrap();
    let name = res["savedName"].as_str().unwrap();
    assert!(id.starts_with("Lighthouse Results/"), "{id}");
    assert!(name.ends_with(".html"), "{name}");
    assert_eq!(id, &format!("Lighthouse Results/{name}"));
    let abs = vault_dir.path().join(id);
    assert!(abs.exists(), "written inside the vault: {abs:?}");
    assert!(
        !vault_dir
            .path()
            .parent()
            .unwrap()
            .join("revenue by region.html")
            .exists(),
        "the traversal hint must never escape the vault"
    );

    // --- Off-allowlist values reject with 400 and write nothing. -----------
    for bad in [
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "subdir": "Lighthouse Secrets" }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "subdir": ".." }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "ext": "exe" }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "ext": 5 }),
        json!({ "op": "exportChat", "title": "x", "markdown": "x", "subdir": null }),
    ] {
        let res = post(bad.clone()).await.unwrap();
        assert_eq!(res.status().as_u16(), 400, "must reject: {bad}");
    }
    assert!(
        !vault_dir.path().join("Lighthouse Notes/x.md").exists()
            && !vault_dir.path().join("Lighthouse Results/x.md").exists(),
        "a rejected export writes nothing"
    );
}

/// Bulk curation rules over the wire (openspec: add-curation-rules): create a
/// rule via the op, land a NEW matching file (a real upload — the same path an
/// arriving file takes), and assert it resolves with the rule's flags on the
/// next listing with NO per-node write in state.json, while the inspect op
/// attributes the rule by name. Also pins add-time validation → 400 and that
/// removal reverts the rule's layer only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn curation_rules_over_the_wire() {
    let _env = lock_env();
    let (base, vault_dir) = spawn_server().await;
    let client = reqwest::Client::new();
    let post = |body: Value| client.post(format!("{base}/api/rag")).json(&body).send();

    // --- Create the spec's rule FIRST: spreadsheets in /reports → include. --
    let res = post(json!({
        "op": "rules", "action": "add",
        "rule": { "scope": "reports", "kind": "tabular", "action": "include" },
    }))
    .await
    .unwrap();
    assert!(res.status().is_success());
    let added: Value = res.json().await.unwrap();
    let rule_id = added["rule"]["id"].as_str().unwrap().to_string();
    assert_eq!(added["rule"]["name"], "spreadsheets in /reports");

    // --- A NEW matching file arrives AFTER the rule (real upload). ----------
    let form = reqwest::multipart::Form::new()
        .part(
            "files",
            reqwest::multipart::Part::bytes(b"region,amount\nNE,1\n".to_vec())
                .file_name("late.xlsx"),
        )
        .text("paths", "reports/late.xlsx");
    let up = client
        .post(format!("{base}/api/upload"))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert!(up.status().is_success());

    // --- The next listing resolves it included, with no user action. --------
    let rag: Value = client
        .get(format!("{base}/api/rag"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let late = rag["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == "reports/late.xlsx")
        .expect("uploaded file walked");
    assert_eq!(late["ragIncluded"], true, "the rule includes the future arrival");

    // --- NO per-node write: state.json's flag maps stay empty. --------------
    let raw = std::fs::read_to_string(vault_dir.path().join(".rag-vault/state.json")).unwrap();
    let state: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(state["included"].as_object().map(|m| m.len()), Some(0), "{raw}");
    assert_eq!(state["localOnly"].as_object().map(|m| m.len()), Some(0), "{raw}");

    // --- The inspector attributes the rule by name. --------------------------
    let inspection: Value = post(json!({ "op": "inspect", "fileId": "reports/late.xlsx" }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inspection["included"], true);
    assert_eq!(inspection["includedBy"]["source"], "rule");
    assert_eq!(inspection["includedBy"]["ruleId"], rule_id.as_str());
    assert_eq!(inspection["includedBy"]["ruleName"], "spreadsheets in /reports");

    // --- The list op enriches: name + scope label + orphaned=false. ----------
    let listing: Value = post(json!({ "op": "rules", "action": "list" }))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rules = listing["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0]["scopeLabel"], "reports");
    assert_eq!(rules[0]["orphaned"], false);

    // --- Add-time validation rejects with 400 (bad glob / bad action). -------
    for bad in [
        json!({ "op": "rules", "action": "add", "rule": { "scope": "", "glob": "a**b", "action": "include" } }),
        json!({ "op": "rules", "action": "add", "rule": { "scope": "", "kind": "tabular", "action": "banish" } }),
        json!({ "op": "rules", "action": "add", "rule": { "scope": "", "action": "include" } }),
    ] {
        let res = post(bad.clone()).await.unwrap();
        assert_eq!(res.status().as_u16(), 400, "must reject: {bad}");
    }

    // --- Removing the rule reverts exactly its layer (back to the default). --
    let removed = post(json!({ "op": "rules", "action": "remove", "id": rule_id }))
        .await
        .unwrap();
    assert!(removed.status().is_success());
    let rag: Value = client
        .get(format!("{base}/api/rag"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let late = rag["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == "reports/late.xlsx")
        .unwrap();
    assert_eq!(late["ragIncluded"], false, "reverts to the exclude default");
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
