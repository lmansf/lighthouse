/** Shared HTTP helpers for the local API routes. */

/**
 * Authorize a mutating request to the local API.
 *
 * The server binds to 127.0.0.1 only, but other processes/users on the same
 * machine can still reach the port and a rebound DNS name can still resolve to
 * loopback, so authorization is layered:
 *
 *   1. Host allowlist — the request's own Host must be a loopback host. This
 *      defeats DNS rebinding (a page on evil.com rebound to 127.0.0.1 sends
 *      Host: evil.com, which is rejected here regardless of Origin).
 *   2. Origin present → require it to be same-origin. Blocks browser CSRF and
 *      cross-site POSTs (a malicious page always sends an Origin).
 *   3. Origin absent → a non-browser caller (the Electron main process, curl,
 *      another local process). Require the per-launch shared secret the desktop
 *      shell injects via LIGHTHOUSE_API_TOKEN, closing the old "no Origin ⇒
 *      allowed" bypass.
 *   4. No token configured (plain `next dev`/`next start` outside the desktop
 *      shell) → allow header-less requests so local development keeps working.
 *
 * Kept named `isSameOrigin` for continuity with existing route call-sites; it now
 * enforces the loopback Host allowlist and honors the desktop token too.
 */
export function isSameOrigin(req: Request): boolean {
  const reqHost = hostOf(req.url);
  // (1) DNS-rebinding defense: only ever answer as a loopback host.
  if (reqHost === null || !isLoopbackHost(reqHost)) return false;

  const origin = req.headers.get("origin");
  if (origin) {
    // (2) Same-origin (compares host + port).
    const originHost = hostOf(origin);
    return originHost !== null && originHost === reqHost;
  }

  // (3) Header-less caller — require the injected token.
  const token = process.env.LIGHTHOUSE_API_TOKEN;
  if (!token) return true; // (4) dev / no desktop shell: preserve prior behavior
  const provided = req.headers.get("x-lighthouse-token");
  return provided != null && timingSafeEqual(provided, token);
}

/** The `host` (hostname + optional port) of a URL, or null if unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** True for loopback hosts (ignores port): 127.0.0.0/8, ::1, or localhost. */
function isLoopbackHost(host: string): boolean {
  let hostname = host;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    /* fall back to the raw host string */
  }
  hostname = hostname.replace(/^\[|\]$/g, "").toLowerCase(); // unwrap IPv6 brackets
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
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
