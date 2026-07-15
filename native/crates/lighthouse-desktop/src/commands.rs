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
use lighthouse_core::{local_model, profile, settings, sources, tts, vault};

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
        // --- G6 cross-conversation recall: auto-export a chat as an indexed
        //     vault note under Lighthouse Notes/Chats/, OVERWRITTEN in place per
        //     conversation id (one current note per chat). Client-gated on "Save
        //     chats on this device". ---
        Some("exportConversationNote") => {
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let title = body["title"].as_str().unwrap_or("Conversation").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if conversation_id.trim().is_empty() || markdown.trim().is_empty() {
                return Err("conversationId and markdown required".into());
            }
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::write_conversation_note(
                    &conversation_id,
                    &title,
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
        // G6 fail-closed opt-out: delete every auto-exported chat note.
        Some("purgeConversationNotes") => {
            let purged =
                tokio::task::spawn_blocking(lighthouse_core::vault::purge_conversation_notes)
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r.map_err(|e| e.to_string()));
            Ok(match purged {
                Ok(()) => {
                    let _ = app.emit("vault-changed", ());
                    json!({ "ok": true })
                }
                Err(e) => json!({ "error": e }),
            })
        }
        // --- Briefing note refresh (G5): recheck each pin for a REAL before→
        //     after, compose the deterministic note, and overwrite Lighthouse
        //     Notes/Lighthouse Briefing.md in place. No OS notification here —
        //     the user is in the dialog; the result is confirmed inline. ---
        Some("refreshBriefingNote") => {
            // Recheck to freshen each pin's summary, then compose from a SNAPSHOT
            // of every pin that has a summary (matching the web twin) — NOT just
            // what changed on this recheck. A manual refresh regenerates the whole
            // briefing, so it never clobbers a meaningful note with the empty-set
            // message just because nothing changed since the last check. No OS
            // notification (the user is in the dialog) and NO daily-gate stamp: the
            // on-demand snapshot and the scheduled daily delta are independent.
            let _ = lighthouse_core::pins::recheck_all().await;
            let now = lighthouse_core::config::now_ms();
            let entries: Vec<lighthouse_core::pins::ChangedPin> = lighthouse_core::pins::list()
                .into_iter()
                .filter_map(|p| {
                    p.last_summary.clone().map(|s| lighthouse_core::pins::ChangedPin {
                        id: p.id.clone(),
                        question: p.question.clone(),
                        before: None,
                        after: s,
                    })
                })
                .collect();
            let md = lighthouse_core::briefings::compose_briefing_note(&entries, now);
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::refresh_artifact(
                    "Lighthouse Notes",
                    "Lighthouse Briefing",
                    "md",
                    md.as_bytes(),
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
        Some("listBriefings") => Ok(json!({ "briefings": lighthouse_core::briefings::list() })),
        Some("saveBriefing") => {
            let title = body["title"].as_str().unwrap_or("").to_string();
            let pin_ids: Vec<String> = body["pinIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cadence = match body["cadence"].as_str() {
                Some("daily") => lighthouse_core::briefings::Cadence::Daily,
                Some("weekly") => lighthouse_core::briefings::Cadence::Weekly,
                _ => lighthouse_core::briefings::Cadence::Manual,
            };
            Ok(match lighthouse_core::briefings::add(&title, &pin_ids, cadence) {
                Ok(briefing) => json!({ "briefing": briefing }),
                Err(e) => json!({ "error": e }),
            })
        }
        Some("removeBriefing") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return Err("id required".into());
            };
            lighthouse_core::briefings::remove(id);
            Ok(json!({ "ok": true }))
        }
        Some("runBriefing") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return Err("id required".into());
            };
            Ok(json!({ "report": lighthouse_core::briefings::run(id).await }))
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
        // Session egress snapshot (S3) — what has left this machine this
        // session; the header shield renders "All local" / "N to <host>".
        Some("egress") => Ok(lighthouse_core::egress::snapshot()),
        // Local audit log (openspec: add-audit-log) — durable record behind the
        // session egress panel. List/verify read-only; export writes a CSV into
        // the vault via the same sanitized helper as exportChat.
        Some("auditList") => {
            let limit = body["limit"].as_u64().unwrap_or(100) as usize;
            Ok(lighthouse_core::audit::recent(limit))
        }
        Some("auditVerify") => Ok(lighthouse_core::audit::verify_active()),
        Some("auditExport") => {
            let csv = tokio::task::spawn_blocking(lighthouse_core::audit::export_csv)
                .await
                .unwrap_or_default();
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::write_artifact(
                    "Lighthouse Notes",
                    "Audit Log",
                    "csv",
                    csv.as_bytes(),
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
    // Audit log (add-audit-log): capture the question + egress baseline before
    // the answer, record once the final chunk's references are known. Covers
    // the widget AND the main window (both invoke this command).
    let audit = lighthouse_core::audit::AnswerAudit::start(&question);
    let provider = cfg
        .provider_id
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let mut chunks = lighthouse_core::synth::answer_pipeline(
        question,
        included_file_ids,
        attachment_file_ids,
        history,
        cfg,
    );
    let mut final_files: Vec<String> = Vec::new();
    let mut artifacts: Vec<String> = Vec::new();
    while let Some(c) = chunks.next().await {
        if c.done {
            if let Some(refs) = &c.references {
                final_files = refs.iter().map(|r| r.file_id.clone()).collect();
            }
            if let Some(a) = &c.analytics {
                artifacts.extend(a.file_ids.iter().cloned());
            }
        }
        let _ = on_chunk.send(c);
    }
    audit.finish(&provider, final_files, artifacts);
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

#[tauri::command]
pub fn profile_get() -> Value {
    serde_json::to_value(profile::get_state()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub async fn profile_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
        Some("finishVault") => profile::finish_vault(),
        Some("finishMode") => profile::finish_mode(),
        Some("selectModel") => {
            let provider_id = body["providerId"].as_str().unwrap_or("");
            // Managed policy: reject a disallowed provider with a real error
            // (select_model itself also refuses to persist, belt-and-braces).
            if !lighthouse_core::policy::provider_allowed(provider_id) {
                return Err("this AI provider is managed off by your organization".into());
            }
            profile::select_model(
                provider_id,
                body["modelId"].as_str().unwrap_or(""),
                body["apiKey"].as_str().unwrap_or(""),
            );
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

/// Best-effort tail of the desktop shell.log (the app-data `shell.log` the
/// shell writes via `shell_log`). Returns "" on ANY error, and caps the excerpt
/// to the last ~100 lines / ~16 KB so a bug report stays small. This is the only
/// diagnostics attached to a report, and only when the user opts in.
fn shell_log_excerpt(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("shell.log")) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(100);
    let mut excerpt = lines[start..].join("\n");
    const MAX_BYTES: usize = 16 * 1024;
    if excerpt.len() > MAX_BYTES {
        // Keep the newest bytes; advance the cut to a char boundary.
        let mut cut = excerpt.len() - MAX_BYTES;
        while cut < excerpt.len() && !excerpt.is_char_boundary(cut) {
            cut += 1;
        }
        excerpt = excerpt[cut..].to_string();
    }
    excerpt
}

/// Diagnostics for the "Send feedback" dialog: app version, OS, and — only when
/// the user opts in — a shell.log excerpt. Read-only; the app transmits none of
/// it. The dialog composes a mailto:/GitHub-issue the user sends themselves.
#[tauri::command]
pub async fn diagnostics(app: AppHandle) -> Result<Value, String> {
    Ok(json!({
        "version": lighthouse_core::config::app_version(),
        "os": std::env::consts::OS,
        "log": shell_log_excerpt(&app),
    }))
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
pub async fn model_status(app: AppHandle) -> Value {
    let mut v = serde_json::to_value(local_model::model_status()).unwrap_or_else(|_| json!({}));
    // Merge the shell's REAL llama-server GPU launch state (G2) so the AI-models
    // dialog shows "GPU acceleration: on (N layers)" / "off — CPU" instead of a
    // guess. Absent until a chat server has run this session (gpu_status None) —
    // the UI treats missing fields as "unknown → render nothing".
    if let (Some(obj), Some(g)) = (
        v.as_object_mut(),
        app.try_state::<crate::supervise::Supervisor>()
            .and_then(|s| s.gpu_status()),
    ) {
        obj.insert("gpuOn".into(), json!(g.gpu));
        obj.insert("gpuLayers".into(), json!(g.layers));
        obj.insert("gpuRunning".into(), json!(g.running));
    }
    v
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
        "auditEnabled": s.audit_enabled == Some(true), // opt-in, default off (add-audit-log)
        "draftAnswers": s.draft_answers != Some(false), // default on (G2)
        "briefingNotify": s.briefing_notify != Some(false), // default on (G5)
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9), // default 9am (G5)
        "tourShown": s.tour_shown == Some(true), // first-run tour, once per install
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
    audit_enabled: Option<bool>,
    draft_answers: Option<bool>,
    briefing_notify: Option<bool>,
    briefing_note_hour: Option<i64>,
    tour_shown: Option<bool>,
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
        audit_enabled,
        draft_answers,
        briefing_notify,
        briefing_note_hour,
        tour_shown,
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
            None,
            None,
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
        "draftAnswers": s.draft_answers != Some(false),
        "briefingNotify": s.briefing_notify != Some(false),
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9),
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
