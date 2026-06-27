/** Shared HTTP helpers for the local API routes. */

/**
 * Reject cross-origin mutating requests. When an Origin header is present and
 * its host differs from the request host, the request is treated as forged.
 * Requests without an Origin (same-origin fetch, curl) are allowed.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
