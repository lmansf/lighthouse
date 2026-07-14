//! The 13 local API routes (port of `app/api/*/route.ts`), wire-compatible with
//! the Next.js server so the existing UI runs against this binary unmodified.

use axum::body::Body;
use axum::extract::Multipart;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde_json::{json, Value};

use lighthouse_core::config::is_desktop_app;
use lighthouse_core::contracts::{ChatChunk, ChatTurn};
use lighthouse_core::{license, llm, local_model, profile, settings, sources, tts, usage, vault};

use crate::auth::is_same_origin;

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "cross-origin request rejected" })),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn err_message(err: &anyhow::Error, fallback: &str) -> String {
    let m = err.to_string();
    if m.is_empty() {
        fallback.to_string()
    } else {
        m
    }
}

// --- /api/rag -----------------------------------------------------------------

pub async fn rag_get() -> Response {
    let (sources_list, nodes) = tokio::join!(sources::list_sources(), sources::list_nodes());
    Json(json!({ "sources": sources_list, "nodes": nodes, "desktop": is_desktop_app() }))
        .into_response()
}

pub async fn rag_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    match body["op"].as_str() {
        Some("include") => {
            let (Some(node_id), Some(included)) =
                (body["nodeId"].as_str(), body["included"].as_bool())
            else {
                return bad_request("nodeId and included required");
            };
            sources::set_included(node_id, included).await;
            Json(json!({ "ok": true })).into_response()
        }
        Some("source") => {
            let Some(available) = body["available"].as_bool() else {
                return bad_request("available required");
            };
            sources::set_source_available(available, body["sourceId"].as_str()).await;
            Json(json!({ "ok": true })).into_response()
        }
        Some("search") => {
            let query = body["query"].as_str().unwrap_or("");
            let ids: Vec<String> = string_array(&body["includedFileIds"]);
            let retrieved = sources::retrieve(query, &ids, &[], 5).await;
            Json(json!({ "references": retrieved.references })).into_response()
        }
        Some("move") => {
            let Some(from) = body["from"].as_str() else {
                return bad_request("from required");
            };
            match sources::move_node(from, body["toParentId"].as_str()).await {
                Ok(new_id) => Json(json!({ "newId": new_id })).into_response(),
                Err(e) => bad_request(&err_message(&e, "move failed")),
            }
        }
        Some("rename") => {
            let (Some(id), Some(name)) = (body["id"].as_str(), body["name"].as_str()) else {
                return bad_request("id and name required");
            };
            match sources::rename_node(id, name).await {
                Ok(new_id) => Json(json!({ "newId": new_id })).into_response(),
                Err(e) => bad_request(&err_message(&e, "rename failed")),
            }
        }
        Some("newFolder") => {
            let Some(name) = body["name"].as_str() else {
                return bad_request("name required");
            };
            match sources::create_folder(body["parentId"].as_str(), name).await {
                Ok(new_id) => Json(json!({ "newId": new_id })).into_response(),
                Err(e) => bad_request(&err_message(&e, "could not create folder")),
            }
        }
        Some("addReference") => {
            if !is_desktop_app() {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "linking files is available only in the desktop app" })),
                )
                    .into_response();
            }
            let Some(path) = body["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                return bad_request("path required");
            };
            match sources::add_reference(path).await {
                Ok((id, kind)) => Json(json!({ "id": id, "kind": kind })).into_response(),
                Err(e) => bad_request(&err_message(&e, "link failed")),
            }
        }
        Some("removeReference") => {
            let Some(ref_id) = body["refId"].as_str() else {
                return bad_request("refId required");
            };
            match sources::remove_reference(ref_id).await {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(e) => bad_request(&err_message(&e, "unlink failed")),
            }
        }
        Some("remove") => {
            let Some(node_id) = body["nodeId"].as_str().filter(|n| !n.trim().is_empty()) else {
                return bad_request("nodeId required");
            };
            match sources::remove_from_vault(node_id).await {
                Ok(restore) => Json(json!({ "ok": true, "restore": restore })).into_response(),
                Err(e) => bad_request(&err_message(&e, "remove failed")),
            }
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
                return match lighthouse_core::analytics::run_direct_save(&sql, &file_ids, hint)
                    .await
                {
                    Ok((r, saved)) => Json(json!({
                        "markdown": r.markdown,
                        "chart": r.chart,
                        "footer": r.footer,
                        "savedId": saved.id,
                        "savedName": saved.name,
                        "rows": saved.rows,
                    }))
                    .into_response(),
                    Err(e) => Json(json!({ "error": e })).into_response(),
                };
            }
            return match lighthouse_core::analytics::run_direct(&sql, &file_ids).await {
                Ok(r) => Json(json!({
                    "markdown": r.markdown,
                    "chart": r.chart,
                    "footer": r.footer,
                }))
                .into_response(),
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        // Write the client-rendered transcript as a markdown note into
        // Lighthouse Notes/ (openspec: add-answer-artifacts). Ordinary vault
        // file: walked, watched, inclusion-ruled.
        Some("exportChat") => {
            let title = body["title"].as_str().unwrap_or("Chat").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if markdown.trim().is_empty() {
                return bad_request("markdown required");
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
            return match written {
                Ok((id, name)) => {
                    Json(json!({ "savedId": id, "savedName": name })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        // --- Pinned questions (openspec: add-pinned-questions): persist an
        //     analytics answer's question + SQL + files; rechecks are guarded
        //     and model-free. The dev twin mirrors these ops (PARITY: no
        //     background scheduler anywhere but the desktop shell). ---
        Some("pinAsk") => {
            let question = body["question"].as_str().unwrap_or("").to_string();
            let sql = body["sql"].as_str().unwrap_or("").to_string();
            let file_ids: Vec<String> = body["fileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            return match lighthouse_core::pins::add(&question, &sql, &file_ids) {
                Ok(pin) => {
                    // Prime the fresh pin's digest + summary so the dialog has
                    // something to show (and the first real change alerts).
                    let _ = lighthouse_core::pins::recheck_one(&pin.id).await;
                    let pins = lighthouse_core::pins::list();
                    let primed =
                        pins.iter().find(|p| p.id == pin.id).cloned().unwrap_or(pin);
                    Json(json!({ "pin": primed })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        Some("unpinAsk") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return bad_request("id required");
            };
            lighthouse_core::pins::remove(id);
            return Json(json!({ "ok": true })).into_response();
        }
        Some("listPins") => {
            return Json(json!({ "pins": lighthouse_core::pins::list() })).into_response();
        }
        Some("recheckPins") => {
            let changed = lighthouse_core::pins::recheck_all().await;
            return Json(json!({
                "changed": changed,
                "pins": lighthouse_core::pins::list(),
            }))
            .into_response();
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
            return Json(json!({ "asks": asks })).into_response();
        }
        Some("restore") => {
            let token = &body["token"];
            if !token.is_object() {
                return bad_request("token required");
            }
            match sources::restore_from_vault(token).await {
                Ok(result) => Json(result).into_response(),
                Err(e) => bad_request(&err_message(&e, "restore failed")),
            }
        }
        // Managed policy snapshot (openspec: add-managed-policy) — read-only;
        // the UI renders the reported locks as "Managed by your organization".
        Some("policy") => Json(lighthouse_core::policy::snapshot()).into_response(),
        _ => bad_request("unknown op"),
    }
}

fn string_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// --- /api/chat ----------------------------------------------------------------

pub async fn chat_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let question = body["question"].as_str().unwrap_or("").to_string();
    let included_file_ids = string_array(&body["includedFileIds"]);
    // Files the user explicitly attached to this question.
    let attachment_ids = string_array(&body["attachmentFileIds"]);
    // Prior turns (sanitized) so follow-ups have conversational context; capped
    // to the last few to bound token cost.
    let history: Vec<ChatTurn> = body["history"]
        .as_array()
        .map(|a| {
            let turns: Vec<ChatTurn> = a
                .iter()
                .filter_map(|t| {
                    let role = t["role"].as_str()?;
                    let content = t["content"].as_str()?;
                    if role == "user" || role == "assistant" {
                        Some(ChatTurn {
                            role: role.to_string(),
                            content: content.to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect();
            let skip = turns.len().saturating_sub(8);
            turns.into_iter().skip(skip).collect()
        })
        .unwrap_or_default();

    let cfg = profile::model_config();

    let line = |c: &ChatChunk| -> bytes::Bytes {
        bytes::Bytes::from(format!(
            "{}\n",
            serde_json::to_string(c).unwrap_or_default()
        ))
    };

    // The whole ask path — single-shot RAG or multi-document synthesis, with
    // pre-answer progress chunks (docs/multi-doc-synthesis.md) — lives in the
    // engine pipeline, so this route and the desktop IPC command behave
    // identically (retrieval-query blending included).
    let stream = async_stream::stream! {
        let mut chunks = lighthouse_core::synth::answer_pipeline(
            question,
            included_file_ids,
            attachment_ids,
            history,
            cfg,
        );
        while let Some(c) = chunks.next().await {
            yield Ok::<bytes::Bytes, std::convert::Infallible>(line(&c));
        }
    };

    Response::builder()
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// --- /api/tts -----------------------------------------------------------------

/// Cap synthesized text so a runaway request can't tie up Piper for minutes.
const TTS_MAX_CHARS: usize = 8000;

pub async fn tts_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    if !tts::is_local_tts_available() {
        // Not an error — the caller treats this as "use the browser voice instead".
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "local TTS unavailable" })),
        )
            .into_response();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let text: String = body["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(TTS_MAX_CHARS)
        .collect();
    if text.is_empty() {
        return bad_request("text required");
    }
    match tts::synthesize(&text).await {
        Ok(wav) => Response::builder()
            .header("content-type", "audio/wav")
            .header("cache-control", "no-store")
            .body(Body::from(wav))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "synthesis failed" })),
        )
            .into_response(),
    }
}

// --- /api/profile -------------------------------------------------------------

/// Emit a `model_selected` event for the initial choice and any later change.
fn emit_model_selected(sel: Option<profile::ModelSelectionResult>) {
    let Some(sel) = sel else { return };
    if (!sel.initial && !sel.changed) || sel.provider.is_empty() || sel.model.is_empty() {
        return;
    }
    tokio::spawn(async move {
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

pub async fn profile_get() -> Response {
    Json(profile::get_state()).into_response()
}

pub async fn profile_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
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
                return bad_request("this AI provider is managed off by your organization");
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
                return bad_request("value must be include or exclude");
            }
            profile::set_default_inclusion(v);
        }
        Some("completeOnboarding") => profile::complete_onboarding(),
        Some("signOut") => profile::sign_out(),
        // Live "does this key work" probe. A blank key tests the one the
        // chat would actually use (stored or env). Returns {ok, error?}, NOT
        // the profile state — and never persists anything.
        Some("validateKey") => {
            let provider = body["providerId"].as_str().unwrap_or("");
            let pasted = body["apiKey"].as_str().unwrap_or("").trim().to_string();
            let key = if pasted.is_empty() {
                profile::resolved_key_for(provider).unwrap_or_default()
            } else {
                pasted
            };
            return match llm::validate_key(provider, &key).await {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(e) => Json(json!({ "ok": false, "error": e })).into_response(),
            };
        }
        _ => return bad_request("unknown op"),
    }
    Json(profile::get_state()).into_response()
}

// --- /api/license -------------------------------------------------------------

pub async fn license_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    match body["op"].as_str() {
        Some("config") => Json(json!({ "paidEnabled": license::paid_enabled() })).into_response(),
        Some("check") => Json(license::check_license().await).into_response(),
        Some("start") => match license::start_trial(None).await {
            Ok(_) => Json(json!({ "ok": true })).into_response(),
            Err(e) => Json(json!({
                "ok": false,
                "reason": "rejected",
                "detail": err_message(&e, "start failed"),
            }))
            .into_response(),
        },
        Some("activate") => {
            let key = body["licenseKey"].as_str().unwrap_or("");
            let result = license::activate_license(key).await;
            let ok = result.status == "valid" || result.status == "grace";
            let mut payload = serde_json::to_value(&result).unwrap_or_else(|_| json!({}));
            payload["ok"] = json!(ok);
            Json(payload).into_response()
        }
        Some("feedback") => {
            let Some(f) = body.get("feedback").filter(|f| f.is_object()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({ "ok": false, "reason": "rejected", "detail": "feedback required" }),
                    ),
                )
                    .into_response();
            };
            let input = license::FeedbackInput {
                first_name: f["firstName"].as_str().unwrap_or("").trim().to_string(),
                last_name: f["lastName"].as_str().unwrap_or("").trim().to_string(),
                ease_of_use: f["easeOfUse"].as_f64().unwrap_or(0.0),
                overall_value: f["overallValue"].as_f64().unwrap_or(0.0),
                liked: f["liked"].as_str().unwrap_or("").trim().to_string(),
                change_or_add: f["changeOrAdd"].as_str().unwrap_or("").trim().to_string(),
                notify_when_available: f["notifyWhenAvailable"].as_bool().unwrap_or(false),
            };
            Json(json!({ "ok": license::submit_feedback(&input).await })).into_response()
        }
        Some("featureInterest") => {
            let to_ids = |v: &serde_json::Value| -> Vec<String> {
                v.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default()
            };
            let shown = to_ids(&body["shown"]);
            let wanted = to_ids(&body["wanted"]);
            Json(json!({ "ok": license::submit_feature_interest(&shown, &wanted).await }))
                .into_response()
        }
        Some("notify") => {
            let email = body["email"].as_str().unwrap_or("");
            if email.trim().is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "reason": "rejected", "detail": "email required" })),
                )
                    .into_response();
            }
            Json(json!({ "ok": license::submit_notify(email).await })).into_response()
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
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "reason": "rejected", "detail": "empty report" })),
                )
                    .into_response();
            }
            Json(json!({ "ok": license::submit_bug(&where_, &what).await })).into_response()
        }
        Some("ping") => {
            license::ping_launch().await;
            Json(json!({ "ok": true })).into_response()
        }
        Some("checkout") => {
            let url = license::checkout_url(body["email"].as_str()).await;
            Json(json!({ "url": url })).into_response()
        }
        _ => bad_request("unknown op"),
    }
}

// --- /api/usage ---------------------------------------------------------------

pub async fn usage_get() -> Response {
    Json(json!({ "optOut": usage::is_usage_opted_out() })).into_response()
}

pub async fn usage_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    match body["op"].as_str() {
        Some("consent") => {
            let opt_out = body["optOut"].as_bool().unwrap_or(false);
            usage::set_usage_opt_out(opt_out);
            Json(json!({ "ok": true, "optOut": opt_out })).into_response()
        }
        Some("events") => {
            let events = body["events"].as_array().cloned().unwrap_or_default();
            usage::append_usage_events(&events);
            Json(json!({ "ok": true })).into_response()
        }
        Some("publish") => {
            license::publish_usage_events().await;
            Json(json!({ "ok": true })).into_response()
        }
        _ => bad_request("unknown op"),
    }
}

// --- /api/event ---------------------------------------------------------------

pub async fn event_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return bad_request("name required");
    }
    let props = if body["props"].is_object() {
        body["props"].clone()
    } else {
        json!({})
    };
    // Fire-and-forget on the server side too; record_event swallows its errors.
    tokio::spawn(async move { license::record_event(&name, props).await });
    Json(json!({ "ok": true })).into_response()
}

// --- /api/connect -------------------------------------------------------------

fn connect_status_payload() -> Value {
    let s = sources::microsoft::load_state();
    json!({
        "connected": sources::microsoft::is_connected(),
        "account": s.account,
        "available": s.available.unwrap_or(true),
        "nodeCount": s.nodes.map(|n| n.len()).unwrap_or(0),
        "pending": s.pending.is_some(),
    })
}

pub async fn connect_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let result: anyhow::Result<Response> = async {
        match body["op"].as_str() {
            Some("status") => Ok(Json(connect_status_payload()).into_response()),
            Some("start") => {
                let flow = sources::microsoft::start_device_code().await?;
                Ok(Json(serde_json::to_value(flow)?).into_response())
            }
            Some("poll") => {
                let result = sources::microsoft::poll_device_code().await?;
                // On first success, populate the placeholder tree so files appear.
                if result.status == "connected" {
                    let _ = sources::sharepoint::refresh_listing().await;
                }
                let mut payload = serde_json::to_value(&result)?;
                if let (Some(obj), Some(status)) = (
                    payload.as_object_mut(),
                    connect_status_payload().as_object(),
                ) {
                    for (k, v) in status {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                Ok(Json(payload).into_response())
            }
            Some("refresh") => {
                if !sources::microsoft::is_connected() {
                    return Ok(bad_request("not connected"));
                }
                let node_count = sources::sharepoint::refresh_listing().await?;
                Ok(Json(json!({ "ok": true, "nodeCount": node_count })).into_response())
            }
            Some("disconnect") => {
                sources::sharepoint::disconnect();
                Ok(Json(json!({ "ok": true })).into_response())
            }
            _ => Ok(bad_request("unknown op")),
        }
    }
    .await;
    result.unwrap_or_else(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err_message(&err, "connection error") })),
        )
            .into_response()
    })
}

// --- /api/model ---------------------------------------------------------------

pub async fn model_get() -> Response {
    Json(local_model::model_status()).into_response()
}

pub async fn model_post(headers: HeaderMap) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    Json(local_model::start_download()).into_response()
}

pub async fn model_delete(headers: HeaderMap) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    Json(local_model::request_uninstall()).into_response()
}

// --- /api/open ----------------------------------------------------------------

/// Launch the platform's default opener for an absolute path, detached.
fn open_with_os(abs: &std::path::Path) {
    let (cmd, args): (&str, Vec<&std::ffi::OsStr>) = if cfg!(windows) {
        ("explorer.exe", vec![abs.as_os_str()])
    } else if cfg!(target_os = "macos") {
        ("open", vec![abs.as_os_str()])
    } else {
        ("xdg-open", vec![abs.as_os_str()])
    };
    // Never let a missing opener crash the request.
    let _ = std::process::Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

pub async fn open_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    if !is_desktop_app() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "opening files is available only in the desktop app" })),
        )
            .into_response();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let Some(node_id) = body["nodeId"].as_str().filter(|n| !n.trim().is_empty()) else {
        return bad_request("nodeId required");
    };
    match vault::resolve_node_path(node_id) {
        Ok(abs) => match std::fs::metadata(&abs) {
            Err(_) => (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "file no longer exists" })),
            )
                .into_response(),
            Ok(meta) if !meta.is_file() => bad_request("not a file"),
            Ok(_) => {
                open_with_os(&abs);
                Json(json!({ "ok": true })).into_response()
            }
        },
        Err(e) => bad_request(&err_message(&e, "could not open file")),
    }
}

// --- /api/upload ----------------------------------------------------------------

const MAX_FILE_BYTES: usize = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES: usize = 50;
const MAX_TOTAL_BYTES: usize = 200 * 1024 * 1024; // 200 MB per request

pub async fn upload_post(
    headers: HeaderMap,
    multipart: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let Ok(mut form) = multipart else {
        return bad_request("expected multipart/form-data");
    };

    // Collect fields in form order so files[i] pairs with paths[i].
    let mut files: Vec<(String, bytes::Bytes)> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    let mut dir: Option<String> = None;
    loop {
        match form.next_field().await {
            Ok(Some(field)) => match field.name() {
                Some("files") => {
                    let name = field.file_name().unwrap_or("").to_string();
                    match field.bytes().await {
                        Ok(bytes) => files.push((name, bytes)),
                        Err(_) => return bad_request("expected multipart/form-data"),
                    }
                }
                Some("paths") => paths.push(field.text().await.unwrap_or_default()),
                Some("dir") => {
                    let v = field.text().await.unwrap_or_default();
                    if !v.is_empty() {
                        dir = Some(v);
                    }
                }
                _ => {}
            },
            Ok(None) => break,
            Err(_) => return bad_request("expected multipart/form-data"),
        }
    }

    let mut added: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut accepted = 0usize;
    let mut total_bytes = 0usize;
    for (i, (name, bytes)) in files.iter().enumerate() {
        let rel = paths.get(i).cloned().unwrap_or_default();
        if accepted >= MAX_FILES {
            skipped.push(
                json!({ "name": name, "reason": format!("exceeds max of {MAX_FILES} files") }),
            );
            continue;
        }
        if bytes.len() > MAX_FILE_BYTES {
            skipped.push(json!({
                "name": name,
                "reason": format!("exceeds {}MB limit", MAX_FILE_BYTES / (1024 * 1024)),
            }));
            continue;
        }
        if total_bytes + bytes.len() > MAX_TOTAL_BYTES {
            skipped.push(json!({
                "name": name,
                "reason": format!("request exceeds {}MB total", MAX_TOTAL_BYTES / (1024 * 1024)),
            }));
            continue;
        }
        // Derive a sub-directory from the relative path; fall back to `dir`.
        let sub_dir = rel.rfind('/').map(|i| rel[..i].to_string());
        let target = sub_dir.or_else(|| dir.clone());
        match vault::add_file(name, bytes, target.as_deref()) {
            Ok(new_id) => {
                added.push(json!({ "newId": new_id }));
                accepted += 1;
                total_bytes += bytes.len();
            }
            Err(e) => {
                skipped.push(json!({ "name": name, "reason": err_message(&e, "upload failed") }));
            }
        }
    }
    Json(json!({ "added": added, "skipped": skipped })).into_response()
}

// --- /api/register ----------------------------------------------------------------

pub async fn register_get() -> Response {
    Json(json!({ "configured": license::is_supabase_configured() })).into_response()
}

pub async fn register_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let Some(body) = body.map(|Json(v)| v).filter(|b| b.is_object()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "reason": "rejected", "detail": "email required" })),
        )
            .into_response();
    };
    let email = body["email"].as_str().unwrap_or("").trim().to_string();
    if email.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "reason": "rejected", "detail": "email required" })),
        )
            .into_response();
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
    // start_trial resets usage consent; apply the user's explicit choice
    // afterwards so it wins — even when the mint fails (offline).
    if let Some(opt_out) = body["usageLoggingOptOut"].as_bool() {
        usage::set_usage_opt_out(opt_out);
    }
    match result {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => Json(json!({
            "ok": false,
            "reason": "rejected",
            "detail": err_message(&e, "registration failed"),
        }))
        .into_response(),
    }
}

// --- /api/settings ----------------------------------------------------------------

pub async fn settings_get() -> Response {
    let s = settings::read_desktop_settings();
    Json(json!({
        "desktop": is_desktop_app(),
        "runOnStartup": s.run_on_startup != Some(false), // default on
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode, // null until the first-run chooser is answered
        "whisperMode": s.whisper_mode == Some(true), // opt-in, default off
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        "semanticSearch": s.semantic_search != Some(false), // default on
        "backgroundConserve": s.background_conserve != Some(false), // default on
        "ocrEnabled": s.ocr_enabled != Some(false), // default on
    }))
    .into_response()
}

pub async fn settings_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    if !is_desktop_app() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "reason": "settings apply to the desktop app only" })),
        )
            .into_response();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let s = settings::write_desktop_settings(
        body["runOnStartup"].as_bool(),
        body["startupAsked"].as_bool(),
        body["uiMode"].as_str().map(String::from),
        body["whisperMode"].as_bool(),
        body["summonShortcut"].as_str().map(String::from),
        body["semanticSearch"].as_bool(),
        body["backgroundConserve"].as_bool(),
        body["ocrEnabled"].as_bool(),
    );
    Json(json!({
        "ok": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode,
        "whisperMode": s.whisper_mode == Some(true),
        "summonShortcut": s
            .summon_shortcut
            .as_deref()
            .unwrap_or(settings::DEFAULT_SUMMON_SHORTCUT),
        "semanticSearch": s.semantic_search != Some(false),
        "backgroundConserve": s.background_conserve != Some(false),
        "ocrEnabled": s.ocr_enabled != Some(false),
    }))
    .into_response()
}
