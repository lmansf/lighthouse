//! The container-checkable command bodies (§40): every op the wrapper's
//! `#[tauri::command]` layer delegates here, moved VERBATIM from
//! lighthouse-desktop/src/commands.rs. The only mechanical substitutions
//! (each listed in the crate-split PR): `crate::platform_kind()` →
//! `lighthouse_core::config::platform_kind()` (the wrapper's fn was already a
//! delegation), and rag_op's `app.emit("vault-changed", ())` broadcasts →
//! the injected `vault_changed` callback (the wrapper supplies the emit).
//! No tauri types anywhere in this crate — that is the point.

use serde_json::{json, Value};

use lighthouse_core::{local_model, profile};

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
    // 0.15.0: there is no tree. The payload keeps its SHAPE — clients read
    // `desktop`/`platform` off it on every launch — with empty lists where the
    // vault's sources and nodes used to be.
    let (sources_list, nodes): (Vec<serde_json::Value>, Vec<serde_json::Value>) =
        (Vec::new(), Vec::new());
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
        // Read-only per-file inspector ("What the AI sees", openspec:
        // add-file-inspector): what the engine extracted/chunked/catalogued/
        // indexed for one file, plus an optional file-scoped test-search. PURE
        // READ — surfaces state, never a setter; no vault-changed broadcast.
        Some("inspect") => {
            let Some(file_id) = body["fileId"].as_str().filter(|s| !s.is_empty()) else {
                return Err("fileId required".into());
            };
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let file_id = file_id.to_string();
            let query = body["query"].as_str().map(String::from);
            let inspection = tokio::task::spawn_blocking(move || {
                lighthouse_core::inspect::inspect(&conversation_id, &file_id, query.as_deref())
            })
            .await
            .unwrap_or_default();
            Ok(serde_json::to_value(inspection).unwrap_or_else(|_| json!({})))
        }
        // §49: read a saved report note's full markdown by id — the in-app
        // report reader's backing (§2). PURE READ; no vault-changed broadcast.
        Some("readNote") => {
            let Some(id) = body["id"].as_str().filter(|s| !s.is_empty()) else {
                return Err("id required".into());
            };
            match lighthouse_core::reports::read_note(id) {
                Some((name, markdown)) => Ok(json!({ "name": name, "markdown": markdown })),
                None => Ok(json!({ "error": "not found" })),
            }
        }
        // §49 §4: the Reports home library — every saved report, newest-first.
        Some("listReports") => {
            let reports: Vec<serde_json::Value> = lighthouse_core::reports::list_reports()
                .into_iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "name": r.name,
                        "generatedAtMs": r.generated_ms,
                    })
                })
                .collect();
            Ok(json!({ "reports": reports }))
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
            // The conversation whose attachments these ids belong to.
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            // With `saveAs`, the same guarded run also renders a full-fidelity
            // CSV — RETURNED for the OS save dialog (0.15.0; it used to be
            // written into Lighthouse Results/).
            if let Some(hint) = body["saveAs"].as_str() {
                return Ok(
                    match lighthouse_core::analytics::run_direct_save(
                        &conversation_id,
                        &sql,
                        &file_ids,
                        hint,
                    )
                    .await
                    {
                        Ok((r, saved)) => json!({
                            "markdown": r.markdown,
                            "chart": r.chart,
                            "footer": r.footer,
                            "savedName": saved.name,
                            "content": saved.csv,
                            "rows": saved.rows,
                        }),
                        Err(e) => json!({ "error": e }),
                    },
                );
            }
            Ok(
                match lighthouse_core::analytics::run_direct(&conversation_id, &sql, &file_ids)
                    .await
                {
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
            // 0.15.0: the artifact is RETURNED, not written. It used to land in
            // a `Lighthouse Notes/` or `Lighthouse Results/` vault folder; with
            // the vault gone the client saves it through the OS save dialog, so
            // the export leaves the app instead of becoming more app state. The
            // ext allowlist stays — it is the app's, never the client's.
            let ext = match body.get("ext").map(|v| v.as_str()) {
                None => "md",
                Some(Some("md")) => "md",
                Some(Some("html")) => "html",
                Some(_) => return Err("ext must be \"md\" or \"html\"".into()),
            };
            Ok(json!({ "savedName": format!("{title}.{ext}"), "content": markdown }))
        }
        // The G6 conversation-note auto-export and its purge lived here. Both
        // wrote INDEXED vault notes — a chat became a retrievable file so later
        // asks could recall it — which only means anything with a vault to
        // index into. Chat history is UI state again (0.15.0).
        Some("suggestedAsks") => {
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            // Under a cloud provider, resolve chips against the shareable set so
            // a marked file's columns never surface as a suggestion.
            let _is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            // Saved views join the suggestions when any exist (openspec:
            // add-shaped-views §4); byte-identical to the file-only path when
            // the store is empty.
            let asks = lighthouse_core::meta::suggested_asks_resolved(conversation_id, ids).await;
            Ok(json!({ "asks": asks }))
        }
        // Recipes applicable to the included set (openspec: add-recipes §2.3) —
        // the Library gallery / empty-state chips. Same shareable/posture rule as
        // suggestedAsks. Execution rides the ask path via the `run-recipe:{id} on
        // {table}` cue, not a JSON op. Mirrors the routes.rs op exactly.
        Some("applicableRecipes") => {
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let _is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let recipes = lighthouse_core::meta::applicable_recipes(conversation_id, ids).await;
            Ok(json!({ "recipes": recipes }))
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
            // Optional structured shape (openspec: add-report-templates). Absent or
            // unknown ⇒ Standard, whose path is byte-identical to before. A template
            // narrates its framing with the configured model over the verified
            // findings; the core report stays deterministic and on-device.
            let template =
                lighthouse_core::reports::ReportTemplate::from_wire(body["template"].as_str());
            // §46: the analyst's optional working hypothesis seeds the template's
            // FRAMING only (never a figure — the report's digit gate is unchanged).
            let hypothesis = body["hypothesis"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            // §47 §5: on mobile, re-ensure the on-device bridge before the report
            // runs. iOS tears its loopback responder down on app suspension, and
            // — unlike chat_ask — the investigate arm never re-bound it, so a
            // report at a suspended bridge streamed into "Connection refused" and
            // the digit gate silently dropped the framing (engine framing, no
            // model). This re-binds it once; investigate_templated then warm-waits
            // it to Ready. Desktop self-heals via the llama-server supervisor, so
            // it is skipped there (mirrors chat_ask's gate).
            #[cfg(not(desktop))]
            let _ = private_model_availability_impl();
            let cfg = lighthouse_core::profile::model_config();
            let is_cloud = lighthouse_core::synth::is_cloud_provider(&cfg);
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let files: Vec<(String, String, std::path::PathBuf)> =
                lighthouse_core::workspace::list(&conversation_id)
                    .into_iter()
                    .filter_map(|f| {
                        lighthouse_core::workspace::resolve(&conversation_id, &f.id)
                            .map(|(name, abs)| (f.id, name, abs))
                    })
                    .filter(|(_, name, _)| lighthouse_core::analytics::is_tabular(name))
                    .collect();
            let report = lighthouse_core::reports::investigate_templated(
                &table, &files, is_cloud, template, hypothesis.as_deref(), cfg,
            )
            .await;
            let written = tokio::task::spawn_blocking(move || {
                lighthouse_core::reports::write_report(&report)
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
            let conversation_id = body["conversationId"].as_str().unwrap_or("").to_string();
            let ids: Vec<String> = body["includedFileIds"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let _is_cloud =
                lighthouse_core::synth::is_cloud_provider(&lighthouse_core::profile::model_config());
            let map = lighthouse_core::meta::capability_map(conversation_id, ids).await;
            Ok(json!({ "map": map }))
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
            // 0.15.0: the CSV comes BACK for the OS save dialog. It used to be
            // written into `Lighthouse Notes/` as a vault artifact.
            let csv = tokio::task::spawn_blocking(lighthouse_core::audit::export_csv)
                .await
                .unwrap_or_default();
            Ok(json!({ "savedName": "Audit Log.csv", "content": csv }))
        }
        _ => Err("unknown op".into()),
    }
}

pub fn profile_get() -> Value {
    serde_json::to_value(profile::get_state()).unwrap_or_else(|_| json!({}))
}

pub async fn profile_op(body: Value) -> Result<Value, String> {
    match body["op"].as_str() {
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


// The model commands are async so they run on the Tauri async runtime, NOT the
// main thread. That (a) gives `start_download()` an ambient Tokio runtime to
// spawn onto, and (b) contains any future panic in this path to the task —
// sync commands run on the main thread, where a panic exits the whole app
// (which is exactly how the Install click used to crash the desktop build).

pub async fn model_uninstall() -> Value {
    serde_json::to_value(local_model::request_uninstall()).unwrap_or_else(|_| json!({}))
}

/// Open one of a conversation's attachments in the OS viewer. Since 0.15.0 the
/// path is the content-addressed BLOB rather than a vault node — same bytes,
/// and `blob_name` keeps the real extension so the OS still picks the right
/// app. The user's own copy, wherever they attached it from, is untouched.
pub fn open_node(conversation_id: String, node_id: String) -> Result<Value, String> {
    // Mobile has no spawnable OS opener; §3.3 routes "open" through the OS
    // viewer/share intents instead. Honest error until then, never a silent ok.
    #[cfg(not(desktop))]
    {
        let _ = (conversation_id, node_id);
        return Err("opening files in the OS is not available on this platform yet".into());
    }
    #[cfg(desktop)]
    {
        let Some((_, abs)) = lighthouse_core::workspace::resolve(&conversation_id, &node_id) else {
            return Err("file no longer exists".into());
        };
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


/// Attach OS files to a conversation by absolute PATH (openspec:
/// refocus-chat-attachments §2.1) — the desktop drag-drop twin of the
/// multipart upload. A native drop hands the webview paths, never bytes, and
/// the webview cannot read a path itself; this reads each file and puts it in
/// the conversation's workspace, where the engine enforces the 10-file cap and
/// starts ingestion at once. Nothing is linked in place: an attachment's bytes
/// are copied into the content-addressed blob store, which is what makes every
/// downstream cache content-keyed and the corpus immutable for the ask.
///
/// The vault-era `add_paths` (copy-in / link-in-place) is a different door and
/// stays for the legacy path.
pub async fn attach_paths(conversation_id: &str, paths: Vec<String>) -> Value {
    let mut added: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for p in paths {
        let abs = std::path::Path::new(&p);
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // Managed policy `vaultRoots` (openspec: add-managed-policy) used to
        // constrain where the vault folder could live. With the vault gone it
        // constrains the same thing it always meant — which of the user's files
        // this app may read — enforced here, at the one door files come in
        // through. An unrestricted policy allows every path, so this is inert
        // for everyone but a managed install.
        if !lighthouse_core::policy::vault_path_allowed(abs) {
            skipped.push(json!({
                "name": name,
                "reason": "this location is not allowed by your organization",
            }));
            continue;
        }
        match std::fs::read(&p) {
            Ok(bytes) => match lighthouse_core::workspace::attach(conversation_id, &name, &bytes) {
                Ok(att) => {
                    // Ingest OFF the attach so the reply is immediate; the ask
                    // awaits only what it needs (openspec §1.2).
                    lighthouse_core::workspace::ingest_detached(&att);
                    added.push(json!({ "newId": att.id, "name": att.name }));
                }
                Err(e) => {
                    skipped.push(json!({ "name": name, "reason": err_string(e, "attach failed") }))
                }
            },
            Err(e) => skipped.push(json!({ "name": name, "reason": e.to_string() })),
        }
    }
    json!({ "added": added, "skipped": skipped })
}

/// The vault's change counter, kept as an inert zero so an older client that
/// still polls it gets a stable answer instead of an unknown-command error.
/// Nothing changes underneath the app any more: attachments are write-once
/// blobs the app itself put there, so there is no external change to report.
pub fn watch_generation() -> u64 {
    0
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
