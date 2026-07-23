//! The container-checkable command bodies (§40): every op the wrapper's
//! `#[tauri::command]` layer delegates here, moved VERBATIM from
//! lighthouse-desktop/src/commands.rs. The only mechanical substitutions
//! (each listed in the crate-split PR): `crate::platform_kind()` →
//! `lighthouse_core::config::platform_kind()` (the wrapper's fn was already a
//! delegation), and rag_op's `app.emit("vault-changed", ())` broadcasts →
//! the injected `vault_changed` callback (the wrapper supplies the emit).
//! No tauri types anywhere in this crate — that is the point.

use serde_json::{json, Value};

use lighthouse_core::{local_model, profile, sources, vault};

pub fn string_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn err_string(e: anyhow::Error, fallback: &str) -> String {
    let m = e.to_string();
    if m.is_empty() {
        fallback.to_string()
    } else {
        m
    }
}

/// Decode `%XX` escapes (the JS side sends `encodeURIComponent` values).
pub fn percent_decode(s: &str) -> String {
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

pub async fn rag_list() -> Value {
    let (sources_list, nodes) = tokio::join!(sources::list_sources(), sources::list_nodes());
    // `desktop: true` = "embedded shell" (compat; the engine and existing UI
    // read it on iOS too). `platform` is the form-factor signal (§1).
    json!({
        "sources": sources_list,
        "nodes": nodes,
        "desktop": true,
        "platform": lighthouse_core::config::platform_kind(),
    })
}

pub async fn rag_op(
    body: Value,
    vault_changed: &(dyn Fn() + Send + Sync),
) -> Result<Value, String> {
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
            vault_changed();
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
            vault_changed();
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
                vault_changed();
                Ok(json!({ "rule": rule }))
            }
            Some("remove") => {
                let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                    return Err("id required".into());
                };
                sources::remove_rule(id).await;
                vault_changed();
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
                        vault_changed();
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
            vault_changed();
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
            vault_changed();
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
            vault_changed();
            Ok(json!({ "newId": new_id }))
        }
        Some("newFolder") => {
            let Some(name) = body["name"].as_str() else {
                return Err("name required".into());
            };
            let new_id = sources::create_folder(body["parentId"].as_str(), name)
                .await
                .map_err(|e| err_string(e, "could not create folder"))?;
            vault_changed();
            Ok(json!({ "newId": new_id }))
        }
        Some("addReference") => {
            let Some(path) = body["path"].as_str().filter(|p| !p.trim().is_empty()) else {
                return Err("path required".into());
            };
            let (id, kind) = sources::add_reference(path)
                .await
                .map_err(|e| err_string(e, "link failed"))?;
            vault_changed();
            Ok(json!({ "id": id, "kind": kind }))
        }
        Some("removeReference") => {
            let Some(ref_id) = body["refId"].as_str() else {
                return Err("refId required".into());
            };
            sources::remove_reference(ref_id)
                .await
                .map_err(|e| err_string(e, "unlink failed"))?;
            vault_changed();
            Ok(json!({ "ok": true }))
        }
        Some("remove") => {
            let Some(node_id) = body["nodeId"].as_str().filter(|n| !n.trim().is_empty()) else {
                return Err("nodeId required".into());
            };
            let restore = sources::remove_from_vault(node_id)
                .await
                .map_err(|e| err_string(e, "remove failed"))?;
            vault_changed();
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
            vault_changed();
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
                            vault_changed();
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
                    vault_changed();
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
                    vault_changed();
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
                    vault_changed();
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
                    vault_changed();
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
            // Optional structured shape (openspec: add-report-templates). Absent or
            // unknown ⇒ Standard, whose path is byte-identical to before. A template
            // narrates its framing with the configured model over the verified
            // findings; the core report stays deterministic and on-device.
            let template =
                lighthouse_core::reports::ReportTemplate::from_wire(body["template"].as_str());
            let cfg = lighthouse_core::profile::model_config();
            let is_cloud = lighthouse_core::synth::is_cloud_provider(&cfg);
            let files: Vec<(String, String, std::path::PathBuf)> =
                lighthouse_core::vault::active_included_file_ids()
                    .into_iter()
                    .filter_map(|id| {
                        lighthouse_core::vault::doc_path(&id).map(|(name, abs)| (id, name, abs))
                    })
                    .filter(|(_, name, _)| lighthouse_core::analytics::is_tabular(name))
                    .collect();
            let report = lighthouse_core::reports::investigate_templated(
                &table, &files, is_cloud, template, cfg,
            )
            .await;
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::reports::write_report(&report, investigation_id.as_deref())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            Ok(match written {
                Ok((sid, name)) => {
                    vault_changed();
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
                    vault_changed();
                    json!({ "savedId": id, "savedName": name })
                }
                Err(e) => json!({ "error": e }),
            })
        }
        _ => Err("unknown op".into()),
    }
}

pub fn profile_get() -> Value {
    serde_json::to_value(profile::get_state()).unwrap_or_else(|_| json!({}))
}

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

pub async fn model_uninstall() -> Value {
    serde_json::to_value(local_model::request_uninstall()).unwrap_or_else(|_| json!({}))
}

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

/// Add real filesystem paths to the vault: linked in place (desktop default)
/// or copied in. This replaces the HTTP multipart upload for OS drops — the
/// webview's drag-drop event already carries real paths.
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

/// Monotonic vault-change counter (the watcher's generation) so the UI can
/// refresh on push instead of polling the tree.
pub fn watch_generation() -> u64 {
    lighthouse_core::watch::generation()
}

/// Webview-side diagnostics land in the shell log (headless smoke tests read
/// them; harmless in production).
pub fn diag_report(payload: String) {
    eprintln!("[diag] {payload}");
}

// --- On-device private-model availability (docs/ios-private-model.md §5) ------
//
// The "private" provider is ONE contract, not a platform: the OpenAI-compatible
// `/v1/chat/completions` (streaming SSE deltas) + `/health` pair the engine
// speaks at `local_llm_url()` (lighthouse-core/src/llm.rs). Desktop's supervised
// llama-server answers it; on iOS the shell serves the SAME contract in-process
// behind Apple Foundation Models (gen/apple/.../PrivateModelServer.swift). This
// command reports whether a usable on-device backend exists for THIS device —
// and on iOS wires the engine to the loopback responder before returning — so
// `lighthouse-core` streams identically on device with no core change.
//
// The reply shape { available, tier, reason } is exactly what the mobile roster
// probes once to light up the "private" provider (src/stores/useOnDeviceModel.ts).

// The Swift shim's probe-and-ensure entry point (PrivateModelServer.swift).
// Resolved at RUNTIME through the OBJECTIVE-C RUNTIME first — a link-time
// `extern` is impossible (the Swift symbol is defined in the iOS APP target,
// which links after this crate, so a plain `extern` broke
// `cargo build --target aarch64-apple-ios`), and the 0.13.8 field report
// proved dlsym-into-the-main-executable unreliable in release archives even
// with `-Wl,-exported_symbol` pinning the export-trie entry (an iPhone 17 on
// iOS 26.5.2, built with SDK 26.5, still read the symbol-absent verdict).
// ObjC class metadata is found BY NAME via the runtime's class list
// (`__objc_classlist`) — no symbol table, no export trie, no dead-strip
// exposure — so `objc_getClass("LHFMBridge")` + `+[LHFMBridge ensure:]`
// always reaches the shim when it compiled in (the ios-build tripwire asserts
// it did). dlsym stays as a belt-and-suspenders fallback; when NEITHER
// resolves, the shim is genuinely absent from this binary — a BUILD defect
// reported as -6, never as the phone's OS being too old. Returns the FM_*
// result code; on success writes the bound 127.0.0.1 port through `out_port`.
#[cfg(all(not(desktop), target_os = "ios"))]
fn lighthouse_fm_ensure(out_port: *mut u16) -> i32 {
    use libc::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_getClassMethod(cls: *mut c_void, sel: *mut c_void) -> *mut c_void;
        fn objc_msgSend();
    }
    type EnsureFn = unsafe extern "C" fn(*mut u16) -> i32;
    unsafe {
        let cls = objc_getClass(b"LHFMBridge\0".as_ptr() as *const c_char);
        if !cls.is_null() {
            let sel = sel_registerName(b"ensure:\0".as_ptr() as *const c_char);
            // Verify the selector before messaging — an unrecognized selector
            // would raise, and this probe must never be able to crash the app.
            if !class_getClassMethod(cls, sel).is_null() {
                // +[LHFMBridge ensure:]: a class method takes the class object
                // as the receiver; the transmute gives objc_msgSend its true
                // shape for this call (the standard msgSend idiom).
                let send: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut u16) -> i32 =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                return send(cls, sel, out_port);
            }
        }
        // Fallback: the direct @_cdecl symbol, when the export trie carries it.
        // dlsym adds the leading underscore; the trailing NUL makes a C string.
        let name = b"lighthouse_fm_ensure\0".as_ptr() as *const c_char;
        let sym = libc::dlsym(libc::RTLD_DEFAULT, name);
        if sym.is_null() {
            return -6; // shim absent from this binary — a build defect, not the OS
        }
        // SAFETY: the symbol is the Swift @_cdecl fn with exactly this signature;
        // it only writes `out_port` (a valid local) and returns a small int code.
        let f: EnsureFn = std::mem::transmute::<*mut c_void, EnsureFn>(sym);
        f(out_port)
    }
}

/// Shared body for the `private_model_availability` command AND the iOS startup
/// hook (lib.rs), so the availability verdict + the `LIGHTHOUSE_LOCAL_LLM_URL`
/// env var are set before the first ask. Sync so the setup hook runs it inline.
/// §35 §1: start the Dynamic Type observer (LHContentSizeObserver.swift) —
/// WKWebView fixes the resolved root font size at load, so the Swift side
/// reloads the webview when UIContentSizeCategory changes. Same ObjC-runtime
/// lookup idiom as the FM bridge (class metadata cannot be dead-stripped);
/// a missing class or selector is a silent no-op, never a crash.
#[cfg(all(not(desktop), target_os = "ios"))]
pub fn start_content_size_observer() {
    use libc::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_getClassMethod(cls: *mut c_void, sel: *mut c_void) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let cls = objc_getClass(b"LHContentSizeObserver\0".as_ptr() as *const c_char);
        if cls.is_null() {
            return;
        }
        let sel = sel_registerName(b"startShared\0".as_ptr() as *const c_char);
        if class_getClassMethod(cls, sel).is_null() {
            return;
        }
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        send(cls, sel);
    }
}

#[cfg(all(not(desktop), not(target_os = "ios")))]
pub fn start_content_size_observer() {}

/// §42 §1: the PURE availability verdict — the Swift bridge's result code →
/// the roster reply shape. Cfg-free so the container's cargo tests cover the
/// whole table (the pure-verdict-fn house pattern). PARITY: mirrored by
/// src/contracts/onDeviceAvailability.ts (test/privateModelIos.test.mjs pins
/// the same cases on both sides).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrivateModelVerdict {
    pub available: bool,
    /// "foundation" (Tier-1) | "llama" (§42 Tier-2) | "none".
    pub tier: &'static str,
    pub reason: Option<&'static str>,
    /// §42: the roster may offer the ~1.1 GB model download (ONLY the
    /// capable-device, file-absent state — never below the bar).
    pub download: bool,
}

pub fn private_model_verdict(code: i32, port_ok: bool) -> PrivateModelVerdict {
    if (code == 1 || code == 2) && port_ok {
        return PrivateModelVerdict {
            available: true,
            tier: if code == 2 { "llama" } else { "foundation" },
            reason: None,
            download: false,
        };
    }
    let (reason, download) = match code {
        // An "available" code without a usable port is a failed listener.
        1 | 2 => ("the on-device private model could not be started", false),
        0 => ("Apple Intelligence is not enabled on this device", false),
        -1 => ("this device is not eligible for Apple Intelligence", false),
        -2 => ("the on-device model is still preparing — try again shortly", false),
        -3 => ("the on-device private model requires iOS 26 or later", false),
        -5 => ("the on-device private model could not be started", false),
        // -6: the bridge is absent from this BINARY (compiled without FM
        // support, or unreachable) — 0.13.8 shipped exactly this and every
        // iPhone read a false OS message; name the build, not the phone.
        -6 => ("this app build doesn't include on-device model support — update the app", false),
        // §42 Tier-2 states (docs/ios-private-model.md §4.3):
        -7 => ("the private model for this device is a ~1.1 GB download", true),
        -8 => ("this device can't hold the private model", false),
        -9 => ("not enough free memory for the private model right now — try again after closing some apps", false),
        _ => ("the on-device private model is unavailable on this device", false),
    };
    PrivateModelVerdict { available: false, tier: "none", reason: Some(reason), download }
}

pub fn private_model_availability_impl() -> Value {
    #[cfg(desktop)]
    {
        // Desktop always owns the private model (the supervised llama-server on
        // the same OpenAI-compatible contract) — no shim, no probe.
        return json!({ "available": true, "tier": "llama-server", "reason": null });
    }
    #[cfg(all(not(desktop), target_os = "ios"))]
    {
        let mut port: u16 = 0;
        // Resolves the Swift shim at runtime (dlsym, see above), then probes +
        // ensures the loopback responder is up; a small integer result code back.
        let code = lighthouse_fm_ensure(&mut port as *mut u16);
        let v = private_model_verdict(code, port != 0);
        // §42 §2: the -7 state opens the model ops (status/install) so the
        // download can happen BEFORE any backend is live; every other code
        // closes them again. The verdict's download flag IS the signal.
        local_model::set_download_offer(v.download);
        if v.available {
            // Point the engine's local transport at the in-process responder
            // BEFORE returning, so the very next ask streams through it, then
            // flip the runtime seam the engine's local branch reads. Identical
            // for both backends — the engine reads /health for the difference.
            let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
            std::env::set_var("LIGHTHOUSE_LOCAL_LLM_URL", url);
            local_model::set_on_device_backend(true);
            return json!({ "available": true, "tier": v.tier, "reason": null });
        }
        // Fail closed: the private provider stays hidden until a backend proves
        // usable. The reason maps the Swift result code to honest roster copy;
        // `download` lights the §42 roster offer (capable device, file absent).
        local_model::set_on_device_backend(false);
        let reason = v.reason.unwrap_or("the on-device private model is unavailable on this device");
        return json!({ "available": false, "tier": "none", "reason": reason, "download": v.download });
    }
    #[cfg(all(not(desktop), not(target_os = "ios")))]
    {
        // Other mobile targets (Android) get no Tier-1 backend this round —
        // fail closed so the "private" provider stays absent (the pre-reversal
        // empty-provider truths stand).
        local_model::set_on_device_backend(false);
        return json!({
            "available": false,
            "tier": "none",
            "reason": "the on-device private model is not available on this platform",
        });
    }
}

#[cfg(test)]
mod availability_tests {
    use super::{private_model_verdict, PrivateModelVerdict};

    /// §42 §1: the full verdict table, pinned (PARITY:
    /// src/contracts/onDeviceAvailability.ts mirrors these exact cases).
    #[test]
    fn verdict_table_is_pinned() {
        // Available codes with a usable port.
        assert_eq!(
            private_model_verdict(1, true),
            PrivateModelVerdict { available: true, tier: "foundation", reason: None, download: false }
        );
        assert_eq!(
            private_model_verdict(2, true),
            PrivateModelVerdict { available: true, tier: "llama", reason: None, download: false }
        );
        // An "available" code WITHOUT a port is a failed listener, honestly.
        assert!(!private_model_verdict(1, false).available);
        assert!(!private_model_verdict(2, false).available);
        // The §42 three states: download offer ONLY for capable-and-absent.
        let absent = private_model_verdict(-7, false);
        assert!(!absent.available && absent.download);
        assert_eq!(absent.reason, Some("the private model for this device is a ~1.1 GB download"));
        let below = private_model_verdict(-8, false);
        assert!(!below.available && !below.download);
        assert_eq!(below.reason, Some("this device can't hold the private model"));
        let tight = private_model_verdict(-9, false);
        assert!(!tight.available && !tight.download);
        // The FM reasons are unchanged (the 0.13.8 lesson strings).
        assert_eq!(
            private_model_verdict(-6, false).reason,
            Some("this app build doesn't include on-device model support — update the app")
        );
        assert_eq!(
            private_model_verdict(-3, false).reason,
            Some("the on-device private model requires iOS 26 or later")
        );
        // Unknown codes fall to the generic honest reason, never panic.
        assert!(!private_model_verdict(-99, false).available);
        assert!(!private_model_verdict(-99, false).download);
    }
}
