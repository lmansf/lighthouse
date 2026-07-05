//! Local-API request authorization (port of `src/server/http.ts`).
//!
//! The server binds to 127.0.0.1 only, but other local processes can still
//! reach the port and a rebound DNS name can still resolve to loopback, so
//! authorization is layered:
//!   1. Host allowlist — the request's own Host must be loopback (defeats DNS
//!      rebinding).
//!   2. Origin present → must be a loopback host on the SAME PORT.
//!   3. Origin absent → non-browser caller; require the per-launch shared
//!      secret (LIGHTHOUSE_API_TOKEN) via x-lighthouse-token.
//!   4. No token configured (plain dev outside the shell) → allow header-less.

use axum::http::HeaderMap;

/// True for loopback hostnames: 127.0.0.0/8, ::1, or localhost.
fn is_loopback_host(hostname: &str) -> bool {
    let h = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if h == "localhost" || h == "::1" {
        return true;
    }
    let mut parts = h.split('.');
    let first = parts.next();
    first == Some("127")
        && parts.clone().count() == 3
        && parts.all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Split "host:port" (tolerating a bracketed IPv6 host) into (host, port).
fn split_host_port(host: &str) -> (&str, Option<u16>) {
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let h = &rest[..end];
            let port = rest[end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse().ok());
            return (h, port);
        }
    }
    match host.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h, p.parse().ok()),
        _ => (host, None),
    }
}

/// Length-checked constant-time string comparison so the token can't be probed
/// byte-by-byte via response timing.
fn timing_safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Authorize a mutating request to the local API (see module docs).
pub fn is_same_origin(headers: &HeaderMap) -> bool {
    // (1) DNS-rebinding defense: only ever answer as a loopback host.
    let Some(host_header) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let (req_host, req_port) = split_host_port(host_header);
    if !is_loopback_host(req_host) {
        return false;
    }

    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        // (2) Same-origin for a loopback server: loopback host + same port
        // (not an exact host match — localhost vs 127.0.0.1 must both pass).
        let Ok(url) = url::Url::parse(origin) else {
            return false;
        };
        let Some(o_host) = url.host_str() else {
            return false;
        };
        let o_port = url.port_or_known_default();
        // No port in the Host header means the scheme default; the local
        // server is plain http. (PARITY: stricter than TS for the https-origin
        // no-port edge case, which cannot occur against this http server.)
        let r_port = req_port.or(Some(80));
        return is_loopback_host(o_host) && o_port == r_port;
    }

    // (3) Header-less caller — require the injected token.
    let Some(token) = std::env::var("LIGHTHOUSE_API_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
    else {
        return true; // (4) dev / no desktop shell: preserve prior behavior
    };
    headers
        .get("x-lighthouse-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| timing_safe_equal(provided, &token))
        .unwrap_or(false)
}
