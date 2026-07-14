//! Microsoft Entra device-code auth + minimal Graph client for the SharePoint
//! connector (port of `src/server/sources/microsoft/{auth,graph}.ts`).
//!
//! Public client (PKCE-class): no redirect URI, no secret. Tokens live in
//! `connectors/microsoft.json`. The Graph token is only ever sent to
//! `graph.microsoft.com` hosts, so a tampered `@odata.nextLink` can't
//! exfiltrate it.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{
    connectors_dir, now_ms, read_json, sharepoint_authority, sharepoint_client_id, write_json,
    SHAREPOINT_SOURCE_ID,
};

const SCOPES: &str = "offline_access openid profile User.Read Files.Read.All Sites.Read.All";
/// Refresh a little early so a token never expires mid-request.
const EXPIRY_SKEW_MS: i64 = 60_000;

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
/// Safety bounds on the placeholder listing.
const MAX_NODES: usize = 1500;
const MAX_DEPTH: usize = 6;
const MAX_DRIVES: usize = 12;
/// Largest single file we'll mirror; bigger files are skipped, not OOM'd.
pub const MAX_MIRROR_BYTES: u64 = 50_000_000;

fn authority() -> String {
    format!(
        "{}/oauth2/v2.0",
        sharepoint_authority().trim_end_matches('/')
    )
}

/// A SharePoint/OneDrive node, cached names-only until the user enables it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpNode {
    /// Node id: `sharepoint::<driveId>::<itemId>`.
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub drive_id: String,
    pub item_id: String,
    pub kind: String, // "file" | "folder"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub device_code: String,
    pub expires_at: i64,
    pub interval: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    /// In-flight device-code session, awaiting the user to approve in a browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
    /// Cached placeholder tree from the last listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<SpNode>>,
    /// Node ids the user has enabled (mirrored to disk for retrieval).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub included: Option<HashMap<String, bool>>,
    /// Whether the source as a whole is available to retrieval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
}

fn state_path() -> PathBuf {
    connectors_dir().join("microsoft.json")
}

pub fn load_state() -> MsState {
    read_json(&state_path(), MsState::default())
}

pub fn save_state(s: &MsState) {
    write_json(&state_path(), s);
}

pub fn is_connected() -> bool {
    load_state()
        .tokens
        .map(|t| !t.refresh_token.is_empty())
        .unwrap_or(false)
}

async fn post_form(url: &str, fields: &[(&str, &str)]) -> anyhow::Result<(u16, Value)> {
    let client = reqwest::Client::new();
    crate::egress::record(url, crate::egress::PURPOSE_SHAREPOINT);
    let res = client.post(url).form(fields).send().await?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok((status, data))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeFlow {
    pub user_code: String,
    pub verification_uri: String,
    pub message: String,
    pub expires_in: i64,
    pub interval: i64,
}

/// Begin a device-code sign-in. Returns the user-facing code + URL to display.
pub async fn start_device_code() -> anyhow::Result<DeviceCodeFlow> {
    let client_id = sharepoint_client_id();
    let (status, data) = post_form(
        &format!("{}/devicecode", authority()),
        &[("client_id", client_id.as_str()), ("scope", SCOPES)],
    )
    .await?;
    let device_code = data["device_code"].as_str().unwrap_or_default().to_string();
    if status >= 400 || device_code.is_empty() {
        let msg = data["error_description"]
            .as_str()
            .or(data["error"].as_str())
            .unwrap_or("could not start sign-in");
        anyhow::bail!(msg.to_string());
    }
    let expires_in = data["expires_in"].as_i64().unwrap_or(0);
    let interval = data["interval"].as_i64().unwrap_or(5).max(1);
    let mut s = load_state();
    s.pending = Some(Pending {
        device_code,
        expires_at: now_ms() + expires_in * 1000,
        interval,
    });
    save_state(&s);
    Ok(DeviceCodeFlow {
        user_code: data["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri: data["verification_uri"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        message: data["message"].as_str().unwrap_or_default().to_string(),
        expires_in,
        interval,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct PollResult {
    pub status: String, // pending | connected | expired | idle
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
}

/// Poll once for the pending device-code session.
pub async fn poll_device_code() -> anyhow::Result<PollResult> {
    let s = load_state();
    let Some(pending) = s.pending.clone() else {
        return Ok(PollResult {
            status: if is_connected() { "connected" } else { "idle" }.to_string(),
            account: s.account,
        });
    };
    if now_ms() > pending.expires_at {
        let mut next = load_state();
        next.pending = None;
        save_state(&next);
        return Ok(PollResult {
            status: "expired".to_string(),
            account: None,
        });
    }

    let client_id = sharepoint_client_id();
    let (_status, data) = post_form(
        &format!("{}/token", authority()),
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", pending.device_code.as_str()),
        ],
    )
    .await?;

    if let Some(access_token) = data["access_token"].as_str().filter(|t| !t.is_empty()) {
        let mut next = load_state();
        next.pending = None;
        next.tokens = Some(Tokens {
            access_token: access_token.to_string(),
            refresh_token: data["refresh_token"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            expires_at: now_ms() + data["expires_in"].as_i64().unwrap_or(0) * 1000,
        });
        save_state(&next);
        let account = fetch_account(access_token).await;
        if let Some(a) = &account {
            let mut after = load_state();
            after.account = Some(a.clone());
            save_state(&after);
        }
        return Ok(PollResult {
            status: "connected".to_string(),
            account,
        });
    }
    match data["error"].as_str() {
        // authorization_pending / slow_down keep the session open.
        Some("authorization_pending") | Some("slow_down") => Ok(PollResult {
            status: "pending".to_string(),
            account: None,
        }),
        // Anything else (expired / declined / bad request) ends the session.
        _ => {
            let mut next = load_state();
            next.pending = None;
            save_state(&next);
            Ok(PollResult {
                status: "expired".to_string(),
                account: None,
            })
        }
    }
}

/// A valid access token, refreshed if the cached one has expired.
pub async fn get_access_token() -> anyhow::Result<String> {
    let s = load_state();
    let Some(tokens) = s.tokens.clone().filter(|t| !t.refresh_token.is_empty()) else {
        anyhow::bail!("not connected to Microsoft");
    };
    if !tokens.access_token.is_empty() && now_ms() < tokens.expires_at - EXPIRY_SKEW_MS {
        return Ok(tokens.access_token);
    }
    let client_id = sharepoint_client_id();
    let (_status, data) = post_form(
        &format!("{}/token", authority()),
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", tokens.refresh_token.as_str()),
            ("scope", SCOPES),
        ],
    )
    .await?;
    let Some(access_token) = data["access_token"].as_str().filter(|t| !t.is_empty()) else {
        // Refresh token revoked/expired — force a reconnect.
        let mut next = load_state();
        next.tokens = None;
        save_state(&next);
        let msg = data["error_description"]
            .as_str()
            .unwrap_or("Microsoft session expired — reconnect");
        anyhow::bail!(msg.to_string());
    };
    let mut next = load_state();
    next.tokens = Some(Tokens {
        access_token: access_token.to_string(),
        // MS may or may not rotate the refresh token; keep the old one if absent.
        refresh_token: data["refresh_token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or(tokens.refresh_token.as_str())
            .to_string(),
        expires_at: now_ms() + data["expires_in"].as_i64().unwrap_or(0) * 1000,
    });
    save_state(&next);
    Ok(access_token.to_string())
}

async fn fetch_account(access_token: &str) -> Option<Account> {
    let client = reqwest::Client::new();
    crate::egress::record(GRAPH, crate::egress::PURPOSE_SHAREPOINT);
    let res = client
        .get(format!("{GRAPH}/me"))
        .header("authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let me: Value = res.json().await.ok()?;
    Some(Account {
        name: me["displayName"]
            .as_str()
            .or(me["userPrincipalName"].as_str())
            .unwrap_or("SharePoint user")
            .to_string(),
        email: me["mail"]
            .as_str()
            .or(me["userPrincipalName"].as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// The directory holding mirrored SharePoint file content for retrieval.
pub fn mirror_dir() -> PathBuf {
    let dir = connectors_dir().join("sharepoint-mirror");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Sign out: drop tokens, cached listing, inclusion, and any mirrored content.
pub fn disconnect() {
    save_state(&MsState::default());
    let _ = fs::remove_dir_all(mirror_dir());
}

// --- Graph client ------------------------------------------------------------------

fn node_id(drive_id: &str, item_id: &str) -> String {
    format!("{SHAREPOINT_SOURCE_ID}::{drive_id}::{item_id}")
}

/// True only for Microsoft Graph hosts — the sole place we'll send the token.
fn is_graph_host(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|h| h == "graph.microsoft.com" || h.ends_with(".graph.microsoft.com"))
        .unwrap_or(false)
}

async fn graph_get(path_or_url: &str) -> anyhow::Result<Value> {
    let token = get_access_token().await?;
    let url = if path_or_url.starts_with("http") {
        path_or_url.to_string()
    } else {
        format!("{GRAPH}{path_or_url}")
    };
    if !is_graph_host(&url) {
        anyhow::bail!("refusing to send Graph token to non-Graph host");
    }
    let client = reqwest::Client::new();
    crate::egress::record(&url, crate::egress::PURPOSE_SHAREPOINT);
    let res = client
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "graph {status}: {}",
            body.chars().take(300).collect::<String>()
        );
    }
    Ok(res.json().await?)
}

struct DriveRef {
    drive_id: String,
    label: String,
}

/// The drives to scan: the user's OneDrive plus each followed site's libraries.
async fn list_drives() -> Vec<DriveRef> {
    let mut drives: Vec<DriveRef> = Vec::new();
    if let Ok(me) = graph_get("/me/drive").await {
        if let Some(id) = me["id"].as_str() {
            drives.push(DriveRef {
                drive_id: id.to_string(),
                label: "OneDrive".to_string(),
            });
        }
    }
    if let Ok(followed) = graph_get("/me/followedSites").await {
        for site in followed["value"].as_array().unwrap_or(&Vec::new()) {
            if drives.len() >= MAX_DRIVES {
                break;
            }
            let Some(site_id) = site["id"].as_str() else {
                continue;
            };
            if let Ok(libs) = graph_get(&format!("/sites/{site_id}/drives")).await {
                for d in libs["value"].as_array().unwrap_or(&Vec::new()) {
                    if drives.len() >= MAX_DRIVES {
                        break;
                    }
                    let site_name = site["displayName"]
                        .as_str()
                        .or(site["name"].as_str())
                        .unwrap_or("Site");
                    let drive_name = d["name"].as_str().unwrap_or("Documents");
                    if let Some(id) = d["id"].as_str() {
                        drives.push(DriveRef {
                            drive_id: id.to_string(),
                            label: format!("{site_name} / {drive_name}"),
                        });
                    }
                }
            }
        }
    }
    drives
}

fn to_node(drive_id: &str, item: &Value, parent_id: Option<&str>) -> SpNode {
    let is_folder = item["folder"].is_object();
    SpNode {
        id: node_id(drive_id, item["id"].as_str().unwrap_or_default()),
        name: item["name"].as_str().unwrap_or_default().to_string(),
        parent_id: parent_id.map(String::from),
        drive_id: drive_id.to_string(),
        item_id: item["id"].as_str().unwrap_or_default().to_string(),
        kind: if is_folder { "folder" } else { "file" }.to_string(),
        mime_type: item["file"]["mimeType"]
            .as_str()
            .filter(|m| !m.is_empty())
            .map(String::from),
        size: item["size"].as_u64(),
        web_url: item["webUrl"].as_str().map(String::from),
    }
}

/// Build the placeholder tree across all scannable drives. BFS up to
/// MAX_DEPTH / MAX_NODES; nothing is downloaded here.
pub async fn list_tree() -> Vec<SpNode> {
    let mut out: Vec<SpNode> = Vec::new();
    let drives = list_drives().await;
    let mut truncated = false;

    for DriveRef { drive_id, label } in drives {
        if out.len() >= MAX_NODES {
            truncated = true;
            break;
        }
        let Ok(root) = graph_get(&format!("/drives/{drive_id}/root")).await else {
            continue;
        };
        let mut root_node = to_node(&drive_id, &root, None);
        root_node.name = label;
        root_node.kind = "folder".to_string();
        let root_item_id = root_node.item_id.clone();
        let root_id = root_node.id.clone();
        out.push(root_node);

        let mut frontier: Vec<(String, String, usize)> = vec![(root_item_id, root_id, 0)];
        while !frontier.is_empty() && out.len() < MAX_NODES {
            let mut next: Vec<(String, String, usize)> = Vec::new();
            for (item_id, id, depth) in frontier {
                if depth >= MAX_DEPTH || out.len() >= MAX_NODES {
                    if out.len() >= MAX_NODES {
                        truncated = true;
                    }
                    break;
                }
                let mut url = Some(format!(
                    "/drives/{drive_id}/items/{item_id}/children?$top=200"
                ));
                while let Some(u) = url.take() {
                    if out.len() >= MAX_NODES {
                        break;
                    }
                    let Ok(page) = graph_get(&u).await else { break };
                    for item in page["value"].as_array().unwrap_or(&Vec::new()) {
                        if out.len() >= MAX_NODES {
                            truncated = true;
                            break;
                        }
                        let node = to_node(&drive_id, item, Some(&id));
                        let is_folder = node.kind == "folder";
                        let child = (node.item_id.clone(), node.id.clone(), depth + 1);
                        out.push(node);
                        if is_folder {
                            next.push(child);
                        }
                    }
                    url = page["@odata.nextLink"].as_str().map(String::from);
                }
            }
            frontier = next;
        }
    }

    if truncated {
        eprintln!(
            "[sharepoint] listing capped at {MAX_NODES} items / depth {MAX_DEPTH}; some files are not shown."
        );
    }
    out
}

/// Download an item's bytes to `dest_path`. Returns false if the item has no
/// content or exceeds the cap. Streams to disk with a hard byte ceiling so an
/// untruthful Content-Length can't buffer an unbounded file into memory.
pub async fn download_item(
    drive_id: &str,
    item_id: &str,
    dest_path: &std::path::Path,
    max_bytes: u64,
) -> anyhow::Result<bool> {
    let token = get_access_token().await?;
    let client = reqwest::Client::new();
    crate::egress::record(GRAPH, crate::egress::PURPOSE_SHAREPOINT);
    let res = client
        .get(format!("{GRAPH}/drives/{drive_id}/items/{item_id}/content"))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await?;
    if !res.status().is_success() {
        if res.status().as_u16() == 404 {
            return Ok(false);
        }
        anyhow::bail!("download {}", res.status().as_u16());
    }
    if let Some(declared) = res.content_length() {
        if declared > max_bytes {
            eprintln!("[sharepoint] skipping {item_id}: {declared} bytes exceeds {max_bytes}-byte mirror cap.");
            return Ok(false);
        }
    }
    let mut out = tokio::fs::File::create(dest_path).await?;
    use tokio::io::AsyncWriteExt;
    let mut written: u64 = 0;
    let mut over = false;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        written += chunk.len() as u64;
        if written > max_bytes {
            over = true;
            break;
        }
        out.write_all(&chunk).await?;
    }
    drop(out);
    if over {
        let _ = tokio::fs::remove_file(dest_path).await;
        eprintln!("[sharepoint] skipping {item_id}: exceeds {max_bytes}-byte mirror cap.");
        return Ok(false);
    }
    Ok(true)
}
