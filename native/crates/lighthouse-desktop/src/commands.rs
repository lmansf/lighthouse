//! IPC command surface (Phase 4): the same operations the 13 HTTP routes
//! expose, carried over Tauri's invoke/Channel transport instead of a local
//! TCP port. The webview is the only caller and commands run in-process, so
//! the loopback/Origin/token auth layer has no equivalent here — there is no
//! port to defend.

use futures::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use lighthouse_core::contracts::{ChatChunk, ChatTurn};
use lighthouse_core::{license, local_model, profile, settings, sources, tts, usage, vault};

fn string_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn err_string(e: anyhow::Error, fallback: &str) -> String {
    let m = e.to_string();
    if m.is_empty() {
        fallback.to_string()
    } else {
        m
    }
}

/// Decode `%XX` escapes (the JS side sends `encodeURIComponent` values).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub async fn rag_list() -> Value {
    let (sources_list, nodes) = tokio::join!(sources::list_sources(), sources::list_nodes());
    json!({ "sources": sources_list, "nodes": nodes, "desktop": true })
}

#[tauri::command]
pub async fn rag_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
        Some("include") => {
            let (Some(node_id), Some(included)) =
                (body["nodeId"].as_str(), body["included"].as_bool())
            else {
                return Err("nodeId and included required".into());
            };
            sources::set_included(node_id, included).await;
            Ok(json!({ "ok": true }))
        }
        Some("source") => {
            let Some(available) = body["available"].as_bool() else {
                return Err("available required".into());
            };
            sources::set_source_available(available, body["sourceId"].as_str()).await;
            Ok(json!({ "ok": true }))
        }
        Some("search") => {
            let query = body["query"].as_str().unwrap_or("");
            let ids = string_array(&body["includedFileIds"]);
            let retrieved = sources::retrieve(query, &ids, &[], 5).await;
            Ok(json!({ "references": retrieved.references }))
        }
        Some("move") => {
            let Some(from) = body["from"].as_str() else {
                return Err("from required".into());
            };
            sources::move_node(from, body["toParentId"].as_str())
                .await
                .map(|new_id| json!({ "newId": new_id }))
                .map_err(|e| err_string(e, "move failed"))
        }
        Some("addReference") => {
            let Some(path) = body["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                return Err("path required".into());
            };
            sources::add_reference(path)
                .await
                .map(|(id, kind)| json!({ "id": id, "kind": kind }))
                .map_err(|e| err_string(e, "link failed"))
        }
        Some("removeReference") => {
            let Some(ref_id) = body["refId"].as_str() else {
                return Err("refId required".into());
            };
            sources::remove_reference(ref_id)
                .await
                .map(|_| json!({ "ok": true }))
                .map_err(|e| err_string(e, "unlink failed"))
        }
        Some("remove") => {
            let Some(node_id) = body["nodeId"].as_str().filter(|n| !n.trim().is_empty()) else {
                return Err("nodeId required".into());
            };
            sources::remove_from_vault(node_id)
                .await
                .map(|_| json!({ "ok": true }))
                .map_err(|e| err_string(e, "remove failed"))
        }
        _ => Err("unknown op".into()),
    }
}

/// Streamed chat over an IPC channel: one `ChatChunk` per message, the final
/// one carrying references — the NDJSON protocol, minus the wire.
#[tauri::command]
pub async fn chat_ask(
    question: String,
    included_file_ids: Vec<String>,
    history: Vec<Value>,
    attachment_file_ids: Vec<String>,
    on_chunk: Channel<ChatChunk>,
) -> Result<(), String> {
    let history: Vec<ChatTurn> = {
        let turns: Vec<ChatTurn> = history
            .iter()
            .filter_map(|t| {
                let role = t["role"].as_str()?;
                let content = t["content"].as_str()?;
                (role == "user" || role == "assistant").then(|| ChatTurn {
                    role: role.to_string(),
                    content: content.to_string(),
                })
            })
            .collect();
        let skip = turns.len().saturating_sub(8);
        turns.into_iter().skip(skip).collect()
    };
    let last_user_turn = history.iter().rev().find(|t| t.role == "user");
    let retrieval_query = match last_user_turn {
        Some(t) => format!("{}\n{}", t.content, question),
        None => question.clone(),
    };
    let retrieved = sources::retrieve(
        &retrieval_query,
        &included_file_ids,
        &attachment_file_ids,
        5,
    )
    .await;
    let cfg = profile::model_config();
    let contexts: Vec<lighthouse_core::llm::Ctx> = retrieved
        .contexts
        .iter()
        .map(|c| lighthouse_core::llm::Ctx {
            name: c.name.clone(),
            text: c.text.clone(),
            score: c.score,
        })
        .collect();

    let mut stream = lighthouse_core::llm::stream_answer(question, contexts, cfg, history);
    while let Some(delta) = stream.next().await {
        let _ = on_chunk.send(ChatChunk {
            delta,
            references: None,
            done: false,
        });
    }
    let _ = on_chunk.send(ChatChunk {
        delta: String::new(),
        references: Some(retrieved.references),
        done: true,
    });
    Ok(())
}

#[tauri::command]
pub fn tts_available() -> bool {
    tts::is_local_tts_available()
}

/// WAV bytes as a raw IPC response (no JSON array encoding).
#[tauri::command]
pub async fn tts_synthesize(text: String) -> Result<tauri::ipc::Response, String> {
    let text: String = text.trim().chars().take(8000).collect();
    if text.is_empty() {
        return Err("text required".into());
    }
    if !tts::is_local_tts_available() {
        return Err("local TTS unavailable".into());
    }
    match tts::synthesize(&text).await {
        Ok(wav) => Ok(tauri::ipc::Response::new(wav)),
        Err(_) => Err("synthesis failed".into()),
    }
}

fn emit_model_selected(sel: Option<profile::ModelSelectionResult>) {
    let Some(sel) = sel else { return };
    if (!sel.initial && !sel.changed) || sel.provider.is_empty() || sel.model.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        license::record_event(
            "model_selected",
            json!({
                "provider": sel.provider,
                "model": sel.model,
                "initial": sel.initial,
                "previous_provider": sel.previous_provider,
                "previous_model": sel.previous_model,
            }),
        )
        .await;
    });
}

#[tauri::command]
pub fn profile_get() -> Value {
    serde_json::to_value(profile::get_state()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn profile_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
        Some("signIn") => {
            profile::sign_in(body["email"].as_str().unwrap_or(""));
        }
        Some("register") => {
            profile::register(
                body["name"].as_str().unwrap_or(""),
                body["email"].as_str().unwrap_or(""),
            );
        }
        Some("finishRegistration") => emit_model_selected(profile::finish_registration()),
        Some("selectModel") => emit_model_selected(Some(profile::select_model(
            body["providerId"].as_str().unwrap_or(""),
            body["modelId"].as_str().unwrap_or(""),
            body["apiKey"].as_str().unwrap_or(""),
        ))),
        Some("completeOnboarding") => profile::complete_onboarding(),
        Some("signOut") => profile::sign_out(),
        _ => return Err("unknown op".into()),
    }
    Ok(serde_json::to_value(profile::get_state()).unwrap_or_else(|_| json!({})))
}

#[tauri::command]
pub async fn license_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
        Some("config") => Ok(json!({ "paidEnabled": license::paid_enabled() })),
        Some("check") => Ok(serde_json::to_value(license::check_license().await)
            .unwrap_or_else(|_| json!({ "status": "none" }))),
        Some("start") => match license::start_trial(None).await {
            Ok(_) => Ok(json!({ "ok": true })),
            Err(e) => Ok(json!({
                "ok": false, "reason": "rejected",
                "detail": err_string(e, "start failed"),
            })),
        },
        Some("activate") => {
            let result = license::activate_license(body["licenseKey"].as_str().unwrap_or("")).await;
            let ok = result.status == "valid" || result.status == "grace";
            let mut payload = serde_json::to_value(&result).unwrap_or_else(|_| json!({}));
            payload["ok"] = json!(ok);
            Ok(payload)
        }
        Some("feedback") => {
            let f = &body["feedback"];
            if !f.is_object() {
                return Err("feedback required".into());
            }
            let input = license::FeedbackInput {
                first_name: f["firstName"].as_str().unwrap_or("").trim().to_string(),
                last_name: f["lastName"].as_str().unwrap_or("").trim().to_string(),
                ease_of_use: f["easeOfUse"].as_f64().unwrap_or(0.0),
                overall_value: f["overallValue"].as_f64().unwrap_or(0.0),
                liked: f["liked"].as_str().unwrap_or("").trim().to_string(),
                change_or_add: f["changeOrAdd"].as_str().unwrap_or("").trim().to_string(),
                notify_when_available: f["notifyWhenAvailable"].as_bool().unwrap_or(false),
            };
            Ok(json!({ "ok": license::submit_feedback(&input).await }))
        }
        Some("notify") => {
            let email = body["email"].as_str().unwrap_or("");
            if email.trim().is_empty() {
                return Err("email required".into());
            }
            Ok(json!({ "ok": license::submit_notify(email).await }))
        }
        Some("bug") => {
            let where_ = body["bug"]["where"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            let what = body["bug"]["what"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            if where_.is_empty() && what.is_empty() {
                return Err("empty report".into());
            }
            Ok(json!({ "ok": license::submit_bug(&where_, &what).await }))
        }
        Some("ping") => {
            license::ping_launch().await;
            Ok(json!({ "ok": true }))
        }
        Some("checkout") => {
            Ok(json!({ "url": license::checkout_url(body["email"].as_str()).await }))
        }
        _ => Err("unknown op".into()),
    }
}

#[tauri::command]
pub async fn usage_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
        Some("consent") => {
            let opt_out = body["optOut"].as_bool().unwrap_or(false);
            usage::set_usage_opt_out(opt_out);
            Ok(json!({ "ok": true, "optOut": opt_out }))
        }
        Some("events") => {
            usage::append_usage_events(&body["events"].as_array().cloned().unwrap_or_default());
            Ok(json!({ "ok": true }))
        }
        Some("publish") => {
            license::publish_usage_events().await;
            Ok(json!({ "ok": true }))
        }
        _ => Err("unknown op".into()),
    }
}

#[tauri::command]
pub fn usage_get() -> Value {
    json!({ "optOut": usage::is_usage_opted_out() })
}

#[tauri::command]
pub fn event_record(name: String, props: Value) {
    if name.trim().is_empty() {
        return;
    }
    let props = if props.is_object() { props } else { json!({}) };
    tauri::async_runtime::spawn(async move { license::record_event(&name, props).await });
}

#[tauri::command]
pub async fn connect_op(body: Value) -> Result<Value, String> {
    let status_payload = || {
        let s = sources::microsoft::load_state();
        json!({
            "connected": sources::microsoft::is_connected(),
            "account": s.account,
            "available": s.available.unwrap_or(true),
            "nodeCount": s.nodes.map(|n| n.len()).unwrap_or(0),
            "pending": s.pending.is_some(),
        })
    };
    match body["op"].as_str() {
        Some("status") => Ok(status_payload()),
        Some("start") => sources::microsoft::start_device_code()
            .await
            .and_then(|f| Ok(serde_json::to_value(f)?))
            .map_err(|e| err_string(e, "connection error")),
        Some("poll") => {
            let result = sources::microsoft::poll_device_code()
                .await
                .map_err(|e| e.to_string())?;
            if result.status == "connected" {
                let _ = sources::sharepoint::refresh_listing().await;
            }
            let mut payload = serde_json::to_value(&result).map_err(|e| e.to_string())?;
            if let (Some(obj), Some(status)) =
                (payload.as_object_mut(), status_payload().as_object())
            {
                for (k, v) in status {
                    obj.insert(k.clone(), v.clone());
                }
            }
            Ok(payload)
        }
        Some("refresh") => {
            if !sources::microsoft::is_connected() {
                return Err("not connected".into());
            }
            let node_count = sources::sharepoint::refresh_listing()
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "nodeCount": node_count }))
        }
        Some("disconnect") => {
            sources::sharepoint::disconnect();
            Ok(json!({ "ok": true }))
        }
        _ => Err("unknown op".into()),
    }
}

#[tauri::command]
pub fn model_status() -> Value {
    serde_json::to_value(local_model::model_status()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn model_download() -> Value {
    serde_json::to_value(local_model::start_download()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn model_uninstall() -> Value {
    serde_json::to_value(local_model::request_uninstall()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn open_node(node_id: String) -> Result<Value, String> {
    let abs =
        vault::resolve_node_path(&node_id).map_err(|e| err_string(e, "could not open file"))?;
    match std::fs::metadata(&abs) {
        Err(_) => Err("file no longer exists".into()),
        Ok(meta) if !meta.is_file() => Err("not a file".into()),
        Ok(_) => {
            crate::open_with_os(&abs);
            Ok(json!({ "ok": true }))
        }
    }
}

#[tauri::command]
pub fn settings_get() -> Value {
    let s = settings::read_desktop_settings();
    json!({
        "desktop": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
    })
}

#[tauri::command]
pub fn settings_set(
    app: AppHandle,
    run_on_startup: Option<bool>,
    startup_asked: Option<bool>,
) -> Value {
    let s = settings::write_desktop_settings(run_on_startup, startup_asked);
    crate::apply_autostart(&app, s.run_on_startup != Some(false));
    json!({
        "ok": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
    })
}

/// Add real filesystem paths to the vault: linked in place (desktop default)
/// or copied in. This replaces the HTTP multipart upload for OS drops — the
/// webview's drag-drop event already carries real paths.
#[tauri::command]
pub async fn add_paths(paths: Vec<String>, link: bool) -> Value {
    let mut added: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for p in paths {
        if link {
            match sources::add_reference(&p).await {
                Ok((id, kind)) => added.push(json!({ "newId": id, "kind": kind })),
                Err(e) => {
                    skipped.push(json!({ "name": p, "reason": err_string(e, "link failed") }))
                }
            }
        } else {
            let name = std::path::Path::new(&p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            match std::fs::read(&p) {
                Ok(bytes) => match vault::add_file(&name, &bytes, None) {
                    Ok(new_id) => added.push(json!({ "newId": new_id })),
                    Err(e) => skipped
                        .push(json!({ "name": name, "reason": err_string(e, "copy failed") })),
                },
                Err(e) => skipped.push(json!({ "name": name, "reason": e.to_string() })),
            }
        }
    }
    json!({ "added": added, "skipped": skipped })
}

/// Native link-file picker (replaces the Electron preload's `linkDialog`).
#[tauri::command]
pub async fn pick_link_paths(app: AppHandle, directory: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
    let title = if directory {
        "Link a folder in place (not copied)"
    } else {
        "Link files in place (not copied)"
    };
    let dialog = app.dialog().file().set_title(title);
    if directory {
        dialog.pick_folder(move |p| {
            let out = p
                .and_then(|f| f.into_path().ok())
                .map(|p| vec![p.to_string_lossy().to_string()])
                .unwrap_or_default();
            let _ = tx.send(out);
        });
    } else {
        dialog.pick_files(move |ps| {
            let out = ps
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = tx.send(out);
        });
    }
    rx.await.unwrap_or_default()
}

#[tauri::command]
pub fn register_config() -> Value {
    json!({ "configured": license::is_supabase_configured() })
}

/// Welcome-registration: mint a trial with the contact info, then apply the
/// explicit usage-consent choice even when the mint fails (offline) — the
/// same `finally` semantics as the HTTP route.
#[tauri::command]
pub async fn register_start(body: Value) -> Result<Value, String> {
    let email = body["email"].as_str().unwrap_or("").trim().to_string();
    if email.is_empty() {
        return Err("email required".into());
    }
    let contact = license::Registration {
        first_name: body["firstName"].as_str().unwrap_or("").trim().to_string(),
        last_name: body["lastName"].as_str().unwrap_or("").trim().to_string(),
        email,
        do_not_contact: body["doNotContact"].as_bool().unwrap_or(false),
        city: body["city"].as_str().unwrap_or("").trim().to_string(),
        state: body["state"].as_str().unwrap_or("").trim().to_string(),
    };
    let result = license::start_trial(Some(contact)).await;
    if let Some(opt_out) = body["usageLoggingOptOut"].as_bool() {
        usage::set_usage_opt_out(opt_out);
    }
    Ok(match result {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({
            "ok": false, "reason": "rejected",
            "detail": err_string(e, "registration failed"),
        }),
    })
}

/// One uploaded file as a raw-bytes IPC request (filename/dir in headers) —
/// replaces the HTTP multipart route with the same caps and semantics.
#[tauri::command]
pub fn upload_file(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file bytes".into());
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "exceeds {}MB limit",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    // Header values arrive percent-encoded (filenames are arbitrary UTF-8;
    // HTTP header values are not).
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| percent_decode(s))
            .filter(|s| !s.is_empty())
    };
    let name = header("x-file-name").ok_or("x-file-name header required")?;
    let dir = header("x-dest-dir");
    vault::add_file(&name, bytes, dir.as_deref())
        .map(|new_id| json!({ "newId": new_id }))
        .map_err(|e| err_string(e, "upload failed"))
}

/// Current update-notification state (splash/tray parity with the Electron
/// preload's read-only update bridge).
#[tauri::command]
pub fn update_state(app: AppHandle) -> Value {
    let newer = app
        .try_state::<crate::supervise::UpdateState>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
    match newer {
        Some(v) => {
            json!({ "phase": "available", "version": v, "url": crate::supervise::RELEASE_PAGE_URL })
        }
        None => json!({ "phase": "none" }),
    }
}

/// Monotonic vault-change counter (the watcher's generation) so the UI can
/// refresh on push instead of polling the tree.
#[tauri::command]
pub fn watch_generation() -> u64 {
    lighthouse_core::watch::generation()
}

/// Webview-side diagnostics land in the shell log (headless smoke tests read
/// them; harmless in production).
#[tauri::command]
pub fn diag_report(payload: String) {
    eprintln!("[diag] {payload}");
}
