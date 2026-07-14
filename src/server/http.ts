/** Shared HTTP helpers for the local API routes. */

/**
 * Authorize a mutating request to the local API.
 *
 * The server binds to 127.0.0.1 only, but other processes/users on the same
 * machine can still reach the port and a rebound DNS name can still resolve to
 * loopback, so authorization is layered:
 *
 *   1. Host allowlist — the request's own host must be a loopback host. Defeats
 *      DNS rebinding (a page on evil.com rebound to 127.0.0.1 sends Host: evil.com).
 *   2. Origin present → require it to be a loopback host on the SAME PORT. We do
 *      NOT require an exact host-string match, because Next's `req.url` host can be
 *      "localhost" even when the renderer reached the server via "127.0.0.1" — an
 *      exact match wrongly 403s the app's own same-origin requests. Loopback host +
 *      matching port still blocks cross-site POSTs (their Origin is not loopback).
 *   3. Origin absent → a non-browser caller (the desktop shell, curl, or
 *      another local process). Require the per-launch shared secret the desktop
 *      shell injects via LIGHTHOUSE_API_TOKEN.
 *   4. No token configured (plain `next dev`/`next start` outside the desktop
 *      shell) → allow header-less requests so local development keeps working.
 *
 * Kept named `isSameOrigin` for continuity with existing route call-sites.
 */
export function isSameOrigin(req: Request): boolean {
  const reqUrl = safeUrl(req.url);
  // (1) DNS-rebinding defense: only ever answer as a loopback host.
  if (!reqUrl || !isLoopbackHost(reqUrl.hostname)) return false;

  const origin = req.headers.get("origin");
  if (origin) {
    // (2) Same-origin for a loopback server: loopback host + same port. (Not an
    // exact host match — see the doc comment; localhost vs 127.0.0.1 must both pass.)
    const o = safeUrl(origin);
    return o !== null && isLoopbackHost(o.hostname) && o.port === reqUrl.port;
  }

  // (3) Header-less caller — require the injected token.
  const token = process.env.LIGHTHOUSE_API_TOKEN;
  if (!token) return true; // (4) dev / no desktop shell: preserve prior behavior
  const provided = req.headers.get("x-lighthouse-token");
  return provided != null && timingSafeEqual(provided, token);
}

/** Parse a URL, or null if unparseable. */
function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** True for loopback hostnames: 127.0.0.0/8, ::1, or localhost. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase(); // unwrap IPv6 brackets
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Length-checked constant-time string comparison so the token can't be probed
 *  byte-by-byte via response timing. (Token length is fixed, so comparing lengths
 *  first leaks nothing sensitive.) */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
