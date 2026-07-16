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
use lighthouse_core::{llm, local_model, profile, settings, sources, vault};

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

/// Wire cadence string → engine enum (unknown/absent = manual).
fn parse_cadence(s: Option<&str>) -> lighthouse_core::briefings::Cadence {
    use lighthouse_core::briefings::Cadence;
    match s {
        Some("daily") => Cadence::Daily,
        Some("weekly") => Cadence::Weekly,
        _ => Cadence::Manual,
    }
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
        // "Private — this device only": a per-node mark the engine enforces by
        // withholding the node from anything a cloud provider would receive.
        Some("localOnly") => {
            let (Some(node_id), Some(local_only)) =
                (body["nodeId"].as_str(), body["localOnly"].as_bool())
            else {
                return bad_request("nodeId and localOnly required");
            };
            sources::set_local_only(node_id, local_only).await;
            Json(json!({ "ok": true })).into_response()
        }
        // Bulk curation rules (openspec: add-curation-rules): a per-folder
        // predicate layer resolved live at walk time — never per-node writes.
        // `add` validates (predicate/action whitelists, glob parse) → 400 with
        // the reason; ids are minted engine-side. PARITY: commands.rs and the
        // TS twin (app/api/rag/route.ts) mirror this op exactly.
        Some("rules") => match body["action"].as_str() {
            Some("list") => {
                Json(json!({ "rules": sources::rules_listing().await })).into_response()
            }
            Some("add") => {
                let r = &body["rule"];
                let ext: Option<Vec<String>> = r["ext"].as_array().map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                });
                match sources::add_rule(
                    r["scope"].as_str().unwrap_or(""),
                    r["kind"].as_str(),
                    ext.as_deref(),
                    r["glob"].as_str(),
                    r["action"].as_str().unwrap_or(""),
                )
                .await
                {
                    Ok(rule) => Json(json!({ "rule": rule })).into_response(),
                    Err(e) => bad_request(&err_message(&e, "could not add the rule")),
                }
            }
            Some("remove") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                sources::remove_rule(id).await;
                Json(json!({ "ok": true })).into_response()
            }
            _ => bad_request("rules action must be list, add, or remove"),
        },
        // Investigations (openspec: add-investigations): named, durable
        // containers for analysis. CRUD on the vault-scoped STRUCTURE store —
        // ids are minted engine-side and validation failures → 400 with the
        // engine's reason, like rules. Conversation-ref writes are gated
        // engine-side: the client's persistAllowed verdict AND the managed
        // history policy must both allow (either false ⇒ silent no-op).
        // PARITY: commands.rs and the TS twin (app/api/rag/route.ts) mirror
        // this op exactly.
        Some("investigations") => match body["action"].as_str() {
            Some("list") => Json(json!({
                "investigations": lighthouse_core::investigations::listing()
            }))
            .into_response(),
            Some("create") => {
                let provider_policy = if body["providerPolicy"].is_null() {
                    lighthouse_core::investigations::ProviderPolicy::Default
                } else {
                    match body["providerPolicy"].as_str() {
                        Some("default") => lighthouse_core::investigations::ProviderPolicy::Default,
                        Some("local-only") => {
                            lighthouse_core::investigations::ProviderPolicy::LocalOnly
                        }
                        _ => {
                            return bad_request("providerPolicy must be \"default\" or \"local-only\"")
                        }
                    }
                };
                let scope = string_array(&body["scopeFileIds"]);
                match lighthouse_core::investigations::create(
                    body["name"].as_str().unwrap_or(""),
                    &scope,
                    provider_policy,
                ) {
                    Ok(inv) => Json(json!({
                        "investigation": lighthouse_core::investigations::view(inv)
                    }))
                    .into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                match lighthouse_core::investigations::rename(
                    id,
                    body["name"].as_str().unwrap_or(""),
                ) {
                    Ok(inv) => Json(json!({
                        "investigation": lighthouse_core::investigations::view(inv)
                    }))
                    .into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("setArchived") => {
                let (Some(id), Some(archived)) = (
                    body["id"].as_str().filter(|s| !s.is_empty()),
                    body["archived"].as_bool(),
                ) else {
                    return bad_request("id and archived required");
                };
                match lighthouse_core::investigations::set_archived(id, archived) {
                    Ok(inv) => Json(json!({
                        "investigation": lighthouse_core::investigations::view(inv)
                    }))
                    .into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("addConversationRef") => {
                let (Some(id), Some(conversation_id)) = (
                    body["id"].as_str().filter(|s| !s.is_empty()),
                    body["conversationId"].as_str().filter(|s| !s.is_empty()),
                ) else {
                    return bad_request("id and conversationId required");
                };
                // persistAllowed defaults false — an absent field fails
                // toward privacy, exactly like the ask path's cache controls.
                let persist_allowed = body["persistAllowed"].as_bool().unwrap_or(false);
                match lighthouse_core::investigations::add_conversation_ref(
                    id,
                    conversation_id,
                    persist_allowed,
                ) {
                    Ok(inv) => Json(json!({
                        "investigation": lighthouse_core::investigations::view(inv)
                    }))
                    .into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            _ => bad_request(
                "investigations action must be list, create, rename, setArchived, or addConversationRef",
            ),
        },
        // Boards (openspec: add-boards): pin-backed local dashboards. CRUD on
        // the vault-scoped boards store — engine-minted ids, per-scope name
        // validation, lazy virtual defaults that materialize on first
        // mutation — plus refreshCards, the model-free per-pin re-execution
        // through the SAME run_direct guard as pin rechecks (a manual board
        // refresh IS a recheck: the pin's stored digest/summary advance
        // identically). Validation failures → 400 with the engine's reason,
        // like investigations. PARITY: commands.rs mirrors this op exactly;
        // the TS twin answers refreshCards from stored pin state
        // (live: false — analytics is Rust-engine-only).
        Some("boards") => match body["action"].as_str() {
            Some("list") => {
                // Optional investigation filter — absent (or blank) is "all",
                // the listPins convention exactly.
                let investigation_id = body["investigationId"].as_str().filter(|s| !s.is_empty());
                Json(json!({ "boards": lighthouse_core::boards::list_for(investigation_id) }))
                    .into_response()
            }
            Some("create") => match lighthouse_core::boards::create(
                body["name"].as_str().unwrap_or(""),
                body["investigationId"].as_str(),
            ) {
                Ok(board) => Json(json!({ "board": board })).into_response(),
                Err(e) => bad_request(&e),
            },
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                match lighthouse_core::boards::rename(id, body["name"].as_str().unwrap_or("")) {
                    Ok(board) => Json(json!({ "board": board })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("delete") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                match lighthouse_core::boards::delete(id) {
                    Ok(()) => Json(json!({ "ok": true })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("setCards") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                let cards = match lighthouse_core::boards::parse_cards(&body["cards"]) {
                    Ok(cards) => cards,
                    Err(e) => return bad_request(&e),
                };
                match lighthouse_core::boards::set_cards(id, cards) {
                    Ok(board) => Json(json!({ "board": board })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("refreshCards") => {
                let pin_ids = string_array(&body["pinIds"]);
                Json(json!({
                    "cards": lighthouse_core::boards::refresh_cards(&pin_ids).await
                }))
                .into_response()
            }
            _ => bad_request(
                "boards action must be list, create, rename, delete, setCards, or refreshCards",
            ),
        },
        // Shaped views (openspec: add-shaped-views §3): CRUD on the views
        // store — engine-minted ids, save-time guard + reads/DAG validation,
        // dependent-aware lifecycle — plus `dependents`, the name lists the
        // rename/delete dialogs show. The wire carries the summary FLATTENED
        // (summaryText + summarySource); the ViewSummary is built here.
        // Validation failures → 400 with the engine's reason, like boards.
        // PARITY: commands.rs mirrors this op exactly; the TS twin's CRUD
        // runs for real against src/server/views.ts.
        Some("views") => match body["action"].as_str() {
            Some("list") => {
                Json(json!({ "views": lighthouse_core::views::list() })).into_response()
            }
            Some("create") => {
                let summary_source = if body["summarySource"].is_null() {
                    lighthouse_core::views::SummarySource::Question
                } else {
                    match body["summarySource"].as_str() {
                        Some("question") => lighthouse_core::views::SummarySource::Question,
                        Some("model") => lighthouse_core::views::SummarySource::Model,
                        _ => {
                            return bad_request(
                                "summarySource must be \"question\" or \"model\"",
                            )
                        }
                    }
                };
                let file_ids = string_array(&body["fileIds"]);
                match lighthouse_core::views::create(
                    body["name"].as_str().unwrap_or(""),
                    body["sql"].as_str().unwrap_or(""),
                    lighthouse_core::views::ViewSummary {
                        text: body["summaryText"].as_str().unwrap_or("").to_string(),
                        source: summary_source,
                    },
                    &file_ids,
                ) {
                    Ok(view) => Json(json!({ "view": view })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                match lighthouse_core::views::rename(id, body["name"].as_str().unwrap_or("")) {
                    Ok(view) => Json(json!({ "view": view })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("delete") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                let cascade = body["cascade"].as_bool().unwrap_or(false);
                match lighthouse_core::views::delete(id, cascade) {
                    Ok(deleted) => Json(json!({ "deletedIds": deleted })).into_response(),
                    Err(e) => bad_request(&e),
                }
            }
            Some("dependents") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                let names = |views: Vec<lighthouse_core::views::View>| -> Vec<String> {
                    views.into_iter().map(|v| v.name).collect()
                };
                Json(json!({
                    "dependents": names(lighthouse_core::views::dependents_of(id)),
                    "transitive": names(lighthouse_core::views::transitive_dependents(id)),
                }))
                .into_response()
            }
            // Inspector on a view (openspec: add-shaped-views §4): the exact
            // definition SQL, the provenance-labeled summary, the source files
            // it reads (transitive) with their saved-age freshness, the
            // effectively-local-only flag, and the dependent names the
            // rename/delete dialogs warn with. Pure stored-state read — no SQL
            // executes, so the TS twin returns the identical shape.
            Some("inspect") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return bad_request("id required");
                };
                Json(json!({ "inspection": lighthouse_core::inspect::inspect_view(id) }))
                    .into_response()
            }
            _ => bad_request(
                "views action must be list, create, rename, delete, dependents, or inspect",
            ),
        },
        // Shaping ask (openspec: add-shaped-views §3): ONE guarded completion
        // proposes a transform SELECT over a registered source; the engine
        // validates it and renders before/after sample evidence. NOTHING
        // persists here — creation happens only via op:"views" create on the
        // user's explicit Save. A local-only source forces the local model
        // path engine-side; an extractive/keyless provider answers
        // {available:false} with honest copy (the TS twin ALWAYS does —
        // PARITY: shaping runs the model + DataFusion, Rust-engine-only).
        Some("shapeView") => {
            let source = body["source"].as_str().unwrap_or("").to_string();
            let instruction = body["instruction"].as_str().unwrap_or("").to_string();
            let file_ids = string_array(&body["fileIds"]);
            return match lighthouse_core::views::shape_view(
                &source,
                &instruction,
                &file_ids,
                profile::model_config(),
            )
            .await
            {
                Ok(p) => Json(json!({
                    "proposal": {
                        "sql": p.sql,
                        "before": p.before,
                        "after": p.after,
                        "summary": p.summary,
                    }
                }))
                .into_response(),
                Err(e) if e == lighthouse_core::views::SHAPE_NEEDS_MODEL => {
                    Json(json!({ "available": false, "reason": e })).into_response()
                }
                Err(e) => bad_request(&e),
            };
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
            // Explorer search is a LOCAL preview (never sent to a provider), so
            // it runs the device path — local-only files stay searchable here.
            // No investigation context: search is global, no recall preference.
            let retrieved = sources::retrieve(query, &ids, &[], 5, false, &[]).await;
            Json(json!({ "references": retrieved.references })).into_response()
        }
        // Read-only per-file inspector ("What the AI sees", openspec:
        // add-file-inspector): what the engine extracted/chunked/catalogued/
        // indexed for one file, plus an optional file-scoped test-search. PURE
        // READ — no setter is reachable from this op.
        Some("inspect") => {
            let Some(file_id) = body["fileId"].as_str().filter(|s| !s.is_empty()) else {
                return bad_request("fileId required");
            };
            let inspection = sources::inspect(file_id, body["query"].as_str()).await;
            Json(inspection).into_response()
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
        // Write a client-composed artifact into the vault (openspec:
        // add-answer-artifacts). Default: the chat transcript as a markdown
        // note into Lighthouse Notes/. Optional subdir/ext route the analytics
        // evidence pack (self-contained HTML into Lighthouse Results/) through
        // the SAME sanitized write_artifact path — STRICT allowlist, the
        // client never names arbitrary folders or extensions. Ordinary vault
        // file: walked, watched, inclusion-ruled. PARITY: commands.rs and the
        // TS twin (app/api/rag/route.ts) mirror this op exactly.
        Some("exportChat") => {
            let title = body["title"].as_str().unwrap_or("Chat").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if markdown.trim().is_empty() {
                return bad_request("markdown required");
            }
            // Absent field = the original default; anything present must
            // match the allowlist EXACTLY (a null/number rejects too).
            let subdir = match body.get("subdir").map(|v| v.as_str()) {
                None => "Lighthouse Notes",
                Some(Some("Lighthouse Notes")) => "Lighthouse Notes",
                Some(Some("Lighthouse Results")) => "Lighthouse Results",
                Some(_) => {
                    return bad_request(
                        "subdir must be \"Lighthouse Notes\" or \"Lighthouse Results\"",
                    )
                }
            }
            .to_string();
            let ext = match body.get("ext").map(|v| v.as_str()) {
                None => "md",
                Some(Some("md")) => "md",
                Some(Some("html")) => "html",
                Some(_) => return bad_request("ext must be \"md\" or \"html\""),
            }
            .to_string();
            // Investigation notes (openspec: add-investigations §3): a
            // non-empty investigationId routes the NOTES destination to the
            // investigation's own folder — resolved ENGINE-SIDE from the
            // store (`Lighthouse Notes/<stored folderName>`, re-validated at
            // use); a client-sent folder is never trusted and the subdir
            // allowlist above is unchanged. An explicit "Lighthouse Results"
            // (the evidence pack) stays in Results — packs are results, not
            // notes, and note membership = location. An unknown id rejects:
            // a silently-global note would lose its membership. Parsed like
            // the ask wire's investigationId (non-string reads as absent).
            let subdir = match body["investigationId"].as_str().map(str::trim) {
                Some(id) if !id.is_empty() && subdir == "Lighthouse Notes" => {
                    match lighthouse_core::investigations::notes_subdir(id) {
                        Ok(sub) => sub,
                        Err(e) => return bad_request(&e),
                    }
                }
                _ => subdir,
            };
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::write_artifact(&subdir, &title, &ext, markdown.as_bytes())
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
        // --- G6 cross-conversation recall: auto-export a chat as an indexed
        //     vault note (`Lighthouse Notes/Chats/`), OVERWRITTEN in place per
        //     conversation id so the vault keeps one current note per chat. The
        //     client gates this on "Save chats on this device". ---
        Some("exportConversationNote") => {
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let title = body["title"].as_str().unwrap_or("Conversation").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if conversation_id.trim().is_empty() || markdown.trim().is_empty() {
                return bad_request("conversationId and markdown required");
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
            return match written {
                Ok((id, name)) => {
                    Json(json!({ "savedId": id, "savedName": name })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        // G6 fail-closed opt-out: delete every auto-exported chat note.
        Some("purgeConversationNotes") => {
            let purged = tokio::task::spawn_blocking(lighthouse_core::vault::purge_conversation_notes)
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()));
            return match purged {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
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
            // The current investigation, when one is (openspec:
            // add-investigations) — the pin carries it as its membership.
            let investigation_id = body["investigationId"].as_str();
            return match lighthouse_core::pins::add(&question, &sql, &file_ids, investigation_id)
            {
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
            // Optional investigation filter (openspec: add-investigations);
            // absent (or blank) keeps the original "all pins" behavior.
            let investigation_id = body["investigationId"].as_str().filter(|s| !s.is_empty());
            return Json(json!({ "pins": lighthouse_core::pins::list_for(investigation_id) }))
                .into_response();
        }
        Some("recheckPins") => {
            let changed = lighthouse_core::pins::recheck_all().await;
            return Json(json!({
                "changed": changed,
                "pins": lighthouse_core::pins::list(),
            }))
            .into_response();
        }
        // G5 briefing note: recheck to freshen each pin's summary, then compose
        // the deterministic (model-free) note from a SNAPSHOT of every pin that
        // has a summary (matching the web twin) and overwrite Lighthouse
        // Notes/Lighthouse Briefing.md in place — so a manual refresh never blanks
        // the note just because nothing changed. No OS notification and NO daily-
        // gate stamp on this explicit, in-dialog path. (PARITY: the desktop shell's
        // scheduled daily-delta write lives in main.rs.)
        Some("refreshBriefingNote") => {
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
            return match written {
                Ok((id, name)) => {
                    Json(json!({ "savedId": id, "savedName": name })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        Some("listBriefings") => {
            return Json(json!({ "briefings": lighthouse_core::briefings::list() }))
                .into_response();
        }
        Some("saveBriefing") => {
            let title = body["title"].as_str().unwrap_or("").to_string();
            let pin_ids: Vec<String> = body["pinIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cadence = parse_cadence(body["cadence"].as_str());
            return match lighthouse_core::briefings::add(&title, &pin_ids, cadence) {
                Ok(briefing) => Json(json!({ "briefing": briefing })).into_response(),
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
        Some("removeBriefing") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return bad_request("id required");
            };
            lighthouse_core::briefings::remove(id);
            return Json(json!({ "ok": true })).into_response();
        }
        Some("runBriefing") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return bad_request("id required");
            };
            let report = lighthouse_core::briefings::run(id).await;
            return Json(json!({ "report": report })).into_response();
        }
        // Catalog-derived example questions for the chat empty state — every
        // one names real columns of a real included file, so the analytics
        // path can answer it. Empty when nothing tabular is included.
        Some("suggestedAsks") => {
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            // Suggested-ask chips name real columns of real included files. Under
            // a cloud provider, resolve against the shareable set so a marked
            // file's columns never surface as a chip. Cloud-ness = the same
            // provider identity the chat pipeline uses.
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            // Saved views join the suggestions when any exist (openspec:
            // add-shaped-views §4): the resolving entry point derives view chips
            // from resolved result columns and stays byte-identical to the
            // file-only path when the store is empty.
            let asks = lighthouse_core::meta::suggested_asks_resolved(ids, is_cloud).await;
            return Json(json!({ "asks": asks })).into_response();
        }
        // Recipes applicable to the included set (openspec: add-recipes §2.3) —
        // the Library gallery / empty-state chips. Same posture/cloud-ness rule
        // as suggestedAsks: cards resolve against the shareable set, so a marked
        // file (or an effectively-local-only view) never surfaces a recipe on a
        // cloud ask. Execution rides the ask path via the `run-recipe:{id} on
        // {table}` cue, not a JSON op. PARITY: the TS twin returns [] (no
        // catalog/DataFusion) and answers {available:false} on op:"recipes".
        Some("applicableRecipes") => {
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let recipes = lighthouse_core::meta::applicable_recipes(ids, is_cloud).await;
            return Json(json!({ "recipes": recipes })).into_response();
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
        // Provider sign-in (0.12.1 §3): a generic RFC 8628 device-
        // authorization client that stays INERT until a maintainer registers
        // with a vendor and configures all four LIGHTHOUSE_SIGNIN_* values
        // (provider_auth.rs) — unconfigured, every action answers
        // {available:false} and no host is dialed. Flow errors ride back as
        // 200 + {error} (the pinAsk idiom) so the dialog resets with the
        // reason instead of throwing. setMethod persists the auth-method
        // choice ("key" restores the default and always works; "signin" is
        // registration-gated like the flow it arms). PARITY: commands.rs
        // mirrors this op exactly; the TS twin answers a fail-closed stub
        // (sign-in runs in the desktop app).
        Some("providerAuth") => match body["action"].as_str() {
            Some("status") => {
                Json(lighthouse_core::provider_auth::status_payload()).into_response()
            }
            Some("setMethod") => match body["method"].as_str() {
                Some("key") => {
                    lighthouse_core::settings::set_openai_auth_method("key");
                    Json(json!({ "ok": true, "method": "key" })).into_response()
                }
                Some("signin") => {
                    if lighthouse_core::provider_auth::signin_config().is_none() {
                        Json(json!({
                            "available": false,
                            "reason": lighthouse_core::provider_auth::UNCONFIGURED_REASON,
                        }))
                        .into_response()
                    } else {
                        lighthouse_core::settings::set_openai_auth_method("signin");
                        Json(json!({ "ok": true, "method": "signin" })).into_response()
                    }
                }
                _ => bad_request("method must be \"key\" or \"signin\""),
            },
            Some("start") => match lighthouse_core::provider_auth::start().await {
                Ok(flow) => Json(json!({
                    "userCode": flow.user_code,
                    "verificationUri": flow.verification_uri,
                    "intervalMs": flow.interval_ms,
                    "expiresInMs": flow.expires_in_ms,
                }))
                .into_response(),
                Err(e) if e == lighthouse_core::provider_auth::UNCONFIGURED_REASON => {
                    Json(json!({ "available": false, "reason": e })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            },
            Some("poll") => match lighthouse_core::provider_auth::poll_once().await {
                Ok(lighthouse_core::provider_auth::Poll::Pending { interval_ms }) => {
                    Json(json!({ "status": "pending", "intervalMs": interval_ms }))
                        .into_response()
                }
                Ok(lighthouse_core::provider_auth::Poll::Complete { account }) => {
                    let mut out = json!({ "status": "complete" });
                    if let Some(a) = account {
                        out["accountHint"] = json!(a);
                    }
                    Json(out).into_response()
                }
                Ok(lighthouse_core::provider_auth::Poll::Idle) => {
                    Json(json!({ "status": "idle" })).into_response()
                }
                Err(e) if e == lighthouse_core::provider_auth::UNCONFIGURED_REASON => {
                    Json(json!({ "available": false, "reason": e })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            },
            Some("signout") => {
                // Dropping sealed tokens is local-only and always safe, so it
                // runs regardless; the ANSWER stays fail-closed unconfigured.
                lighthouse_core::provider_auth::signout();
                if lighthouse_core::provider_auth::signin_config().is_none() {
                    Json(json!({
                        "available": false,
                        "reason": lighthouse_core::provider_auth::UNCONFIGURED_REASON,
                    }))
                    .into_response()
                } else {
                    Json(json!({ "ok": true })).into_response()
                }
            }
            _ => bad_request(
                "providerAuth action must be status, setMethod, start, poll, or signout",
            ),
        },
        // Managed policy snapshot (openspec: add-managed-policy) — read-only;
        // the UI renders the reported locks as "Managed by your organization".
        Some("policy") => Json(lighthouse_core::policy::snapshot()).into_response(),
        // Session egress snapshot (S3) — what has left this machine this
        // session; the header shield renders "All local" / "N to <host>".
        Some("egress") => Json(lighthouse_core::egress::snapshot()).into_response(),
        // Local audit log (openspec: add-audit-log) — the durable record the
        // session egress panel is a live window onto. List/verify are read-only;
        // export writes a CSV into the vault via the same sanitized helper as
        // exportChat, returning its id.
        Some("auditList") => {
            let limit = body["limit"].as_u64().unwrap_or(100) as usize;
            return Json(lighthouse_core::audit::recent(limit)).into_response();
        }
        Some("auditVerify") => {
            return Json(lighthouse_core::audit::verify_active()).into_response();
        }
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
            return match written {
                Ok((id, name)) => {
                    Json(json!({ "savedId": id, "savedName": name })).into_response()
                }
                Err(e) => Json(json!({ "error": e })).into_response(),
            };
        }
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
    // The investigation this ask runs inside (openspec: add-investigations);
    // absent = the global context. Resolved below, beside model_config().
    let investigation_id = body["investigationId"].as_str().map(String::from);
    // Answer cache controls (openspec: add-answer-cache): Re-run's lookup
    // bypass, and the client's per-request persistence verdict. Both default
    // false — an absent field fails toward privacy (memory-only cache).
    let cache = lighthouse_core::answer_cache::CacheCtl {
        bypass_cache: body["bypassCache"].as_bool().unwrap_or(false),
        persist_allowed: body["persistAllowed"].as_bool().unwrap_or(false),
    };
    // Two-phase plan approval (openspec: add-beam-loop §4): the Phase-1 preview
    // flag and the Phase-2 approved SQL, both optional and mirroring the cache
    // controls above. Absent = an ordinary ask. PARITY: commands.rs chat_ask.
    let plan = lighthouse_core::beam::PlanCtl {
        plan_only: body["planOnly"].as_bool().unwrap_or(false),
        approved_plan: body["approvedPlan"].as_str().map(String::from),
    };
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

    // Investigation scope + provider policy resolve HERE — the same
    // chokepoint where the profile's model config is consulted (and beneath
    // which the managed policy's llm-time belt sits), so a local-only
    // investigation swaps cfg before any transport exists and scope arrives
    // as ordinary attachments (openspec: add-investigations). The third
    // element is the investigation's conversationRefs — retrieval's recall
    // preference (§3); empty when no investigation rides the ask.
    let (attachment_ids, cfg, preferred_conversation_ids) =
        lighthouse_core::investigations::resolve_ask_context(
            investigation_id.as_deref(),
            attachment_ids,
            profile::model_config(),
        );

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
    // Audit log (add-audit-log): the transport choke point — capture the
    // question + egress baseline before the answer, record when the final
    // chunk's references land.
    let audit = lighthouse_core::audit::AnswerAudit::start(&question);
    let provider = cfg
        .provider_id
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let stream = async_stream::stream! {
        let mut chunks = lighthouse_core::synth::answer_pipeline(
            question,
            included_file_ids,
            attachment_ids,
            history,
            cfg,
            cache,
            plan,
            preferred_conversation_ids,
        );
        let mut final_files: Vec<String> = Vec::new();
        let mut artifacts: Vec<String> = Vec::new();
        // The NEW cost this ask incurred (openspec: add-beam-loop §3.2), read
        // from the final chunk's meter; a cache replay computes nothing (0 new).
        let mut answer_cost: Option<lighthouse_core::contracts::CostMeta> = None;
        while let Some(c) = chunks.next().await {
            if c.done {
                if let Some(refs) = &c.references {
                    final_files = refs.iter().map(|r| r.file_id.clone()).collect();
                }
                if let Some(a) = &c.analytics {
                    artifacts.extend(a.file_ids.iter().cloned());
                }
                if let Some(meta) = &c.meta {
                    answer_cost = lighthouse_core::audit::ask_new_cost(meta);
                }
            }
            yield Ok::<bytes::Bytes, std::convert::Infallible>(line(&c));
        }
        audit.finish(&provider, final_files, artifacts, answer_cost);
    };

    Response::builder()
        .header("content-type", "application/x-ndjson; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// --- /api/profile -------------------------------------------------------------

pub async fn profile_get() -> Response {
    Json(profile::get_state()).into_response()
}

pub async fn profile_post(headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !is_same_origin(&headers) {
        return forbidden();
    }
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    match body["op"].as_str() {
        Some("finishVault") => profile::finish_vault(),
        Some("finishMode") => profile::finish_mode(),
        Some("selectModel") => {
            let provider_id = body["providerId"].as_str().unwrap_or("");
            // Managed policy: reject a disallowed provider with a real error
            // (select_model itself also refuses to persist, belt-and-braces).
            if !lighthouse_core::policy::provider_allowed(provider_id) {
                return bad_request("this AI provider is managed off by your organization");
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

// --- /api/diagnostics ---------------------------------------------------------

/// Diagnostics for the "Send feedback" dialog. The headless/web build has no
/// desktop shell.log, so the excerpt is always empty; version + OS mirror what
/// the dialog shows. Read-only — the app transmits nothing of its own.
pub async fn diagnostics_get() -> Response {
    Json(json!({
        "version": lighthouse_core::config::app_version(),
        "os": std::env::consts::OS,
        "log": "",
    }))
    .into_response()
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

// PARITY divergence (G2 GPU status): the desktop `model_status` command merges
// the shell's real llama-server GPU launch state (gpuOn/gpuLayers/gpuRunning)
// from the Supervisor. The web/dev server has no supervisor, so those fields are
// absent here — the UI treats a missing `gpuOn` as "unknown" and renders nothing.
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
        "auditEnabled": s.audit_enabled == Some(true), // opt-in, default off
        "draftAnswers": s.draft_answers != Some(false), // default on
        "briefingNotify": s.briefing_notify != Some(false), // default on (G5)
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9), // default 9am (G5)
        "tourShown": s.tour_shown == Some(true), // first-run tour, once per install
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
        body["auditEnabled"].as_bool(),
        body["draftAnswers"].as_bool(),
        body["briefingNotify"].as_bool(),
        body["briefingNoteHour"].as_i64(),
        body["tourShown"].as_bool(),
        body["beamMaxSteps"].as_i64(),
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
        "draftAnswers": s.draft_answers != Some(false),
        "briefingNotify": s.briefing_notify != Some(false),
        "briefingNoteHour": s.briefing_note_hour.unwrap_or(9),
        "tourShown": s.tour_shown == Some(true),
    }))
    .into_response()
}
