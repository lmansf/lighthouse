//! Provider sign-in (0.12.1 §3): a GENERIC, standards-based OAuth 2.0
//! **device-authorization-grant** client (RFC 8628) offered as an alternative
//! to pasting an API key — shipped **inert by default, fail-closed**.
//!
//! Nothing vendor-specific lives here: no endpoint, no client id, no vendor
//! name is embedded as a default. Every identifier must be supplied by the
//! MAINTAINER, after registering this application with the vendor whose
//! sign-in program admits it (vendors gate this on a known-clients list —
//! there is no self-serve registration to point at). What registration must
//! yield, and where each value goes:
//!
//!   - a **public-client id** (PKCE-class — carries no secret)
//!         → `LIGHTHOUSE_SIGNIN_CLIENT_ID`
//!   - the vendor's **device-authorization endpoint** (RFC 8628 §3.1)
//!         → `LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL`
//!   - the vendor's **token endpoint** (RFC 8628 §3.4 / RFC 6749 §3.2)
//!         → `LIGHTHOUSE_SIGNIN_TOKEN_URL`
//!   - the **API base** the granted tokens may call, speaking the
//!     OpenAI-compatible chat-completions dialect (asks POST
//!     `<base>/chat/completions`) → `LIGHTHOUSE_SIGNIN_API_BASE`
//!
//! Each value reads from the process env at call time, falling back to the
//! same-named `option_env!` compile-time value (runtime wins), the exact
//! pattern of the updater's `LIGHTHOUSE_UPDATER_PUBKEY` gate. If ANY of the
//! four is missing or empty the whole surface is **unavailable**: every op
//! answers `{available: false, reason: UNCONFIGURED_REASON}`, the UI renders
//! no sign-in affordance, and no host is ever dialed — a stock build makes
//! zero auth-related calls (docs/data-flows.md §1). The maintainer checklist
//! in the release PR carries the exact registration steps; if the granted
//! endpoint turns out to speak a different request shape, that lands as a
//! follow-up after registration.
//!
//! Sealed state: the access/refresh tokens, expiry, and account hint live in
//! the encrypted install-global secrets store (crate::secrets — keychain
//! backend when enabled) under the `openai-signin:*` keys. The in-flight
//! device-code handshake lives in memory only and dies with the process.
//! Tokens NEVER appear in error strings, logs, or the egress ledger (which
//! records host + purpose only).

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use crate::config::now_ms;

/// Egress-ledger purpose for calls to the configured auth host (user-visible
/// in the panel). The auth host is dialed only for sign-in and token refresh
/// and never carries document content or file names.
pub const PURPOSE_PROVIDER_SIGNIN: &str = "Provider sign-in";
/// Egress-ledger purpose for signed-in asks to the configured API base — the
/// same payload class as the keyed provider path (docs/data-flows.md §1).
pub const PURPOSE_SIGNED_IN_ASK: &str = "Signed-in ask";

/// The one honest answer every op gives until a maintainer registers with a
/// vendor and configures all four identifiers. Op layers compare against
/// this to answer `{available: false}` instead of a flow error.
pub const UNCONFIGURED_REASON: &str = "sign-in isn't configured in this build";

/// Standard OIDC scopes for a user-identity grant. Deliberately minimal —
/// no vendor-specific scope ships; a maintainer's registration may add what
/// the vendor requires via a follow-up.
const SCOPE: &str = "openid profile";

/// Refresh when within this margin of the stored expiry (mirrors the
/// connector's early-refresh idiom, wider because asks can stream long).
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// Sealed-store keys (crate::secrets — encrypted at rest, keychain-backed
/// when the `keychain` feature is on). An empty write removes the entry.
const KEY_ACCESS: &str = "openai-signin:access";
const KEY_REFRESH: &str = "openai-signin:refresh";
const KEY_EXPIRY: &str = "openai-signin:expiry";
const KEY_ACCOUNT: &str = "openai-signin:account";

/// The maintainer-supplied identifiers, present only when ALL four are set.
#[derive(Debug, Clone)]
pub struct SigninConfig {
    pub client_id: String,
    pub device_authorization_endpoint: String,
    pub token_endpoint: String,
    pub api_base: String,
}

/// One identifier: runtime env first, compile-time `option_env!` fallback.
fn cfg_value(runtime: Option<String>, build: Option<&'static str>) -> Option<String> {
    runtime
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            build
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

/// The sign-in configuration, or `None` — the single fail-closed gate every
/// operation (and the UI's visibility) hangs off. Read at call time so a
/// runtime env change needs no rebuild.
pub fn signin_config() -> Option<SigninConfig> {
    Some(SigninConfig {
        client_id: cfg_value(
            std::env::var("LIGHTHOUSE_SIGNIN_CLIENT_ID").ok(),
            option_env!("LIGHTHOUSE_SIGNIN_CLIENT_ID"),
        )?,
        device_authorization_endpoint: cfg_value(
            std::env::var("LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL").ok(),
            option_env!("LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL"),
        )?,
        token_endpoint: cfg_value(
            std::env::var("LIGHTHOUSE_SIGNIN_TOKEN_URL").ok(),
            option_env!("LIGHTHOUSE_SIGNIN_TOKEN_URL"),
        )?,
        api_base: cfg_value(
            std::env::var("LIGHTHOUSE_SIGNIN_API_BASE").ok(),
            option_env!("LIGHTHOUSE_SIGNIN_API_BASE"),
        )?,
    })
}

/// One process-wide reqwest client (connection pool + TLS reused) — the
/// llm.rs `http_client` idiom.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// In-flight device-code handshake — memory only, never persisted.
#[derive(Debug, Clone)]
struct Pending {
    device_code: String,
    expires_at_ms: i64,
    interval_ms: i64,
}

fn pending_slot() -> &'static Mutex<Option<Pending>> {
    static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

fn clear_pending() {
    *pending_slot().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Form-POST to the CONFIGURED auth host, recording the egress first.
/// Returns (status, parsed JSON — Null when the body isn't JSON).
async fn post_form(url: &str, fields: &[(&str, &str)]) -> Result<(u16, Value), String> {
    let client = http_client();
    crate::egress::record(url, PURPOSE_PROVIDER_SIGNIN);
    let res = client
        .post(url)
        .form(fields)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("couldn't reach the sign-in service — {e}"))?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok((status, data))
}

/// A vendor error surfaced honestly: the response's `error_description` /
/// `error` when present, else `fallback`. Never contains OUR tokens (none
/// are interpolated here — only vendor-authored strings pass through).
fn vendor_error(data: &Value, fallback: &str) -> String {
    data["error_description"]
        .as_str()
        .or(data["error"].as_str())
        .filter(|m| !m.is_empty())
        .unwrap_or(fallback)
        .chars()
        .take(200)
        .collect()
}

/// What `start()` hands the UI: the code the user enters and where.
#[derive(Debug, Clone)]
pub struct StartInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub interval_ms: i64,
    pub expires_in_ms: i64,
}

/// Begin a device-authorization sign-in (RFC 8628 §3.1): POST
/// `{client_id, scope}` to the configured device-authorization endpoint and
/// remember the returned `device_code` in memory for `poll_once`.
pub async fn start() -> Result<StartInfo, String> {
    let cfg = signin_config().ok_or_else(|| UNCONFIGURED_REASON.to_string())?;
    let (status, data) = post_form(
        &cfg.device_authorization_endpoint,
        &[("client_id", cfg.client_id.as_str()), ("scope", SCOPE)],
    )
    .await?;
    let device_code = data["device_code"].as_str().unwrap_or_default().to_string();
    if status >= 400 || device_code.is_empty() {
        return Err(vendor_error(&data, "the sign-in service refused to start"));
    }
    let interval_ms = data["interval"].as_i64().unwrap_or(5).max(1) * 1000;
    let expires_in_ms = data["expires_in"].as_i64().unwrap_or(600).max(1) * 1000;
    let info = StartInfo {
        user_code: data["user_code"].as_str().unwrap_or_default().to_string(),
        verification_uri: data["verification_uri"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        interval_ms,
        expires_in_ms,
    };
    *pending_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(Pending {
        device_code,
        expires_at_ms: now_ms() + expires_in_ms,
        interval_ms,
    });
    Ok(info)
}

/// One poll's outcome. `Pending` carries the (possibly `slow_down`-bumped)
/// interval the caller should wait before polling again.
#[derive(Debug, Clone)]
pub enum Poll {
    Pending { interval_ms: i64 },
    Complete { account: Option<String> },
    /// No handshake in flight and not signed in — nothing to poll.
    Idle,
}

/// Poll the pending handshake once (RFC 8628 §3.4/§3.5): the device-code
/// grant against the configured token endpoint. `authorization_pending` /
/// `slow_down` keep the handshake open; tokens seal into the secrets store
/// and clear it; expiry/denial clear it with the honest reason.
pub async fn poll_once() -> Result<Poll, String> {
    let cfg = signin_config().ok_or_else(|| UNCONFIGURED_REASON.to_string())?;
    let pending = pending_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let Some(pending) = pending else {
        return Ok(if status().signed_in {
            Poll::Complete {
                account: crate::secrets::get_provider_key(KEY_ACCOUNT),
            }
        } else {
            Poll::Idle
        });
    };
    if now_ms() > pending.expires_at_ms {
        clear_pending();
        return Err("the sign-in code expired before it was approved — start again".to_string());
    }
    let (_status, data) = post_form(
        &cfg.token_endpoint,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", cfg.client_id.as_str()),
            ("device_code", pending.device_code.as_str()),
        ],
    )
    .await?;
    if let Some(access) = data["access_token"].as_str().filter(|t| !t.is_empty()) {
        store_tokens(access, data["refresh_token"].as_str(), data["expires_in"].as_i64());
        let account = account_hint(data["id_token"].as_str());
        if let Some(a) = &account {
            crate::secrets::set_provider_key(KEY_ACCOUNT, a);
        }
        clear_pending();
        return Ok(Poll::Complete { account });
    }
    match data["error"].as_str() {
        Some("authorization_pending") => Ok(Poll::Pending {
            interval_ms: pending.interval_ms,
        }),
        Some("slow_down") => {
            // RFC 8628 §3.5: add 5 seconds to the interval and keep waiting.
            let bumped = pending.interval_ms + 5_000;
            if let Some(p) = pending_slot()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_mut()
            {
                p.interval_ms = bumped;
            }
            Ok(Poll::Pending { interval_ms: bumped })
        }
        Some("expired_token") => {
            clear_pending();
            Err("the sign-in code expired before it was approved — start again".to_string())
        }
        Some("access_denied") => {
            clear_pending();
            Err("the sign-in was declined".to_string())
        }
        _ => {
            clear_pending();
            Err(vendor_error(&data, "sign-in failed — start again"))
        }
    }
}

/// Seal the granted tokens. A rotation response missing `refresh_token`
/// keeps the stored one (the connector's refresh idiom).
fn store_tokens(access: &str, refresh: Option<&str>, expires_in_s: Option<i64>) {
    crate::secrets::set_provider_key(KEY_ACCESS, access);
    if let Some(r) = refresh.filter(|r| !r.is_empty()) {
        crate::secrets::set_provider_key(KEY_REFRESH, r);
    }
    let expires_at = now_ms() + expires_in_s.unwrap_or(3600).max(0) * 1000;
    crate::secrets::set_provider_key(KEY_EXPIRY, &expires_at.to_string());
}

/// Best-effort account hint from an id_token's CLAIMS — a display string
/// only, never trusted for anything. Deliberately no JWT dependency and no
/// signature verification: split the compact form, base64-decode the payload,
/// read a name-ish claim; any failure ⇒ `None`.
fn account_hint(id_token: Option<&str>) -> Option<String> {
    let payload = id_token?.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    ["email", "preferred_username", "name"]
        .iter()
        .find_map(|k| claims[k].as_str())
        .map(|s| s.chars().take(120).collect::<String>())
        .filter(|s| !s.is_empty())
}

fn stored_expiry_ms() -> Option<i64> {
    crate::secrets::get_provider_key(KEY_EXPIRY)?.parse::<i64>().ok()
}

/// Read-only sign-in state. `signed_in` requires the build to be CONFIGURED
/// as well as a sealed refresh token: tokens left over from a formerly
/// configured build are unreachable (fail-closed), not "signed in".
#[derive(Debug, Clone)]
pub struct StatusInfo {
    pub available: bool,
    pub signed_in: bool,
    pub expires_ms: Option<i64>,
    pub account: Option<String>,
    pub reason: Option<String>,
}

pub fn status() -> StatusInfo {
    let available = signin_config().is_some();
    let signed_in = available && crate::secrets::get_provider_key(KEY_REFRESH).is_some();
    StatusInfo {
        available,
        signed_in,
        expires_ms: if signed_in { stored_expiry_ms() } else { None },
        account: if signed_in {
            crate::secrets::get_provider_key(KEY_ACCOUNT)
        } else {
            None
        },
        reason: (!available).then(|| UNCONFIGURED_REASON.to_string()),
    }
}

/// The `providerAuth status` wire payload, shared by the axum route and the
/// desktop IPC command (the policy/egress `snapshot()` idiom). `method` is
/// the persisted auth-method choice (settings), defaulting to "key".
pub fn status_payload() -> Value {
    let s = status();
    let method = match crate::settings::read_desktop_settings()
        .openai_auth_method
        .as_deref()
    {
        Some("signin") => "signin",
        _ => "key",
    };
    let mut out = json!({
        "available": s.available,
        "signedIn": s.signed_in,
        "method": method,
    });
    if let Some(ms) = s.expires_ms {
        out["expiresMs"] = json!(ms);
    }
    if let Some(a) = s.account {
        out["accountHint"] = json!(a);
    }
    if let Some(r) = s.reason {
        out["reason"] = json!(r);
    }
    out
}

/// Drop the signed-in session: remove every sealed `openai-signin:*` entry
/// and any in-flight handshake. Local-only (no network), always safe.
pub fn signout() {
    for key in [KEY_ACCESS, KEY_REFRESH, KEY_EXPIRY, KEY_ACCOUNT] {
        crate::secrets::set_provider_key(key, "");
    }
    clear_pending();
}

/// A currently-valid access token for a signed-in ask, refreshing via the
/// refresh-token grant when within `REFRESH_SKEW_MS` of expiry and rotating
/// the stored refresh token when the response carries a new one. Errors are
/// honest reasons and NEVER contain a token.
pub async fn ensure_fresh_access() -> Result<String, String> {
    let cfg = signin_config().ok_or_else(|| UNCONFIGURED_REASON.to_string())?;
    if let (Some(token), Some(expiry)) = (
        crate::secrets::get_provider_key(KEY_ACCESS),
        stored_expiry_ms(),
    ) {
        if now_ms() < expiry - REFRESH_SKEW_MS {
            return Ok(token);
        }
    }
    let Some(refresh) = crate::secrets::get_provider_key(KEY_REFRESH) else {
        return Err("not signed in — open Settings → AI models and sign in".to_string());
    };
    let (_status, data) = post_form(
        &cfg.token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", cfg.client_id.as_str()),
            ("refresh_token", refresh.as_str()),
        ],
    )
    .await?;
    let Some(access) = data["access_token"].as_str().filter(|t| !t.is_empty()) else {
        // The vendor answered but granted nothing: the session is dead and
        // can't recover on its own — drop it so status reads signed-out and
        // the UI offers sign-in again. (A network failure returns above and
        // does NOT sign the user out.)
        signout();
        return Err(vendor_error(&data, "the sign-in session expired — sign in again"));
    };
    store_tokens(access, data["refresh_token"].as_str(), data["expires_in"].as_i64());
    Ok(access.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure helpers only — the full mocked-endpoint E2E (env-configured, so it
    // must own the process env) lives in tests/provider_auth_test.rs.

    #[test]
    fn account_hint_reads_claims_and_fails_to_none() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"email":"maintainer@example.com","name":"M"}"#);
        let token = format!("eyJhbGciOiJub25lIn0.{payload}.sig");
        assert_eq!(
            account_hint(Some(&token)).as_deref(),
            Some("maintainer@example.com")
        );
        // Precedence: email > preferred_username > name.
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"preferred_username":"m-user","name":"M"}"#);
        assert_eq!(
            account_hint(Some(&format!("h.{payload}.s"))).as_deref(),
            Some("m-user")
        );
        // Garbage in ⇒ None out, never a panic (and never a partial decode).
        assert_eq!(account_hint(None), None);
        assert_eq!(account_hint(Some("not-a-jwt")), None);
        assert_eq!(account_hint(Some("a.!!!not-base64!!!.c")), None);
        let empty = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"x"}"#);
        assert_eq!(account_hint(Some(&format!("h.{empty}.s"))), None);
    }

    #[test]
    fn vendor_error_prefers_description_and_clamps() {
        let d = json!({ "error": "access_denied", "error_description": "the user said no" });
        assert_eq!(vendor_error(&d, "fallback"), "the user said no");
        let d = json!({ "error": "slow_down" });
        assert_eq!(vendor_error(&d, "fallback"), "slow_down");
        assert_eq!(vendor_error(&Value::Null, "fallback"), "fallback");
        let long = json!({ "error_description": "x".repeat(500) });
        assert_eq!(vendor_error(&long, "f").chars().count(), 200);
    }
}
