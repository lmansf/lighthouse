/**
 * In-memory session egress registry — the dev twin of
 * native/crates/lighthouse-core/src/egress.rs (KEEP IN SYNC; the purpose
 * labels are byte-identical — they render in the panel). Every outbound
 * fetch in src/server reports through recordEgress() just before dialing;
 * the UI shield renders egressSnapshot(). Host + purpose + count + last time
 * only — NEVER content, questions, file names, or full URLs. Session memory
 * only.
 */

export const PURPOSE_AI_PROVIDER = "AI provider";
export const PURPOSE_LICENSE = "License & trial";
export const PURPOSE_TELEMETRY = "Telemetry";
export const PURPOSE_CHECKOUT = "Checkout";
export const PURPOSE_UPDATE_CHECK = "Update check";
export const PURPOSE_UPDATE_DOWNLOAD = "Update download";
export const PURPOSE_MODEL_DOWNLOAD = "Model download";
export const PURPOSE_SHAREPOINT = "SharePoint / OneDrive";

interface Entry {
  count: number;
  lastMs: number;
}

// Keyed by host + purpose. The separator is a newline: it appears in neither
// a host nor a purpose label, and purposes contain spaces so a space would
// split wrong.
const registry = new Map<string, Entry>();

/** Reduce a URL or host string to its bare host (drop scheme/path/port). */
function hostOf(input: string): string {
  let s = input.trim();
  const schemeIdx = s.indexOf("://");
  if (schemeIdx >= 0) s = s.slice(schemeIdx + 3);
  s = s.split("/")[0] ?? s;
  const at = s.lastIndexOf("@"); // never keep userinfo
  if (at >= 0) s = s.slice(at + 1);
  return (s.split(":")[0] ?? s).toLowerCase();
}

/** Report one outbound request about to be made. */
export function recordEgress(hostOrUrl: string, purpose: string): void {
  const host = hostOf(hostOrUrl);
  if (!host) return;
  const key = `${host}\n${purpose}`;
  const e = registry.get(key) ?? { count: 0, lastMs: 0 };
  e.count += 1;
  e.lastMs = Date.now();
  registry.set(key, e);
}

/** The panel payload; `{ total: 0, destinations: [] }` renders "All local". */
export function egressSnapshot(): {
  total: number;
  destinations: { host: string; purpose: string; count: number; lastAt: number }[];
} {
  const rows = [...registry.entries()].map(([key, e]) => {
    const nl = key.indexOf("\n");
    return {
      host: key.slice(0, nl),
      purpose: key.slice(nl + 1),
      count: e.count,
      lastAt: e.lastMs,
    };
  });
  rows.sort((a, b) => b.lastAt - a.lastAt);
  return { total: rows.reduce((n, r) => n + r.count, 0), destinations: rows };
}

/** Test seam: clear the session registry. */
export function resetEgressForTests(): void {
  registry.clear();
}
