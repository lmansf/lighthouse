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
pub async fn rag_op(app: AppHandle, body: Value) -> Result<Value, String> {
    use tauri::Emitter;
    match body["op"].as_str() {
        Some("include") => {
            let (Some(node_id), Some(included)) =
                (body["nodeId"].as_str(), body["included"].as_bool())
            else {
                return Err("nodeId and included required".into());
            };
            sources::set_included(node_id, included).await;
            // Visibility flips don't touch vault files, so the FS watcher
            // never pushes them — broadcast explicitly so OTHER windows (the
            // widget, the future explorer window) refresh instantly instead
            // of waiting out their poll.
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "ok": true }))
        }
        Some("source") => {
            let Some(available) = body["available"].as_bool() else {
                return Err("available required".into());
            };
            sources::set_source_available(available, body["sourceId"].as_str()).await;
            let _ = app.emit("vault-changed", ());
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
            let new_id = sources::move_node(from, body["toParentId"].as_str())
                .await
                .map_err(|e| err_string(e, "move failed"))?;
            // Structural edits: broadcast so every window re-reads the tree at
            // once (the FS watcher is best-effort and per-window polls lag).
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "newId": new_id }))
        }
        Some("rename") => {
            let Some(id) = body["id"].as_str() else {
                return Err("id required".into());
            };
            let Some(name) = body["name"].as_str() else {
                return Err("name required".into());
            };
            let new_id = sources::rename_node(id, name)
                .await
                .map_err(|e| err_string(e, "rename failed"))?;
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "newId": new_id }))
        }
        Some("newFolder") => {
            let Some(name) = body["name"].as_str() else {
                return Err("name required".into());
            };
            let new_id = sources::create_folder(body["parentId"].as_str(), name)
                .await
                .map_err(|e| err_string(e, "could not create folder"))?;
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "newId": new_id }))
        }
        Some("addReference") => {
            let Some(path) = body["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                return Err("path required".into());
            };
            let (id, kind) = sources::add_reference(path)
                .await
                .map_err(|e| err_string(e, "link failed"))?;
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "id": id, "kind": kind }))
        }
        Some("removeReference") => {
            let Some(ref_id) = body["refId"].as_str() else {
                return Err("refId required".into());
            };
            sources::remove_reference(ref_id)
                .await
                .map_err(|e| err_string(e, "unlink failed"))?;
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "ok": true }))
        }
        Some("remove") => {
            let Some(node_id) = body["nodeId"].as_str().filter(|n| !n.trim().is_empty()) else {
                return Err("nodeId required".into());
            };
            let restore = sources::remove_from_vault(node_id)
                .await
                .map_err(|e| err_string(e, "remove failed"))?;
            let _ = app.emit("vault-changed", ());
            // Return the restore descriptor so the client can offer Undo.
            Ok(json!({ "ok": true, "restore": restore }))
        }
        Some("restore") => {
            let token = &body["token"];
            if !token.is_object() {
                return Err("token required".into());
            }
            let result = sources::restore_from_vault(token)
                .await
                .map_err(|e| err_string(e, "restore failed"))?;
            let _ = app.emit("vault-changed", ());
            Ok(result)
        }
        // Deterministic guarded re-execution of an analytics answer's SQL
        // over exactly the files it read (Edit SQL / refinement plumbing) —
        // no model, no persistence.
        Some("analyticsSql") => {
            let sql = body["sql"].as_str().unwrap_or("").to_string();
            let file_ids: Vec<String> = body["fileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            // With `saveAs`, the same guarded run also writes a full-fidelity
            // CSV into Lighthouse Results/ (openspec: add-answer-artifacts).
            if let Some(hint) = body["saveAs"].as_str() {
                return Ok(
                    match lighthouse_core::analytics::run_direct_save(&sql, &file_ids, hint)
                        .await
                    {
                        Ok((r, saved)) => {
                            let _ = app.emit("vault-changed", ());
                            json!({
                                "markdown": r.markdown,
                                "chart": r.chart,
                                "footer": r.footer,
                                "savedId": saved.id,
                                "savedName": saved.name,
                                "rows": saved.rows,
                            })
                        }
                        Err(e) => json!({ "error": e }),
                    },
                );
            }
            Ok(match lighthouse_core::analytics::run_direct(&sql, &file_ids).await {
                Ok(r) => json!({
                    "markdown": r.markdown,
                    "chart": r.chart,
                    "footer": r.footer,
                }),
                Err(e) => json!({ "error": e }),
            })
        }
        // Write the client-rendered transcript as a markdown note into
        // Lighthouse Notes/ (openspec: add-answer-artifacts). Ordinary vault
        // file: walked, watched, inclusion-ruled.
        Some("exportChat") => {
            let title = body["title"].as_str().unwrap_or("Chat").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if markdown.trim().is_empty() {
                return Err("markdown required".into());
            }
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::write_artifact(
                    "Lighthouse Notes",
                    &title,
                    "md",
                    markdown.as_bytes(),
                )
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| e.to_string()));
            Ok(match written {
                Ok((id, name)) => {
                    let _ = app.emit("vault-changed", ());
                    json!({ "savedId": id, "savedName": name })
                }
                Err(e) => json!({ "error": e }),
            })
        }
        // --- Pinned questions (openspec: add-pinned-questions): persist an
        //     analytics answer's question + SQL + files; rechecks are guarded
        //     and model-free. The background scheduler lives in main.rs. ---
        Some("pinAsk") => {
            let question = body["question"].as_str().unwrap_or("").to_string();
            let sql = body["sql"].as_str().unwrap_or("").to_string();
            let file_ids: Vec<String> = body["fileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Ok(match lighthouse_core::pins::add(&question, &sql, &file_ids) {
                Ok(pin) => {
                    // Prime the fresh pin's digest + summary so the dialog has
                    // something to show (and the first real change alerts).
                    let _ = lighthouse_core::pins::recheck_one(&pin.id).await;
                    let pins = lighthouse_core::pins::list();
                    let primed =
                        pins.iter().find(|p| p.id == pin.id).cloned().unwrap_or(pin);
                    json!({ "pin": primed })
                }
                Err(e) => json!({ "error": e }),
            })
        }
        Some("unpinAsk") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return Err("id required".into());
            };
            lighthouse_core::pins::remove(id);
            Ok(json!({ "ok": true }))
        }
        Some("listPins") => Ok(json!({ "pins": lighthouse_core::pins::list() })),
        Some("recheckPins") => {
            let changed = lighthouse_core::pins::recheck_all().await;
            Ok(json!({
                "changed": changed,
                "pins": lighthouse_core::pins::list(),
            }))
        }
        // Catalog-derived example questions for the chat empty state — every
        // one names real columns of a real included file, so the analytics
        // path can answer it. Empty when nothing tabular is included.
        Some("suggestedAsks") => {
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let asks =
                tokio::task::spawn_blocking(move || lighthouse_core::meta::suggested_asks(&ids))
                    .await
                    .unwrap_or_default();
            Ok(json!({ "asks": asks }))
        }
        // Managed policy snapshot (openspec: add-managed-policy) — read-only;
        // the UI renders the reported locks as "Managed by your organization".
        Some("policy") => Ok(lighthouse_core::policy::snapshot()),
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
    let cfg = profile::model_config();
    // Mark a chat in flight so background-conserve suspension (hide-to-tray /
    // idle) can't kill the local chat server out from under this stream — the
    // teardown waits until the guard drops at the end of the ask.
    let _chat_guard = crate::supervise::ChatGuard::new();
    // The whole ask path — single-shot RAG or multi-document synthesis, with
    // pre-answer progress chunks (docs/multi-doc-synthesis.md) — lives in the
    // engine pipeline, shared with the axum route (retrieval-query blending
    // included).
    let mut chunks = lighthouse_core::synth::answer_pipeline(
        question,
        included_file_ids,
        attachment_file_ids,
        history,
        cfg,
    );
    while let Some(c) = chunks.next().await {
        let _ = on_chunk.send(c);
    }
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
pub async fn profile_op(body: Value) -> Result<Value, String> {
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
        Some("selectModel") => {
            let provider_id = body["providerId"].as_str().unwrap_or("");
            // Managed policy: reject a disallowed provider with a real error
            // (select_model itself also refuses to persist, belt-and-braces).
            if !lighthouse_core::policy::provider_allowed(provider_id) {
                return Err("this AI provider is managed off by your organization".into());
            }
            emit_model_selected(Some(profile::select_model(
                provider_id,
                body["modelId"].as_str().unwrap_or(""),
                body["apiKey"].as_str().unwrap_or(""),
            )))
        }
        Some("setDefaultInclusion") => {
            let v = body["value"].as_str().unwrap_or("");
            if v != "include" && v != "exclude" {
                return Err("value must be include or exclude".into());
            }
            profile::set_default_inclusion(v);
        }
        Some("completeOnboarding") => profile::complete_onboarding(),
        Some("signOut") => profile::sign_out(),
        // Live "does this key work" probe. A blank key tests the one the
        // chat would actually use (stored or env). Returns {ok, error?}, NOT
        // the profile state — and never persists anything.
        Some("validateKey") => {
            let provider = body["providerId"].as_str().unwrap_or("").to_string();
            let pasted = body["apiKey"].as_str().unwrap_or("").trim().to_string();
            let key = if pasted.is_empty() {
                profile::resolved_key_for(&provider).unwrap_or_default()
            } else {
                pasted
            };
            return Ok(match lighthouse_core::llm::validate_key(&provider, &key).await {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e }),
            });
        }
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
        Some("featureInterest") => {
            let to_ids = |v: &serde_json::Value| -> Vec<String> {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default()
            };
            let shown = to_ids(&body["shown"]);
            let wanted = to_ids(&body["wanted"]);
            Ok(json!({ "ok": license::submit_feature_interest(&shown, &wanted).await }))
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

// The model commands are async so they run on the Tauri async runtime, NOT the
// main thread. That (a) gives `start_download()` an ambient Tokio runtime to
// spawn onto, and (b) contains any future panic in this path to the task —
// sync commands run on the main thread, where a panic exits the whole app
// (which is exactly how the Install click used to crash the desktop build).
#[tauri::command]
pub async fn model_status() -> Value {
    serde_json::to_value(local_model::model_status()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub async fn model_download() -> Value {
    serde_json::to_value(local_model::start_download()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub async fn model_uninstall() -> Value {
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

/// Reveal a vault node in the OS file manager, selecting it inside its folder.
/// A blank node id (or none) opens the vault directory itself, so the same
/// route backs both the row action and the toolbar's "Open vault folder".
/// Works for folders too (a folder reveals/opens in place).
#[tauri::command]
pub fn reveal_node(app: AppHandle, node_id: Option<String>) -> Result<Value, String> {
    match node_id.filter(|s| !s.trim().is_empty()) {
        None => {
            crate::open_with_os(&crate::vault_dir_setting(&app));
            Ok(json!({ "ok": true }))
        }
        Some(id) => {
            let abs = vault::resolve_node_path(&id)
                .map_err(|e| err_string(e, "could not reveal file"))?;
            if std::fs::metadata(&abs).is_err() {
                return Err("file no longer exists".into());
            }
            crate::reveal_with_os(&abs);
            Ok(json!({ "ok": true }))
        }
    }
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Value {
    let s = settings::read_desktop_settings();
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    json!({
        "desktop": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode, // null until the first-run chooser is answered
        "whisperMode": s.whisper_mode == Some(true),
        // "granted" | "pending" (macOS Accessibility) | "unsupported" | "unknown"
        "whisperPermission": crate::whisper::permission_state(),
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        // False on Wayland — the UI swaps hotkey copy for the tray fallback.
        "summonHotkeyOk": hotkey_ok,
        "semanticSearch": s.semantic_search != Some(false), // default on (B2)
        "backgroundConserve": s.background_conserve != Some(false), // default on
        "ocrEnabled": s.ocr_enabled != Some(false), // default on (add-ocr-perception)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn settings_set(
    app: AppHandle,
    run_on_startup: Option<bool>,
    startup_asked: Option<bool>,
    ui_mode: Option<String>,
    whisper_mode: Option<bool>,
    summon_shortcut: Option<String>,
    semantic_search: Option<bool>,
    background_conserve: Option<bool>,
    ocr_enabled: Option<bool>,
) -> Value {
    // A new summon shortcut must PARSE before anything persists — saving an
    // unregistrable string would strand the user with no hotkey at all.
    // Empty string = reset to the default chord.
    if let Some(accel) = summon_shortcut.as_deref().map(str::trim) {
        if !accel.is_empty()
            && accel
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .is_err()
        {
            let s = settings::read_desktop_settings();
            return json!({
                "ok": false,
                "reason": "that key combination can't be registered",
                "summonShortcut": s
                    .summon_shortcut
                    .as_deref()
                    .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
            });
        }
    }
    let switched_mode = ui_mode.clone();
    let shortcut_changed = summon_shortcut.is_some();
    // Remember the working chord so a new one that PARSES but fails to
    // register (another app already owns it) can be rolled back instead of
    // stranding the user hotkey-less with a broken value persisted.
    let prev_shortcut = settings::read_desktop_settings().summon_shortcut;
    let s = settings::write_desktop_settings(
        run_on_startup,
        startup_asked,
        ui_mode,
        whisper_mode,
        summon_shortcut,
        semantic_search,
        background_conserve,
        ocr_enabled,
    );
    if shortcut_changed && !crate::register_summon_shortcut(&app) {
        // The new chord didn't register — restore the previous one so the
        // summon hotkey keeps working, and report the failure to the UI.
        // Pass "" (not None) when the previous value was the default, so the
        // writer actually overwrites the bad chord instead of leaving it.
        settings::write_desktop_settings(
            None,
            None,
            None,
            None,
            Some(prev_shortcut.clone().unwrap_or_default()),
            None,
            None,
            None,
        );
        crate::register_summon_shortcut(&app);
        return json!({
            "ok": false,
            "reason": "another app already uses that shortcut — kept the previous one",
            "summonShortcut": prev_shortcut
                .as_deref()
                .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
            "summonHotkeyOk": true,
        });
    }
    // Autostart is CONSENT-FIRST (mirrors the boot gate in main.rs): only
    // touch the OS registration once the startup prompt has been answered.
    // Unrelated writes — e.g. the first-run uiMode chooser — must not enroll.
    if s.startup_asked == Some(true) {
        crate::apply_autostart(&app, s.run_on_startup != Some(false));
    }
    // Switching interface mode at runtime applies the mode's RESIDENCY
    // immediately, like a boot would, and swaps the visible SURFACE whole:
    // widget mode tucks the main window away and summons the bar (the bar
    // REPLACES the window — leaving both up made the switch read as broken);
    // window mode dismisses the bar and brings the window back. The user's
    // pin (always-on-top) is independent of the mode and untouched here.
    // Window work is deferred to the main thread: show_widget may lazily
    // CREATE the widget window, and building a webview from a sync command
    // handler deadlocks the IPC thread against the main loop.
    if let Some(mode) = switched_mode.as_deref() {
        let resident = mode == "widget";
        crate::set_widget_resident(&app, resident);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if resident {
                if let Some(main) = app2.get_webview_window("main") {
                    let _ = main.hide();
                }
                crate::show_widget(&app2, true);
            } else {
                crate::hide_widget(&app2);
                if let Some(main) = app2.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        });
    }
    // Whisper mode (W3) starts/stops its keyboard hook live — no relaunch.
    // Managed policy widgetHotkeys "off": turning it ON is refused here (the
    // hook must never install); turning it OFF is always honored.
    if let Some(on) = whisper_mode {
        if !on || lighthouse_core::policy::hotkeys_allowed() {
            crate::whisper::set_enabled(&app, on);
        }
    }
    // Semantic search (B2) applies live too: the supervisor's 3 s reconcile
    // starts or stops the embedding server to match the new setting, and its
    // health poll kicks the vector warm pass once the server is up.
    if semantic_search.is_some() {
        app.state::<crate::supervise::Supervisor>().reconcile(&app);
    }
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    json!({
        "ok": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode,
        "whisperMode": s.whisper_mode == Some(true),
        "whisperPermission": crate::whisper::permission_state(),
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        "summonHotkeyOk": hotkey_ok,
        "semanticSearch": s.semantic_search != Some(false),
        "backgroundConserve": s.background_conserve != Some(false),
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
        Some(info) => json!({
            "phase": "available",
            "version": info.version,
            "url": crate::supervise::RELEASE_PAGE_URL,
            // In-app install = asset + detached signature + a baked-in key to
            // verify with (updater Phase B); otherwise the button says
            // "Get it" and opens the releases page.
            "canInstall": info.asset_url.is_some()
                && info.sig_url.is_some()
                && crate::supervise::updater_pubkey().is_some(),
        }),
        None => json!({ "phase": "none" }),
    }
}

/// Click-to-update from the sidebar banner: download this platform's
/// installer and hand off to it (see supervise::update_now for the
/// per-platform behavior and fallbacks).
#[tauri::command]
pub async fn update_now(app: AppHandle) -> Value {
    crate::supervise::update_now(app).await
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

/// CI boot smoke (LIGHTHOUSE_SMOKE=1, release-smoke.yml): the in-webview
/// probe reports its verdict here and the process exits with it — 0 for a
/// grounded answer, 2 for a failed assertion. Inert outside smoke mode (the
/// driver JS that invokes it is only ever injected when the env var is set).
#[tauri::command]
pub fn smoke_report(app: tauri::AppHandle, payload: String) {
    eprintln!("SMOKE {payload}");
    let ok = payload.starts_with("OK");
    app.exit(if ok { 0 } else { 2 });
}

// --- Desktop widget (docs/widget-scope.md §7, W1 frozen contract). All are
// plain app commands so the widget webview needs no extra ACL grants; window
// mutations happen Rust-side, which also keeps the pin state authoritative
// for the blur-hide decision in main.rs. ---

/// Hide the widget (Esc, the ✕ button, or after a result action).
#[tauri::command]
pub fn widget_hide(app: AppHandle) {
    crate::hide_widget(&app);
}

/// Summon the widget from the UI (the first-run mode chooser and Preferences
/// use it to demo widget mode the moment it's picked). Async + main-thread
/// hop for the same reason as open_explorer: show_widget lazily CREATES the
/// widget window when boot deferred it, and a sync command doing that
/// deadlocks the IPC handler against the main loop.
#[tauri::command]
pub async fn widget_show(app: AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::show_widget(&inner, true);
        // This command IS the user's explicit "turn widget mode on" gesture
        // (mode chooser, Preferences demo). A bar that silently fails to
        // appear reads as a dead toggle (0.6.3 field report) — diagnose
        // loudly here, never on routine summons.
        if inner.get_webview_window(crate::WIDGET_LABEL).is_none() {
            crate::shell_log(&inner, "widget_show: bar unavailable after an explicit enable");
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            inner
                .dialog()
                .message(
                    "The floating search bar couldn't start on this machine.\n\nA diagnostic was written to shell.log in Lighthouse's app-data folder — please share that file so this can be fixed.",
                )
                .title("Lighthouse — widget mode")
                .kind(MessageDialogKind::Warning)
                .show(|_| {});
        }
    });
}

/// Pin = the user's "keep above other windows" toggle: always-on-top AND no
/// blur auto-hide. The bar is otherwise a normal-stacking window (created
/// non-topmost; widget-mode residency only prevents auto-hide), so this is
/// the one switch that visibly changes stacking — pinned floats over
/// everything, unpinned lets other windows cover it until the next summon.
#[tauri::command]
pub fn widget_set_pin(app: AppHandle, pinned: bool) {
    crate::set_widget_pinned(&app, pinned);
    if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
        let _ = w.set_always_on_top(pinned);
        // A pinned bar should survive workspace switches where the OS
        // supports it (macOS/Linux; a no-op on Windows).
        let _ = w.set_visible_on_all_workspaces(pinned);
    }
}

/// Grow/shrink the widget window as the results dropdown or the inline
/// answer panel renders. Height is clamped shell-side so a misbehaving page
/// can't fill the screen (520 leaves room for a compact streamed answer).
#[tauri::command]
pub fn widget_resize(app: AppHandle, height: f64) {
    const MIN: f64 = 56.0;
    const MAX: f64 = 520.0;
    if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
        let clamped = height.clamp(MIN, MAX);
        let _ = w.set_size(tauri::LogicalSize::new(crate::WIDGET_WIDTH, clamped));
    }
}

/// Hold = an inline answer is on screen. Blur must not dismiss the bar while
/// the user reads a "frozen" compact answer (clicking away to their document
/// is the POINT); Esc/✕ still hide explicitly. Orthogonal to the user's pin.
#[tauri::command]
pub fn widget_hold(app: AppHandle, hold: bool) {
    if let Some(state) = app.try_state::<crate::WidgetHold>() {
        state.0.store(hold, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Raise the main window; with a seed question, hand it to the chat panel
/// ("Ask Lighthouse →" from the widget). The transport re-broadcasts the
/// event as a DOM CustomEvent the ChatPanel listens for.
#[tauri::command]
pub fn show_main(app: AppHandle, seed_question: Option<String>) {
    use tauri::Emitter;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // Resume the local servers if background-conserve had suspended them.
        crate::resume_servers(&app);
    }
    if let Some(q) = seed_question.filter(|q| !q.trim().is_empty()) {
        let _ = app.emit_to("main", "ask-question", json!({ "question": q }));
    }
}

/// Open the vault directory in the OS file manager (File menu; also kept for
/// anything that wants the literal folder rather than the explorer window).
#[tauri::command]
pub fn open_vault_dir(app: AppHandle) {
    crate::open_with_os(&crate::vault_dir_setting(&app));
}

/// Open (or raise) the standalone vault-explorer window — the widget's 📁
/// button (W2). Same FileExplorer as the main sidebar, in its own window.
///
/// ASYNC + main-thread hop, deliberately: a SYNC command that builds a
/// webview window deadlocks the IPC handler against the main loop (the
/// handler blocks a thread the window creation needs). Field symptom: the
/// 📁 click produced a stillborn white window on Windows and no window at
/// all on Linux. Async commands release the IPC thread, and the explicit
/// run_on_main_thread makes the builder run where GTK/AppKit require it.
#[tauri::command]
pub async fn open_explorer(app: AppHandle) {
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || crate::open_explorer(&inner));
}
