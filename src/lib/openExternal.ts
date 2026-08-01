"use client";

/**
 * §33 §2: the ONE seam for opening anything OUTSIDE the app — https:// in the
 * OS browser, mailto: in the mail client. Inside the Tauri shell the webview's
 * own window.open is not a reliable escape (on iOS it silently does nothing —
 * the 0.14.x field report behind this file), so the shell path routes through
 * tauri-plugin-opener's `open_url` command (registered in lib.rs; the
 * capability set grants opener:allow-open-url), which hands the URL to the OS
 * (Safari / Mail on iOS, the default browser elsewhere). Plain web keeps the
 * ordinary window.open fallback.
 *
 * EVERY external-open call site routes through here — BugReport's handoffs,
 * the settings surfaces, answer links — pinned by test/openExternal.test.mjs
 * (no bare window.open outside this file and reportExport's blank print
 * shell, which opens a document the app composes, not an external URL).
 *
 * Being the one seam, it is also the one place that can REFUSE. Both rules are
 * decided BEFORE a transport is chosen, so neither the plugin route nor the
 * window.open fallback can carry a destination the other would have refused:
 *
 * 1. Scheme allowlist — `https:` and `mailto:`, nothing else. `javascript:`,
 *    `data:`, `file:`, `blob:`, a scheme-relative `//host`, an unparseable
 *    string: refused.
 * 2. Provenance, passed as an ARGUMENT by the call site — never sniffed off
 *    the URL, which is the attacker-shaped half. `"app"` means the app itself
 *    composed the destination (the feedback handoffs, the repo link).
 *    Everything else is UNTRUSTED — an href out of answer HTML, a URI out of a
 *    remote sign-in response — and that is also what a call site that says
 *    nothing gets: `https:` only, and the user must first agree to a prompt
 *    NAMING THE HOST.
 *
 * Why (red-team High, "answer links reach the OS browser with no allowlist"):
 * ANSWER_HTML_SCHEMA drops the remote-LOADING tags, so an answer cannot fetch
 * on its own — but `a[href]` stays navigable and ChatPanel forwards every
 * non-citation href here, so prompt-injected document content could render an
 * ordinary-looking link whose query string carries figures out of OTHER files
 * in the same context. One click, no cloud provider needed, and local-only
 * marks do not cover it. The offline export path (evidencePack.ts) emits no
 * href at all; the live path must not be laxer than the export path.
 */
import { isDesktopShell } from "@/shell/desktopBridge";

/** Who chose this destination — see rule 2 above. Default: untrusted. */
export type LinkOrigin = "app" | "untrusted";

/** The only schemes this seam serves (`mailto:` for app-composed mail only). */
const ALLOWED_PROTOCOLS = new Set(["https:", "mailto:"]);

export function openExternal(url: string, origin: LinkOrigin = "untrusted"): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // not a URL at all (or scheme-relative) — refuse
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return;
  // Hand the transports the string the seam VALIDATED, not the raw one: the
  // OS-side openers split the authority per RFC 3986 (backslash is not a
  // delimiter there), so `https://github.com\@evil.example/` parses as host
  // github.com here and as host evil.example there — the prompt would name
  // one host and the browser would open another.
  url = parsed.href;
  if (origin !== "app") {
    // Untrusted: `https:` only (a mailto carries no host to name), and the
    // user sees that host and agrees before anything leaves. `confirm` is the
    // one synchronous consent primitive at this seam; where the webview does
    // not implement it (the WKWebView checklist in docs/CONVENTIONS.md — some
    // web APIs there silently do nothing) the answer is NO.
    if (parsed.protocol !== "https:") return;
    if (typeof window.confirm !== "function") return;
    const agreed = window.confirm(
      `Open ${parsed.hostname}?\n\n` +
        "This link came from content Lighthouse didn't write — an answer, a " +
        "document, or a sign-in reply. The address itself can carry text from " +
        "your files to that site.",
    );
    if (!agreed) return;
  }
  if (isDesktopShell()) {
    // Lazy import (the tauriTransport idiom): plain-web bundles never pull the
    // Tauri API in through this seam.
    void import("@tauri-apps/api/core")
      .then((core) => core.invoke("plugin:opener|open_url", { url }))
      .catch(() => {
        // Plugin route unavailable (older shell / permission gap) — keep the
        // desktop status quo, where the shell routes _blank to the OS browser.
        window.open(url, "_blank", "noopener,noreferrer");
      });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
