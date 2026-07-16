//! Provider sign-in (0.12.1 §3) — the mocked-endpoint E2E for the generic
//! RFC 8628 device-authorization client (`provider_auth.rs`).
//!
//! No HTTP-mock crate ships in dev-dependencies, so the vendor is a
//! `std::net::TcpListener` thread with scripted HTTP/1.1 responses (the
//! embed_test stub idiom): a device-authorization endpoint, a token endpoint
//! (pending → slow_down → grant, then one refresh rotation, then a dead
//! grant), and an OpenAI-compatible `/v1/chat/completions` SSE endpoint for
//! the signed-in ask.
//!
//! ONE test drives the whole sequence: the four LIGHTHOUSE_SIGNIN_* values
//! and the settings/app-state files are process-global env, so phases must
//! run in order in one thread (the suite's env-serialization rule) —
//! starting from the UNCONFIGURED state, where every operation must answer
//! fail-closed without dialing anything.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use base64::Engine;
use futures::StreamExt;

use lighthouse_core::contracts::ChatTurn;
use lighthouse_core::llm::{stream_answer, Ctx, ModelCfg};
use lighthouse_core::provider_auth as pa;

const SIGNIN_ENVS: [&str; 4] = [
    "LIGHTHOUSE_SIGNIN_CLIENT_ID",
    "LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL",
    "LIGHTHOUSE_SIGNIN_TOKEN_URL",
    "LIGHTHOUSE_SIGNIN_API_BASE",
];

/// Scripted vendor state: which canned answer each endpoint gives next.
#[derive(Default)]
struct Script {
    device_grant_calls: usize,
    refresh_calls: usize,
}

/// Every request the mock served, as `head + body` strings, so assertions
/// can check exactly what left the client (params, bearer, counts).
type RequestLog = Arc<Mutex<Vec<String>>>;

fn spawn_vendor() -> (String, RequestLog) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let log: RequestLog = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(Script::default()));
    let thread_base = base.clone();
    let thread_log = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            // Read head + Content-Length body (one request per connection).
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let (mut head_end, mut body_need) = (0usize, None::<usize>);
            loop {
                if body_need.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        head_end = pos + 4;
                        let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        body_need = Some(len);
                    }
                }
                if let Some(need) = body_need {
                    if buf.len() >= head_end + need {
                        break;
                    }
                }
                match s.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    Err(_) => break,
                }
            }
            let request = String::from_utf8_lossy(&buf).to_string();
            thread_log.lock().unwrap().push(request.clone());
            let (status, ctype, body) = respond(&request, &thread_base, &script);
            let _ = write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (base, log)
}

/// The vendor's script, keyed on path + form fields.
fn respond(
    request: &str,
    base: &str,
    script: &Arc<Mutex<Script>>,
) -> (&'static str, &'static str, String) {
    if request.starts_with("POST /device") {
        let body = serde_json::json!({
            "device_code": "dev-code-1",
            "user_code": "WDJB-MJHT",
            "verification_uri": format!("{base}/verify"),
            "interval": 1,
            "expires_in": 600,
        });
        return ("200 OK", "application/json", body.to_string());
    }
    if request.starts_with("POST /token") {
        if request.contains("grant_type=refresh_token") {
            let mut sc = script.lock().unwrap();
            sc.refresh_calls += 1;
            return if sc.refresh_calls == 1 {
                // First refresh: new access token AND a rotated refresh token.
                (
                    "200 OK",
                    "application/json",
                    r#"{"access_token":"at-2","refresh_token":"rt-2","expires_in":3600}"#
                        .to_string(),
                )
            } else {
                // Later refreshes: the grant is dead — the client must drop
                // the session and say so honestly (without the token).
                (
                    "400 Bad Request",
                    "application/json",
                    r#"{"error":"invalid_grant","error_description":"grant is revoked"}"#
                        .to_string(),
                )
            };
        }
        // Device-code grant: pending → slow_down → tokens (RFC 8628 §3.5).
        let mut sc = script.lock().unwrap();
        sc.device_grant_calls += 1;
        return match sc.device_grant_calls {
            1 => (
                "400 Bad Request",
                "application/json",
                r#"{"error":"authorization_pending"}"#.to_string(),
            ),
            2 => (
                "400 Bad Request",
                "application/json",
                r#"{"error":"slow_down"}"#.to_string(),
            ),
            _ => {
                let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(r#"{"email":"maintainer@example.com"}"#);
                let body = serde_json::json!({
                    "access_token": "at-1",
                    "refresh_token": "rt-1",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                    "id_token": format!("eyJhbGciOiJub25lIn0.{claims}.sig"),
                });
                ("200 OK", "application/json", body.to_string())
            }
        };
    }
    if request.starts_with("POST /v1/chat/completions") {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n\
                   data: [DONE]\n\n";
        return ("200 OK", "text/event-stream", sse.to_string());
    }
    ("404 Not Found", "application/json", r#"{"error":"unknown"}"#.to_string())
}

/// Collect a whole streamed answer into one string.
async fn collect_answer(cfg: ModelCfg) -> String {
    let contexts = vec![Ctx {
        name: "notes.md".to_string(),
        text: "the quarterly total is 42".to_string(),
        score: 1.0,
    }];
    let mut s = stream_answer(
        "what is the quarterly total?".to_string(),
        contexts,
        cfg,
        Vec::<ChatTurn>::new(),
    );
    let mut out = String::new();
    while let Some(delta) = s.next().await {
        out.push_str(&delta);
    }
    out
}

fn openai_cfg(api_key: Option<&str>) -> ModelCfg {
    ModelCfg {
        provider_id: Some("openai".to_string()),
        model_id: Some("test-model".to_string()),
        api_key: api_key.map(String::from),
    }
}

fn chat_requests(log: &RequestLog) -> usize {
    log.lock()
        .unwrap()
        .iter()
        .filter(|r| r.starts_with("POST /v1/chat/completions"))
        .count()
}

#[test]
fn device_flow_end_to_end_from_unconfigured_to_signed_in_ask() {
    // Process-global env: everything runs in this ONE test, in order.
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("LIGHTHOUSE_APP_STATE_DIR", dir.path());
    let settings_file = dir.path().join("settings.json");
    std::env::set_var("LIGHTHOUSE_SETTINGS_FILE", &settings_file);
    std::env::remove_var("LIGHTHOUSE_POLICY_FILE");
    for v in SIGNIN_ENVS {
        std::env::remove_var(v);
    }
    lighthouse_core::egress::reset_for_tests();
    let rt = tokio::runtime::Runtime::new().unwrap();

    // --- Phase 0: UNCONFIGURED ⇒ every operation answers fail-closed, and
    // nothing is dialed (the vendor doesn't even exist yet). --------------
    assert!(pa::signin_config().is_none(), "stock build must be unconfigured");
    let st = pa::status();
    assert!(!st.available && !st.signed_in);
    assert_eq!(st.reason.as_deref(), Some(pa::UNCONFIGURED_REASON));
    let payload = pa::status_payload();
    assert_eq!(payload["available"], false);
    assert_eq!(payload["signedIn"], false);
    assert_eq!(payload["method"], "key", "default method is the key path");
    assert_eq!(payload["reason"], pa::UNCONFIGURED_REASON);
    assert_eq!(
        rt.block_on(pa::start()).unwrap_err(),
        pa::UNCONFIGURED_REASON
    );
    assert_eq!(
        rt.block_on(pa::poll_once()).unwrap_err(),
        pa::UNCONFIGURED_REASON
    );
    assert_eq!(
        rt.block_on(pa::ensure_fresh_access()).unwrap_err(),
        pa::UNCONFIGURED_REASON
    );

    // Partial configuration is still unconfigured — ALL FOUR or nothing.
    std::env::set_var("LIGHTHOUSE_SIGNIN_CLIENT_ID", "test-client-id-1234");
    std::env::set_var("LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL", "http://127.0.0.1:1/device");
    std::env::set_var("LIGHTHOUSE_SIGNIN_TOKEN_URL", "http://127.0.0.1:1/token");
    assert!(
        pa::signin_config().is_none(),
        "three of four identifiers must NOT arm the flow"
    );

    // --- Phase 1: a maintainer configures all four values (at the mock). --
    let (base, log) = spawn_vendor();
    std::env::set_var("LIGHTHOUSE_SIGNIN_CLIENT_ID", "test-client-id-1234");
    std::env::set_var("LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL", format!("{base}/device"));
    std::env::set_var("LIGHTHOUSE_SIGNIN_TOKEN_URL", format!("{base}/token"));
    std::env::set_var("LIGHTHOUSE_SIGNIN_API_BASE", format!("{base}/v1"));
    let cfg = pa::signin_config().expect("all four values ⇒ configured");
    assert_eq!(cfg.client_id, "test-client-id-1234");
    let st = pa::status();
    assert!(st.available && !st.signed_in);

    // --- Phase 2: method "signin" chosen but NOT signed in ⇒ the ask fails
    // with the honest reason and NEVER falls back to a stored API key. ----
    lighthouse_core::settings::set_openai_auth_method("signin");
    let out = rt.block_on(collect_answer(openai_cfg(Some("sk-should-never-be-sent"))));
    assert!(
        out.contains("OpenAI sign-in unavailable — not signed in"),
        "signed-out ask must carry the honest reason: {out}"
    );
    assert!(
        out.contains("falling back to local passages"),
        "and answer from local passages: {out}"
    );
    assert_eq!(chat_requests(&log), 0, "no chat request may fire signed-out");
    assert!(
        !log.lock().unwrap().iter().any(|r| r.contains("sk-should-never-be-sent")),
        "the stored API key must never ride a sign-in-mode ask"
    );

    // --- Phase 3: start → codes; poll: pending → slow_down (+5 s) → done. -
    let flow = rt.block_on(pa::start()).expect("device authorization starts");
    assert_eq!(flow.user_code, "WDJB-MJHT");
    assert_eq!(flow.verification_uri, format!("{base}/verify"));
    assert_eq!(flow.interval_ms, 1000);
    assert_eq!(flow.expires_in_ms, 600_000);
    {
        let reqs = log.lock().unwrap();
        let device_req = reqs
            .iter()
            .find(|r| r.starts_with("POST /device"))
            .expect("device-authorization request sent");
        assert!(device_req.contains("client_id=test-client-id-1234"));
        assert!(device_req.contains("scope=openid+profile"));
    }
    match rt.block_on(pa::poll_once()).unwrap() {
        pa::Poll::Pending { interval_ms } => assert_eq!(interval_ms, 1000),
        other => panic!("first poll must be pending, got {other:?}"),
    }
    match rt.block_on(pa::poll_once()).unwrap() {
        // RFC 8628 §3.5: slow_down bumps the interval by 5 seconds.
        pa::Poll::Pending { interval_ms } => assert_eq!(interval_ms, 6000),
        other => panic!("slow_down must stay pending, got {other:?}"),
    }
    match rt.block_on(pa::poll_once()).unwrap() {
        pa::Poll::Complete { account } => {
            assert_eq!(account.as_deref(), Some("maintainer@example.com"))
        }
        other => panic!("third poll must complete, got {other:?}"),
    }
    let device_grants = log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.contains("device_code=dev-code-1"))
        .count();
    assert_eq!(device_grants, 3, "three token polls carried the device code");

    // Sealed at rest: entries present, plaintext ABSENT from the store file.
    assert_eq!(
        lighthouse_core::secrets::get_provider_key("openai-signin:access").as_deref(),
        Some("at-1")
    );
    assert_eq!(
        lighthouse_core::secrets::get_provider_key("openai-signin:refresh").as_deref(),
        Some("rt-1")
    );
    let expiry: i64 = lighthouse_core::secrets::get_provider_key("openai-signin:expiry")
        .expect("expiry sealed")
        .parse()
        .expect("expiry is epoch ms");
    assert!(expiry > lighthouse_core::config::now_ms());
    assert_eq!(
        lighthouse_core::secrets::get_provider_key("openai-signin:account").as_deref(),
        Some("maintainer@example.com")
    );
    let raw_store = std::fs::read_to_string(dir.path().join("secrets.json")).unwrap();
    assert!(
        !raw_store.contains("at-1") && !raw_store.contains("rt-1"),
        "tokens must be sealed, never plaintext on disk"
    );
    let st = pa::status();
    assert!(st.available && st.signed_in);
    assert_eq!(st.account.as_deref(), Some("maintainer@example.com"));
    assert!(st.expires_ms.is_some());

    // --- Phase 4: a fresh access token is used as-is (no refresh call). ---
    let token_calls_before = log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.starts_with("POST /token"))
        .count();
    assert_eq!(rt.block_on(pa::ensure_fresh_access()).unwrap(), "at-1");
    let token_calls_after = log
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.starts_with("POST /token"))
        .count();
    assert_eq!(token_calls_before, token_calls_after, "no refresh while fresh");

    // --- Phase 5: within 5 min of expiry ⇒ refresh, and ROTATE the stored
    // refresh token because the response carried a new one. ---------------
    lighthouse_core::secrets::set_provider_key(
        "openai-signin:expiry",
        &(lighthouse_core::config::now_ms() + 60_000).to_string(),
    );
    assert_eq!(rt.block_on(pa::ensure_fresh_access()).unwrap(), "at-2");
    assert_eq!(
        lighthouse_core::secrets::get_provider_key("openai-signin:refresh").as_deref(),
        Some("rt-2"),
        "rotated refresh token must replace the stored one"
    );
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("grant_type=refresh_token") && r.contains("refresh_token=rt-1")),
        "the refresh grant carried the previous refresh token"
    );

    // --- Phase 6: the signed-in ask — the REAL stream_answer through the
    // mock api_base: existing chat-completions dialect, bearer swapped in. -
    let out = rt.block_on(collect_answer(openai_cfg(None)));
    assert!(out.contains("Hello world"), "mock deltas must stream through: {out}");
    assert_eq!(chat_requests(&log), 1);
    {
        let reqs = log.lock().unwrap();
        let chat = reqs
            .iter()
            .find(|r| r.starts_with("POST /v1/chat/completions"))
            .expect("chat request hit the configured api_base");
        let lower = chat.to_lowercase();
        assert!(
            lower.contains("authorization: bearer at-2"),
            "the ask must ride the OAuth access token"
        );
        assert!(chat.contains("\"model\":\"test-model\""), "settings model used");
        assert!(
            chat.contains("max_completion_tokens"),
            "openai dialect knobs (token-cap param) reused"
        );
        assert!(
            chat.contains("the quarterly total is 42"),
            "retrieved context rides exactly like the keyed path"
        );
    }
    // Egress ledger: the CONFIGURED hosts under the two sign-in purposes.
    let egress = lighthouse_core::egress::snapshot().to_string();
    assert!(egress.contains("Provider sign-in"), "auth calls recorded: {egress}");
    assert!(egress.contains("Signed-in ask"), "signed-in ask recorded: {egress}");
    assert!(!egress.contains("at-1") && !egress.contains("at-2"), "no tokens in the ledger");

    // --- Phase 7: method "key" (the default path) is untouched — with no
    // key on file the engine answers extractively and dials NOTHING new. --
    lighthouse_core::settings::set_openai_auth_method("key");
    let out = rt.block_on(collect_answer(openai_cfg(None)));
    assert!(
        out.contains("Connect an AI model"),
        "keyless key-method ask keeps the stock fallback: {out}"
    );
    assert_eq!(chat_requests(&log), 1, "no new chat request on the key path");

    // --- Phase 8: signout drops every sealed entry. -----------------------
    pa::signout();
    for key in [
        "openai-signin:access",
        "openai-signin:refresh",
        "openai-signin:expiry",
        "openai-signin:account",
    ] {
        assert_eq!(lighthouse_core::secrets::get_provider_key(key), None, "{key} cleared");
    }
    assert!(!pa::status().signed_in);
    let err = rt.block_on(pa::ensure_fresh_access()).unwrap_err();
    assert!(err.contains("not signed in"), "honest signed-out reason: {err}");
    assert!(!err.contains("at-") && !err.contains("rt-"), "no token in errors: {err}");

    // --- Phase 9: a DEAD refresh grant signs the session out with an honest
    // reason that never embeds the token literal. --------------------------
    lighthouse_core::secrets::set_provider_key("openai-signin:access", "at-9");
    lighthouse_core::secrets::set_provider_key("openai-signin:refresh", "rt-9");
    lighthouse_core::secrets::set_provider_key(
        "openai-signin:expiry",
        &(lighthouse_core::config::now_ms() - 1000).to_string(),
    );
    let err = rt.block_on(pa::ensure_fresh_access()).unwrap_err();
    assert_eq!(err, "grant is revoked", "the vendor's honest reason surfaces");
    assert!(!err.contains("rt-9") && !err.contains("at-9"), "no token in errors: {err}");
    assert!(!pa::status().signed_in, "a dead grant drops the session");
    assert_eq!(
        lighthouse_core::secrets::get_provider_key("openai-signin:refresh"),
        None
    );

    // Env hygiene for any test binary that follows this one.
    for v in SIGNIN_ENVS {
        std::env::remove_var(v);
    }
    std::env::remove_var("LIGHTHOUSE_SETTINGS_FILE");
    std::env::remove_var("LIGHTHOUSE_APP_STATE_DIR");
}
