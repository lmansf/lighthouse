//! IPC command surface (Phase 4): the same operations the 13 HTTP routes
//! expose, carried over Tauri's invoke/Channel transport instead of a local
//! TCP port. The webview is the only caller and commands run in-process, so
//! the loopback/Origin/token auth layer has no equivalent here — there is no
//! port to defend.

use futures::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use lighthouse_core::contracts::{ChatChunk, ChatTurn, CostMeta};
use lighthouse_core::{local_model, profile, settings, sources, vault};

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
    // `desktop: true` = "embedded shell" (compat; the engine and existing UI
    // read it on iOS too). `platform` is the form-factor signal (§1).
    json!({
        "sources": sources_list,
        "nodes": nodes,
        "desktop": true,
        "platform": crate::platform_kind(),
    })
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
        // "Private — this device only" mark (openspec: add-local-only-marks).
        Some("localOnly") => {
            let (Some(node_id), Some(local_only)) =
                (body["nodeId"].as_str(), body["localOnly"].as_bool())
            else {
                return Err("nodeId and localOnly required".into());
            };
            sources::set_local_only(node_id, local_only).await;
            // Like a visibility flip, a mark doesn't touch vault files — broadcast
            // so other windows re-render the lock immediately.
            let _ = app.emit("vault-changed", ());
            Ok(json!({ "ok": true }))
        }
        // Bulk curation rules (openspec: add-curation-rules) — mirrors the
        // routes.rs op exactly. Rule writes change effective visibility
        // without touching vault files, so add/remove broadcast like a flag
        // flip; `list` is a pure read.
        Some("rules") => match body["action"].as_str() {
            Some("list") => Ok(json!({ "rules": sources::rules_listing().await })),
            Some("add") => {
                let r = &body["rule"];
                let ext: Option<Vec<String>> = r["ext"].as_array().map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                });
                let rule = sources::add_rule(
                    r["scope"].as_str().unwrap_or(""),
                    r["kind"].as_str(),
                    ext.as_deref(),
                    r["glob"].as_str(),
                    r["action"].as_str().unwrap_or(""),
                )
                .await
                .map_err(|e| err_string(e, "could not add the rule"))?;
                let _ = app.emit("vault-changed", ());
                Ok(json!({ "rule": rule }))
            }
            Some("remove") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                sources::remove_rule(id).await;
                let _ = app.emit("vault-changed", ());
                Ok(json!({ "ok": true }))
            }
            _ => Err("rules action must be list, add, or remove".into()),
        },
        // Investigations (openspec: add-investigations) — mirrors the
        // routes.rs op exactly: STRUCTURE CRUD, engine-minted ids, validation
        // failures as the engine's reason. Conversation-ref writes are gated
        // engine-side (persistAllowed AND managed history policy — either
        // false ⇒ silent no-op). Investigations never touch vault files or
        // the tree, so there is NO vault-changed broadcast (unlike rules,
        // which change effective visibility).
        Some("investigations") => match body["action"].as_str() {
            Some("list") => Ok(json!({
                "investigations": lighthouse_core::investigations::listing()
            })),
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
                            return Err("providerPolicy must be \"default\" or \"local-only\"".into())
                        }
                    }
                };
                let scope = string_array(&body["scopeFileIds"]);
                let inv = lighthouse_core::investigations::create(
                    body["name"].as_str().unwrap_or(""),
                    &scope,
                    provider_policy,
                )?;
                Ok(json!({ "investigation": lighthouse_core::investigations::view(inv) }))
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let inv = lighthouse_core::investigations::rename(
                    id,
                    body["name"].as_str().unwrap_or(""),
                )?;
                Ok(json!({ "investigation": lighthouse_core::investigations::view(inv) }))
            }
            Some("setArchived") => {
                let (Some(id), Some(archived)) = (
                    body["id"].as_str().filter(|s| !s.is_empty()),
                    body["archived"].as_bool(),
                ) else {
                    return Err("id and archived required".into());
                };
                let inv = lighthouse_core::investigations::set_archived(id, archived)?;
                Ok(json!({ "investigation": lighthouse_core::investigations::view(inv) }))
            }
            Some("addConversationRef") => {
                let (Some(id), Some(conversation_id)) = (
                    body["id"].as_str().filter(|s| !s.is_empty()),
                    body["conversationId"].as_str().filter(|s| !s.is_empty()),
                ) else {
                    return Err("id and conversationId required".into());
                };
                // persistAllowed defaults false — an absent field fails
                // toward privacy, exactly like the ask path's cache controls.
                let persist_allowed = body["persistAllowed"].as_bool().unwrap_or(false);
                let inv = lighthouse_core::investigations::add_conversation_ref(
                    id,
                    conversation_id,
                    persist_allowed,
                )?;
                Ok(json!({ "investigation": lighthouse_core::investigations::view(inv) }))
            }
            // Fork a line of inquiry (openspec: add-automation §4) — mirrors
            // the routes.rs arm: a fresh record copying STRUCTURE only (scope,
            // policy, conversation refs), engine-minted id, its own empty
            // notes folder, same name rule as create.
            Some("fork") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let inv = lighthouse_core::investigations::fork(
                    id,
                    body["name"].as_str().unwrap_or(""),
                )?;
                Ok(json!({ "investigation": lighthouse_core::investigations::view(inv) }))
            }
            // Export to an in-vault markdown note (openspec: add-automation §4):
            // render structure + derived membership (references, never
            // transcripts), then WRITE under the investigation's own notes
            // folder via the exportChat precedent (notes_subdir +
            // write_artifact — a non-egress, sanitized in-vault write). Titles
            // is None: the op renders conversation ids.
            Some("export") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let title = body["title"].as_str().unwrap_or("Investigation").to_string();
                let markdown = lighthouse_core::investigations::export_markdown(id, None)?;
                let subdir = lighthouse_core::investigations::notes_subdir(id)?;
                let written = tokio::task::spawn_blocking(move || {
                    lighthouse_core::vault::write_artifact(
                        &subdir,
                        &title,
                        "md",
                        markdown.as_bytes(),
                    )
                })
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()));
                Ok(match written {
                    Ok((sid, name)) => {
                        let _ = app.emit("vault-changed", ());
                        json!({ "savedId": sid, "savedName": name })
                    }
                    Err(e) => json!({ "error": e }),
                })
            }
            _ => Err(
                "investigations action must be list, create, rename, setArchived, addConversationRef, fork, or export"
                    .into(),
            ),
        },
        // Boards (openspec: add-boards) — mirrors the routes.rs op exactly:
        // store CRUD (engine-minted ids, per-scope name validation, lazy
        // virtual defaults) plus refreshCards, the model-free per-pin
        // re-execution through the SAME run_direct guard as pin rechecks (a
        // manual board refresh IS a recheck). Boards never touch vault files
        // or the tree, so there is NO vault-changed broadcast (like
        // investigations); refresh freshness reaches the UI in the response
        // itself, and watcher-driven changes keep riding the existing
        // pins-changed relay — no new event channel.
        Some("boards") => match body["action"].as_str() {
            Some("list") => {
                // Optional investigation filter — absent (or blank) is "all",
                // the listPins convention exactly.
                let investigation_id = body["investigationId"].as_str().filter(|s| !s.is_empty());
                Ok(json!({ "boards": lighthouse_core::boards::list_for(investigation_id) }))
            }
            Some("create") => {
                let board = lighthouse_core::boards::create(
                    body["name"].as_str().unwrap_or(""),
                    body["investigationId"].as_str(),
                )?;
                Ok(json!({ "board": board }))
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let board =
                    lighthouse_core::boards::rename(id, body["name"].as_str().unwrap_or(""))?;
                Ok(json!({ "board": board }))
            }
            Some("delete") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                lighthouse_core::boards::delete(id)?;
                Ok(json!({ "ok": true }))
            }
            Some("setCards") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let cards = lighthouse_core::boards::parse_cards(&body["cards"])?;
                let board = lighthouse_core::boards::set_cards(id, cards)?;
                Ok(json!({ "board": board }))
            }
            Some("refreshCards") => {
                let pin_ids = string_array(&body["pinIds"]);
                Ok(json!({ "cards": lighthouse_core::boards::refresh_cards(&pin_ids).await }))
            }
            _ => Err(
                "boards action must be list, create, rename, delete, setCards, or refreshCards"
                    .into(),
            ),
        },
        // Shaped views (openspec: add-shaped-views §3) — mirrors the routes.rs
        // op exactly: store CRUD (engine-minted ids, save-time guard +
        // reads/DAG validation, dependent-aware lifecycle) plus `dependents`,
        // the name lists the rename/delete dialogs show. The wire carries the
        // summary FLATTENED (summaryText + summarySource); the ViewSummary is
        // built here. Views never touch vault files or the tree, so there is
        // NO vault-changed broadcast (like boards/investigations).
        Some("views") => match body["action"].as_str() {
            Some("list") => Ok(json!({ "views": lighthouse_core::views::list() })),
            Some("create") => {
                let summary_source = if body["summarySource"].is_null() {
                    lighthouse_core::views::SummarySource::Question
                } else {
                    match body["summarySource"].as_str() {
                        Some("question") => lighthouse_core::views::SummarySource::Question,
                        Some("model") => lighthouse_core::views::SummarySource::Model,
                        _ => return Err("summarySource must be \"question\" or \"model\"".into()),
                    }
                };
                let file_ids = string_array(&body["fileIds"]);
                let view = lighthouse_core::views::create(
                    body["name"].as_str().unwrap_or(""),
                    body["sql"].as_str().unwrap_or(""),
                    lighthouse_core::views::ViewSummary {
                        text: body["summaryText"].as_str().unwrap_or("").to_string(),
                        source: summary_source,
                    },
                    &file_ids,
                )?;
                Ok(json!({ "view": view }))
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let view =
                    lighthouse_core::views::rename(id, body["name"].as_str().unwrap_or(""))?;
                Ok(json!({ "view": view }))
            }
            Some("delete") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let cascade = body["cascade"].as_bool().unwrap_or(false);
                let deleted = lighthouse_core::views::delete(id, cascade)?;
                Ok(json!({ "deletedIds": deleted }))
            }
            Some("dependents") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let names = |views: Vec<lighthouse_core::views::View>| -> Vec<String> {
                    views.into_iter().map(|v| v.name).collect()
                };
                Ok(json!({
                    "dependents": names(lighthouse_core::views::dependents_of(id)),
                    "transitive": names(lighthouse_core::views::transitive_dependents(id)),
                }))
            }
            // Inspector on a view (openspec: add-shaped-views §4) — mirrors the
            // routes.rs arm: definition SQL, provenance-labeled summary,
            // transitive source files with saved-age freshness, local-only flag,
            // and dependent names. Pure stored-state read.
            Some("inspect") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                Ok(json!({ "inspection": lighthouse_core::inspect::inspect_view(id) }))
            }
            _ => Err(
                "views action must be list, create, rename, delete, dependents, or inspect".into(),
            ),
        },
        // Shaping ask (openspec: add-shaped-views §3) — mirrors the routes.rs
        // op exactly: ONE guarded completion proposes a transform SELECT; the
        // engine validates it and renders before/after sample evidence.
        // NOTHING persists here — creation happens only via op:"views" create
        // on the user's explicit Save. A local-only source forces the local
        // model path engine-side; an extractive/keyless provider answers
        // {available:false} with honest copy.
        Some("shapeView") => {
            let source = body["source"].as_str().unwrap_or("").to_string();
            let instruction = body["instruction"].as_str().unwrap_or("").to_string();
            let file_ids = string_array(&body["fileIds"]);
            match lighthouse_core::views::shape_view(
                &source,
                &instruction,
                &file_ids,
                profile::model_config(),
            )
            .await
            {
                Ok(p) => Ok(json!({
                    "proposal": {
                        "sql": p.sql,
                        "before": p.before,
                        "after": p.after,
                        "summary": p.summary,
                    }
                })),
                Err(e) if e == lighthouse_core::views::SHAPE_NEEDS_MODEL => {
                    Ok(json!({ "available": false, "reason": e }))
                }
                Err(e) => Err(e),
            }
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
            // Local search preview — device path, so local-only stays searchable.
            // No investigation context: search is global, no recall preference.
            let retrieved = sources::retrieve(query, &ids, &[], 5, false, &[]).await;
            Ok(json!({ "references": retrieved.references }))
        }
        // Read-only per-file inspector ("What the AI sees", openspec:
        // add-file-inspector): what the engine extracted/chunked/catalogued/
        // indexed for one file, plus an optional file-scoped test-search. PURE
        // READ — surfaces state, never a setter; no vault-changed broadcast.
        Some("inspect") => {
            let Some(file_id) = body["fileId"].as_str().filter(|s| !s.is_empty()) else {
                return Err("fileId required".into());
            };
            let inspection = sources::inspect(file_id, body["query"].as_str()).await;
            Ok(serde_json::to_value(inspection).unwrap_or_else(|_| json!({})))
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
        // Write a client-composed artifact into the vault (openspec:
        // add-answer-artifacts). Default: the chat transcript as a markdown
        // note into Lighthouse Notes/. Optional subdir/ext route the analytics
        // evidence pack (self-contained HTML into Lighthouse Results/) through
        // the SAME sanitized write_artifact path — STRICT allowlist, the
        // client never names arbitrary folders or extensions. Ordinary vault
        // file: walked, watched, inclusion-ruled. PARITY: routes.rs and the
        // TS twin (app/api/rag/route.ts) mirror this op exactly.
        Some("exportChat") => {
            let title = body["title"].as_str().unwrap_or("Chat").to_string();
            let markdown = body["markdown"].as_str().unwrap_or("").to_string();
            if markdown.trim().is_empty() {
                return Err("markdown required".into());
            }
            // Absent field = the original default; anything present must
            // match the allowlist EXACTLY (a null/number rejects too).
            let subdir = match body.get("subdir").map(|v| v.as_str()) {
                None => "Lighthouse Notes",
                Some(Some("Lighthouse Notes")) => "Lighthouse Notes",
                Some(Some("Lighthouse Results")) => "Lighthouse Results",
                Some(_) => {
                    return Err(
                        "subdir must be \"Lighthouse Notes\" or \"Lighthouse Results\"".into(),
                    )
                }
            }
            .to_string();
            let ext = match body.get("ext").map(|v| v.as_str()) {
                None => "md",
                Some(Some("md")) => "md",
                Some(Some("html")) => "html",
                Some(_) => return Err("ext must be \"md\" or \"html\"".into()),
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
                    lighthouse_core::investigations::notes_subdir(id)?
                }
                _ => subdir,
            };
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::vault::write_artifact(&subdir, &title, &ext, markdown.as_bytes())
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
            // The current investigation, when one is (openspec:
            // add-investigations) — the pin carries it as its membership.
            let investigation_id = body["investigationId"].as_str();
            Ok(match lighthouse_core::pins::add(&question, &sql, &file_ids, investigation_id) {
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
        Some("listPins") => {
            // Optional investigation filter (openspec: add-investigations);
            // absent (or blank) keeps the original "all pins" behavior.
            let investigation_id = body["investigationId"].as_str().filter(|s| !s.is_empty());
            Ok(json!({ "pins": lighthouse_core::pins::list_for(investigation_id) }))
        }
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
            // Under a cloud provider, resolve chips against the shareable set so
            // a marked file's columns never surface as a suggestion.
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            // Saved views join the suggestions when any exist (openspec:
            // add-shaped-views §4); byte-identical to the file-only path when
            // the store is empty.
            let asks = lighthouse_core::meta::suggested_asks_resolved(ids, is_cloud).await;
            Ok(json!({ "asks": asks }))
        }
        // Recipes applicable to the included set (openspec: add-recipes §2.3) —
        // the Library gallery / empty-state chips. Same shareable/posture rule as
        // suggestedAsks. Execution rides the ask path via the `run-recipe:{id} on
        // {table}` cue, not a JSON op. Mirrors the routes.rs op exactly.
        Some("applicableRecipes") => {
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let recipes = lighthouse_core::meta::applicable_recipes(ids, is_cloud).await;
            Ok(json!({ "recipes": recipes }))
        }
        // Proactive insights (openspec: add-quant-depth §5) — mirrors the
        // routes.rs arm: run the cheap detectors over the included tabular files
        // WITHOUT a question and return the ranked, bounded findings + counts.
        // On-device (DataFusion SQL, no model) — a scan egresses nothing.
        Some("insights") => {
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let files: Vec<(String, String, std::path::PathBuf)> =
                lighthouse_core::vault::active_included_file_ids()
                    .into_iter()
                    .filter_map(|id| {
                        lighthouse_core::vault::doc_path(&id).map(|(name, abs)| (id, name, abs))
                    })
                    .filter(|(_, name, _)| lighthouse_core::analytics::is_tabular(name))
                    .collect();
            let out = lighthouse_core::insights::scan(&files, is_cloud).await;
            Ok(json!({ "insights": out }))
        }
        // Deep analysis (openspec: add-deep-analysis §4.1) — mirrors the routes.rs
        // arm: investigate a table (the applicable recipe battery) and WRITE the
        // assembled report in-vault (render → write_artifact, a non-egress
        // sanitized note), returning the saved id + name. The included TABULAR
        // files are gathered server-side (active-included, the insights precedent).
        // On-device (DataFusion + recipes); emits vault-changed so the tree
        // refreshes. Mirrors the routes.rs arm exactly.
        Some("investigate") => {
            let Some(table) = body["table"].as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                return Err("investigate needs a table".into());
            };
            let table = table.to_string();
            let investigation_id = body["investigationId"].as_str().map(String::from);
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let files: Vec<(String, String, std::path::PathBuf)> =
                lighthouse_core::vault::active_included_file_ids()
                    .into_iter()
                    .filter_map(|id| {
                        lighthouse_core::vault::doc_path(&id).map(|(name, abs)| (id, name, abs))
                    })
                    .filter(|(_, name, _)| lighthouse_core::analytics::is_tabular(name))
                    .collect();
            let report = lighthouse_core::reports::investigate(&table, &files, is_cloud).await;
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::reports::write_report(&report, investigation_id.as_deref())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            Ok(match written {
                Ok((sid, name)) => {
                    let _ = app.emit("vault-changed", ());
                    json!({ "savedId": sid, "savedName": name })
                }
                Err(e) => json!({ "error": e }),
            })
        }
        // The capability map (openspec: add-deep-analysis §4.2) — mirrors the
        // routes.rs arm: aggregate the analyzable tables + their recipes/metrics/
        // asks + one investigation per Date+Numeric table for the included set.
        // Pure aggregation of the posture-gated applicable_* surfaces.
        Some("capabilityMap") => {
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let map = lighthouse_core::meta::capability_map(ids, is_cloud).await;
            Ok(json!({ "map": map }))
        }
        // Semantic layer (openspec: add-semantic-layer §6.1) — mirrors the
        // routes.rs arm exactly: `list` returns the posture-eligible definitions
        // applicable to the included tables (a card shape); create/rename/delete
        // are the pure store lifecycle (the engine owns every rule; a refusal
        // rides back as Err(reason)). Only op:"defineMetric" below is Rust-only.
        Some("semantic") => match body["action"].as_str() {
            Some("list") => {
                let ids = string_array(&body["includedFileIds"]);
                let is_cloud = lighthouse_core::synth::is_cloud_provider(
                    &lighthouse_core::profile::model_config(),
                );
                Ok(json!({ "semantic": lighthouse_core::meta::applicable_semantics(ids, is_cloud) }))
            }
            Some("create-metric") => {
                let summary_source = match body["summarySource"].as_str() {
                    None | Some("question") => lighthouse_core::views::SummarySource::Question,
                    Some("model") => lighthouse_core::views::SummarySource::Model,
                    Some(_) => return Err("summarySource must be \"question\" or \"model\"".into()),
                };
                let file_ids = string_array(&body["fileIds"]);
                let metric = lighthouse_core::semantic::create_metric(
                    body["name"].as_str().unwrap_or(""),
                    body["expression"].as_str().unwrap_or(""),
                    body["description"].as_str().unwrap_or(""),
                    body["entity"].as_str().unwrap_or(""),
                    lighthouse_core::views::ViewSummary {
                        text: body["summaryText"].as_str().unwrap_or("").to_string(),
                        source: summary_source,
                    },
                    &file_ids,
                )?;
                Ok(json!({ "metric": metric }))
            }
            Some("create-synonym") => {
                let synonym = lighthouse_core::semantic::create_synonym(
                    body["term"].as_str().unwrap_or(""),
                    body["canonical"].as_str().unwrap_or(""),
                )?;
                Ok(json!({ "synonym": synonym }))
            }
            Some("rename") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                let metric =
                    lighthouse_core::semantic::rename_metric(id, body["name"].as_str().unwrap_or(""))?;
                Ok(json!({ "metric": metric }))
            }
            Some("delete") => {
                if let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) {
                    let cascade = body["cascade"].as_bool().unwrap_or(false);
                    let deleted = lighthouse_core::semantic::delete_metric(id, cascade)?;
                    Ok(json!({ "deletedId": deleted }))
                } else if let Some(term) = body["term"].as_str().filter(|s| !s.is_empty()) {
                    lighthouse_core::semantic::delete_synonym(term)?;
                    Ok(json!({ "ok": true }))
                } else {
                    Err("id (metric) or term (synonym) required".into())
                }
            }
            _ => Err(
                "semantic action must be list, create-metric, create-synonym, rename, or delete"
                    .into(),
            ),
        },
        // Propose a metric from a Beam answer's SQL (openspec §6.1) — mirrors the
        // routes.rs op: the engine parses the executed SQL and proposes an
        // aggregate expression + entity for the "Define as metric" dialog. The
        // twin answers {available:false} (SQL parsing is Rust-only).
        Some("defineMetric") => {
            let sql = body["sql"].as_str().unwrap_or("");
            match lighthouse_core::analytics::propose_metric(sql) {
                Some((expression, entity)) => {
                    Ok(json!({ "available": true, "expression": expression, "entity": entity }))
                }
                None => Ok(json!({
                    "available": false,
                    "reason": "this answer has no single-table aggregate to define as a metric",
                })),
            }
        }
        // Provider sign-in (0.12.1 §3) — mirrors the routes.rs op exactly: a
        // generic RFC 8628 device-authorization client, INERT until a
        // maintainer registers with a vendor and configures all four
        // LIGHTHOUSE_SIGNIN_* values (provider_auth.rs). Unconfigured, every
        // action answers {available:false} and no host is dialed; flow
        // errors ride back as Ok({error}) (the pinAsk idiom) so the dialog
        // resets with the reason. setMethod persists the auth-method choice
        // ("key" restores the default and always works; "signin" is
        // registration-gated like the flow it arms). No vault-changed
        // broadcast — nothing here touches vault files or the tree.
        Some("providerAuth") => match body["action"].as_str() {
            Some("status") => Ok(lighthouse_core::provider_auth::status_payload()),
            Some("setMethod") => match body["method"].as_str() {
                Some("key") => {
                    lighthouse_core::settings::set_openai_auth_method("key");
                    Ok(json!({ "ok": true, "method": "key" }))
                }
                Some("signin") => {
                    if lighthouse_core::provider_auth::signin_config().is_none() {
                        Ok(json!({
                            "available": false,
                            "reason": lighthouse_core::provider_auth::UNCONFIGURED_REASON,
                        }))
                    } else {
                        lighthouse_core::settings::set_openai_auth_method("signin");
                        Ok(json!({ "ok": true, "method": "signin" }))
                    }
                }
                _ => Err("method must be \"key\" or \"signin\"".into()),
            },
            Some("start") => match lighthouse_core::provider_auth::start().await {
                Ok(flow) => Ok(json!({
                    "userCode": flow.user_code,
                    "verificationUri": flow.verification_uri,
                    "intervalMs": flow.interval_ms,
                    "expiresInMs": flow.expires_in_ms,
                })),
                Err(e) if e == lighthouse_core::provider_auth::UNCONFIGURED_REASON => {
                    Ok(json!({ "available": false, "reason": e }))
                }
                Err(e) => Ok(json!({ "error": e })),
            },
            Some("poll") => match lighthouse_core::provider_auth::poll_once().await {
                Ok(lighthouse_core::provider_auth::Poll::Pending { interval_ms }) => {
                    Ok(json!({ "status": "pending", "intervalMs": interval_ms }))
                }
                Ok(lighthouse_core::provider_auth::Poll::Complete { account }) => {
                    let mut out = json!({ "status": "complete" });
                    if let Some(a) = account {
                        out["accountHint"] = json!(a);
                    }
                    Ok(out)
                }
                Ok(lighthouse_core::provider_auth::Poll::Idle) => {
                    Ok(json!({ "status": "idle" }))
                }
                Err(e) if e == lighthouse_core::provider_auth::UNCONFIGURED_REASON => {
                    Ok(json!({ "available": false, "reason": e }))
                }
                Err(e) => Ok(json!({ "error": e })),
            },
            Some("signout") => {
                // Dropping sealed tokens is local-only and always safe, so it
                // runs regardless; the ANSWER stays fail-closed unconfigured.
                lighthouse_core::provider_auth::signout();
                if lighthouse_core::provider_auth::signin_config().is_none() {
                    Ok(json!({
                        "available": false,
                        "reason": lighthouse_core::provider_auth::UNCONFIGURED_REASON,
                    }))
                } else {
                    Ok(json!({ "ok": true }))
                }
            }
            _ => Err(
                "providerAuth action must be status, setMethod, start, poll, or signout".into(),
            ),
        },
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
    // The investigation this ask runs inside (openspec: add-investigations).
    // `Option` so an older caller that omits it still invokes cleanly; absent
    // = the global context. Resolved below, beside model_config().
    investigation_id: Option<String>,
    // Answer cache controls (openspec: add-answer-cache). `Option` so an older
    // caller that omits them still invokes cleanly; absent means false — the
    // privacy-safe default (memory-only cache, no disk mirror).
    bypass_cache: Option<bool>,
    persist_allowed: Option<bool>,
    // Two-phase plan approval (openspec: add-beam-loop §4), mirroring the
    // optional cache controls above. Phase 1: `plan_only` runs step-1 planning
    // and returns a PLAN chunk, then STOPS (executes nothing, egresses only the
    // plan-generation call). Phase 2: `approved_plan` is the approved SQL echoed
    // back on re-issue — executed as step 1 without re-planning (the guard still
    // runs). Absent = an ordinary ask, so an older caller invokes unchanged.
    plan_only: Option<bool>,
    approved_plan: Option<String>,
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
    // Investigation scope + provider policy resolve HERE — the same
    // chokepoint where the profile's model config is consulted (and beneath
    // which the managed policy's llm-time belt sits), so a local-only
    // investigation swaps cfg before any transport exists and scope arrives
    // as ordinary attachments (openspec: add-investigations). The third
    // element is the investigation's conversationRefs — retrieval's recall
    // preference (§3); empty when no investigation rides the ask. PARITY:
    // routes.rs chat_post.
    let (attachment_file_ids, cfg, preferred_conversation_ids) =
        lighthouse_core::investigations::resolve_ask_context(
            investigation_id.as_deref(),
            attachment_file_ids,
            profile::model_config(),
        );
    // Mark a chat in flight so background-conserve suspension (hide-to-tray /
    // idle) can't kill the local chat server out from under this stream — the
    // teardown waits until the guard drops at the end of the ask. Desktop-only:
    // mobile has no supervised local servers to conserve.
    #[cfg(desktop)]
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
        lighthouse_core::answer_cache::CacheCtl {
            bypass_cache: bypass_cache.unwrap_or(false),
            persist_allowed: persist_allowed.unwrap_or(false),
        },
        lighthouse_core::beam::PlanCtl {
            plan_only: plan_only.unwrap_or(false),
            approved_plan,
        },
        preferred_conversation_ids,
    );
    let mut final_files: Vec<String> = Vec::new();
    let mut artifacts: Vec<String> = Vec::new();
    // The NEW cost this ask incurred (openspec: add-beam-loop §3.2), read from
    // the final chunk's meter; a cache replay computes nothing (0 new).
    let mut answer_cost: Option<CostMeta> = None;
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
        let _ = on_chunk.send(c);
    }
    audit.finish(&provider, final_files, artifacts, answer_cost);
    Ok(())
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
    // Pinned base (see `lib.rs::app_data_base`) so this reads the same shell.log
    // that `shell_log` writes across the 0.12.8 identifier rename.
    let Some(dir) = crate::app_data_base(app) else {
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
    // `mut` feeds the desktop-only GPU merge below; on mobile it's unused.
    #[cfg_attr(not(desktop), allow(unused_mut))]
    let mut v = serde_json::to_value(local_model::model_status()).unwrap_or_else(|_| json!({}));
    // Merge the shell's REAL llama-server GPU launch state (G2) so the AI-models
    // dialog shows "GPU acceleration: on (N layers)" / "off — CPU" instead of a
    // guess. Absent until a chat server has run this session (gpu_status None) —
    // the UI treats missing fields as "unknown → render nothing". Desktop-only:
    // mobile has no llama supervision, so the fields stay absent there.
    #[cfg(desktop)]
    if let (Some(obj), Some(g)) = (
        v.as_object_mut(),
        app.try_state::<crate::supervise::Supervisor>()
            .and_then(|s| s.gpu_status()),
    ) {
        obj.insert("gpuOn".into(), json!(g.gpu));
        obj.insert("gpuLayers".into(), json!(g.layers));
        obj.insert("gpuRunning".into(), json!(g.running));
    }
    #[cfg(not(desktop))]
    let _ = &app;
    v
}

#[tauri::command]
pub async fn model_download(app: AppHandle) -> Value {
    let v = serde_json::to_value(local_model::start_download()).unwrap_or_else(|_| json!({}));
    // §22.4 eager warm: don't leave a freshly downloaded model cold until the
    // next reconcile tick discovers it — watch this download and start the
    // chat server (whose existing spawn path health-polls and then warms) the
    // moment the file lands. One watcher at a time; start_local_llm itself
    // enforces the safe-mode gate, and a suspended (hidden/passive) app defers
    // to reconcile's normal resume behavior instead of warming from the
    // background. Desktop-only: mobile has no llama supervision to warm.
    #[cfg(not(desktop))]
    let _ = &app;
    #[cfg(desktop)]
    {
    static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        tauri::async_runtime::spawn(async move {
            // Bound ≈ the slowest plausible multi-GB fetch; the 1 s poll
            // matches the UI's own download-progress poll.
            for _ in 0..(3 * 60 * 60) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                match local_model::model_status().status.as_str() {
                    "downloading" => continue,
                    "ready" => {
                        if let Some(sup) = app.try_state::<crate::supervise::Supervisor>() {
                            if !sup.is_suspended() {
                                sup.start_local_llm(&app);
                            }
                        }
                        break;
                    }
                    _ => break, // error / uninstalled / absent — nothing to warm
                }
            }
            WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }
    }
    v
}

#[tauri::command]
pub async fn model_uninstall() -> Value {
    serde_json::to_value(local_model::request_uninstall()).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn open_node(node_id: String) -> Result<Value, String> {
    // Mobile has no spawnable OS opener; §3.3 routes "open" through the OS
    // viewer/share intents instead. Honest error until then, never a silent ok.
    #[cfg(not(desktop))]
    {
        let _ = node_id;
        return Err("opening files in the OS is not available on this platform yet".into());
    }
    #[cfg(desktop)]
    {
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
}

/// Reveal a vault node in the OS file manager, selecting it inside its folder.
/// A blank node id (or none) opens the vault directory itself, so the same
/// route backs both the row action and the toolbar's "Open vault folder".
/// Works for folders too (a folder reveals/opens in place).
#[tauri::command]
pub fn reveal_node(app: AppHandle, node_id: Option<String>) -> Result<Value, String> {
    // Mobile has no OS file manager to reveal into (§3.3 exposes the vault via
    // the Files app / SAF instead). Honest error until then.
    #[cfg(not(desktop))]
    {
        let _ = (app, node_id);
        return Err("revealing files in the OS is not available on this platform yet".into());
    }
    #[cfg(desktop)]
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
    // Hotkey + whisper are desktop machinery; the mobile shell reports them as
    // dead/unsupported so the UI swaps its copy instead of promising a chord.
    #[cfg(desktop)]
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    #[cfg(not(desktop))]
    let hotkey_ok = {
        let _ = &app;
        false
    };
    #[cfg(desktop)]
    let whisper_permission = crate::whisper::permission_state();
    #[cfg(not(desktop))]
    let whisper_permission = "unsupported";
    json!({
        "desktop": true,
        // Form factor (§1): "desktop" | "ios" | "android". The UI's platform
        // gates (mode chooser, startup prompt, model roster) key off THIS, not
        // the compat `desktop` flag above.
        "platform": crate::platform_kind(),
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode, // null until the first-run chooser is answered
        "whisperMode": s.whisper_mode == Some(true),
        // "granted" | "pending" (macOS Accessibility) | "unsupported" | "unknown"
        "whisperPermission": whisper_permission,
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
        // Resizable explorer width per window mode (openspec §1), clamped at
        // read; null when unset. Mirrors app/api/settings/route.ts GET.
        "explorerWidth": {
            "window": s.explorer_width("window"),
            "widget": s.explorer_width("widget"),
        },
        // Appearance customization (openspec §3), validated. Mirrors route.ts GET.
        "appearance": s.appearance(),
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
    beam_max_steps: Option<i64>,
    // Resizable explorer width (openspec §1): {mode,width} for one window mode.
    // It rides its OWN narrow merge-setter (set_explorer_width) — NOT a new
    // positional param on write_desktop_settings (which would clobber the
    // sibling mode and trip the settings_test writer tripwire). None = untouched.
    explorer_width: Option<Value>,
    // Appearance customization (openspec §3): a validated patch through its own
    // narrow merge-setter (set_appearance), like explorer_width. None = untouched.
    appearance: Option<Value>,
) -> Value {
    // A new summon shortcut must PARSE before anything persists — saving an
    // unregistrable string would strand the user with no hotkey at all.
    // Empty string = reset to the default chord. (Desktop-only: mobile has no
    // global-shortcut backend; the value persists inert there.)
    #[cfg(desktop)]
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
    #[cfg(desktop)]
    let switched_mode = ui_mode.clone();
    #[cfg(desktop)]
    let shortcut_changed = summon_shortcut.is_some();
    // Remember the working chord so a new one that PARSES but fails to
    // register (another app already owns it) can be rolled back instead of
    // stranding the user hotkey-less with a broken value persisted.
    #[cfg(desktop)]
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
        beam_max_steps,
    );
    // Resizable explorer width (openspec §1): applied through its own narrow
    // merge-setter (set_explorer_width) so a "window" width never clobbers a
    // "widget" one — NOT the positional writer above. None = untouched; the
    // engine clamps + validates the mode.
    if let Some(ew) = explorer_width.as_ref() {
        if let (Some(mode), Some(width)) = (ew["mode"].as_str(), ew["width"].as_f64()) {
            settings::set_explorer_width(mode, width);
        }
    }
    // Appearance customization (openspec §3): the engine validates against the
    // whitelist; anything else is dropped.
    if let Some(ap) = appearance.as_ref() {
        if ap.is_object() {
            settings::set_appearance(ap);
        }
    }
    #[cfg(desktop)]
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
    // Autostart is CONSENT-FIRST (mirrors the boot gate in desktop::setup): only
    // touch the OS registration once the startup prompt has been answered.
    // Unrelated writes — e.g. the first-run uiMode chooser — must not enroll.
    #[cfg(desktop)]
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
    #[cfg(desktop)]
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
    #[cfg(desktop)]
    if let Some(on) = whisper_mode {
        if !on || lighthouse_core::policy::hotkeys_allowed() {
            crate::whisper::set_enabled(&app, on);
        }
    }
    // Semantic search (B2) applies live too: the supervisor's 3 s reconcile
    // starts or stops the embedding server to match the new setting, and its
    // health poll kicks the vector warm pass once the server is up.
    // (Desktop-only: mobile has no supervised embedding server.)
    #[cfg(desktop)]
    if semantic_search.is_some() {
        app.state::<crate::supervise::Supervisor>().reconcile(&app);
    }
    #[cfg(desktop)]
    let hotkey_ok = app
        .try_state::<crate::HotkeyOk>()
        .map(|h| h.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false);
    #[cfg(not(desktop))]
    let hotkey_ok = {
        let _ = &app;
        false
    };
    #[cfg(desktop)]
    let whisper_permission = crate::whisper::permission_state();
    #[cfg(not(desktop))]
    let whisper_permission = "unsupported";
    // Re-read so the response reflects any explorer-width merge above (which the
    // positional writer's returned `s` doesn't know about); the boolean fields
    // are unaffected either way.
    let widths = settings::read_desktop_settings();
    json!({
        "ok": true,
        "runOnStartup": s.run_on_startup != Some(false),
        "startupAsked": s.startup_asked == Some(true),
        "uiMode": s.ui_mode,
        "whisperMode": s.whisper_mode == Some(true),
        "whisperPermission": whisper_permission,
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
        "explorerWidth": {
            "window": widths.explorer_width("window"),
            "widget": widths.explorer_width("widget"),
        },
        "appearance": widths.appearance(),
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
        // The dialog plugin's folder picker is desktop-only (no
        // Android/iOS folder-pick API); folder-LINKING is a desktop flow
        // anyway — mobile ingestion is copy-in via the share sheet /
        // document picker (§3.3). Answer "nothing picked" there.
        #[cfg(desktop)]
        dialog.pick_folder(move |p| {
            let out = p
                .and_then(|f| f.into_path().ok())
                .map(|p| vec![p.to_string_lossy().to_string()])
                .unwrap_or_default();
            let _ = tx.send(out);
        });
        #[cfg(not(desktop))]
        {
            let _ = dialog;
            let _ = tx.send(Vec::new());
        }
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
    // Mobile updates are store-mediated (App Store / Play) — the shell never
    // checks or installs, so the banner permanently reads "no update here".
    #[cfg(not(desktop))]
    {
        let _ = &app;
        return json!({ "phase": "none" });
    }
    #[cfg(desktop)]
    {
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
}

/// Click-to-update from the sidebar banner: download this platform's
/// installer and hand off to it (see supervise::update_now for the
/// per-platform behavior and fallbacks).
#[tauri::command]
pub async fn update_now(app: AppHandle) -> Value {
    #[cfg(not(desktop))]
    {
        let _ = &app;
        return json!({ "ok": false, "error": "updates arrive through the app store on this platform" });
    }
    #[cfg(desktop)]
    {
        crate::supervise::update_now(app).await
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
/// The widget commands stay REGISTERED on mobile — the shared UI may still
/// invoke them — but their bodies are desktop-only no-ops there (no floating
/// bar exists to act on).
#[tauri::command]
pub fn widget_hide(app: AppHandle) {
    #[cfg(desktop)]
    crate::hide_widget(&app);
    #[cfg(not(desktop))]
    let _ = &app;
}

/// Summon the widget from the UI (the first-run mode chooser and Preferences
/// use it to demo widget mode the moment it's picked). Async + main-thread
/// hop for the same reason as open_explorer: show_widget lazily CREATES the
/// widget window when boot deferred it, and a sync command doing that
/// deadlocks the IPC handler against the main loop.
#[tauri::command]
pub async fn widget_show(app: AppHandle) {
    #[cfg(not(desktop))]
    let _ = &app;
    #[cfg(desktop)]
    {
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
}

/// Pin = the user's "keep above other windows" toggle: always-on-top AND no
/// blur auto-hide. The bar is otherwise a normal-stacking window (created
/// non-topmost; widget-mode residency only prevents auto-hide), so this is
/// the one switch that visibly changes stacking — pinned floats over
/// everything, unpinned lets other windows cover it until the next summon.
#[tauri::command]
pub fn widget_set_pin(app: AppHandle, pinned: bool) {
    #[cfg(not(desktop))]
    let _ = (&app, pinned);
    #[cfg(desktop)]
    {
        crate::set_widget_pinned(&app, pinned);
        if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
            let _ = w.set_always_on_top(pinned);
            // A pinned bar should survive workspace switches where the OS
            // supports it (macOS/Linux; a no-op on Windows).
            let _ = w.set_visible_on_all_workspaces(pinned);
        }
    }
}

/// Grow/shrink the widget window as the results dropdown or the inline
/// answer panel renders. Height is clamped shell-side so a misbehaving page
/// can't fill the screen (520 leaves room for a compact streamed answer).
#[tauri::command]
pub fn widget_resize(app: AppHandle, height: f64) {
    #[cfg(not(desktop))]
    let _ = (&app, height);
    #[cfg(desktop)]
    {
        const MIN: f64 = 56.0;
        const MAX: f64 = 520.0;
        if let Some(w) = app.get_webview_window(crate::WIDGET_LABEL) {
            let clamped = height.clamp(MIN, MAX);
            let _ = w.set_size(tauri::LogicalSize::new(crate::WIDGET_WIDTH, clamped));
        }
    }
}

/// Hold = an inline answer is on screen. Blur must not dismiss the bar while
/// the user reads a "frozen" compact answer (clicking away to their document
/// is the POINT); Esc/✕ still hide explicitly. Orthogonal to the user's pin.
#[tauri::command]
pub fn widget_hold(app: AppHandle, hold: bool) {
    #[cfg(not(desktop))]
    let _ = (&app, hold);
    #[cfg(desktop)]
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
        // Minimize/unminimize and llama supervision are desktop concepts; on
        // mobile the main webview is the only surface and is already up.
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
            // Resume the local servers if background-conserve had suspended them.
            crate::resume_servers(&app);
        }
        let _ = w.set_focus();
    }
    if let Some(q) = seed_question.filter(|q| !q.trim().is_empty()) {
        let _ = app.emit_to("main", "ask-question", json!({ "question": q }));
    }
}

/// Open the vault directory in the OS file manager (File menu; also kept for
/// anything that wants the literal folder rather than the explorer window).
#[tauri::command]
pub fn open_vault_dir(app: AppHandle) {
    #[cfg(desktop)]
    crate::open_with_os(&crate::vault_dir_setting(&app));
    #[cfg(not(desktop))]
    let _ = &app;
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
    #[cfg(desktop)]
    {
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || crate::open_explorer(&inner));
    }
    #[cfg(not(desktop))]
    let _ = &app;
}
