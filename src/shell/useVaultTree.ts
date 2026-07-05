"use client";

import { useEffect } from "react";
import { useRagStore } from "@/stores/useRagStore";
import { isDesktopShell } from "./desktopBridge";

/**
 * Keeps the vault tree loaded and live for the window that mounts it: one
 * initial load, a background poll, focus/visibility ticks, and the shell's
 * `lighthouse:vault-changed` push. Extracted from AppShell so secondary
 * windows (the desktop search widget, later the vault explorer) reuse the
 * exact same freshness semantics WITHOUT also mounting usage capture, the
 * launch ping, or the global keyboard shortcuts — those are per-app
 * singletons, and a second webview mounting them would double-count
 * telemetry (see docs/widget-scope.md §2.4).
 */
export function useVaultTree(): void {
  const load = useRagStore((s) => s.load);

  useEffect(() => {
    // A transient backend/IPC failure must not crash the poll loop or surface
    // an unhandled rejection; log and let the next tick recover.
    const refresh = () => {
      void load().catch((err) => {
        console.error("Failed to refresh the vault tree", err);
      });
    };
    refresh();
    // Keep the tree live. Inside the desktop shell the engine PUSHES changes
    // (tray/menu adds, the FS watcher) via `lighthouse:vault-changed`, so the
    // poll is only a slow safety net there; on the web there is no push
    // channel and the 4 s poll does the work. Polling is a fresh scan rather
    // than fs.watch, which is unreliable on Windows/WSL-mounted and network
    // paths.
    const POLL_MS = isDesktopShell() ? 15000 : 4000;
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("lighthouse:vault-changed", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("lighthouse:vault-changed", refresh);
    };
  }, [load]);
}
