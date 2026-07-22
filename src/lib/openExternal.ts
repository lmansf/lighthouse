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
 */
import { isDesktopShell } from "@/shell/desktopBridge";

export function openExternal(url: string): void {
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
