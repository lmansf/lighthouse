"use client";

import { useEffect } from "react";
import { useRagStore } from "@/stores/useRagStore";
import { isDesktopShell } from "./desktopBridge";

/**
 * Keeps the shared engine status loaded and live for the window that mounts
 * it: one initial load, a background poll, focus/visibility ticks, and the
 * shell's `lighthouse:vault-changed` push. What it loads is `useRagStore`'s
 * three signals — what this build can do, the managed-policy locks, and the
 * session egress figure the header shield renders.
 *
 * This was `useVaultTree` until 0.15.0, when the tree it polled went with the
 * vault (openspec: refocus-chat-attachments). A conversation's attachments are
 * chat state, so nothing here has to poll them.
 *
 * Extracted from AppShell so secondary windows (the desktop search widget)
 * reuse the exact same freshness semantics WITHOUT also mounting the launch
 * ping or the global keyboard shortcuts — those are per-app singletons, and a
 * second webview mounting them would double-count (docs/widget-scope.md §2.4).
 */
export function useEngineStatus(): void {
  const load = useRagStore((s) => s.load);
  const setEngineUnreachable = useRagStore((s) => s.setEngineUnreachable);

  useEffect(() => {
    // A transient backend/IPC failure must not crash the poll loop or surface
    // an unhandled rejection; log and let the next tick recover. But a
    // SUSTAINED failure must become visible (§57): console-only meant a total
    // outage just rendered as an empty app, which is what shipped in
    // 0.14.18/0.14.19. One miss stays quiet; three in a row raise the banner.
    const FAILURES_BEFORE_VISIBLE = 3;
    let consecutiveFailures = 0;
    const refresh = () => {
      void load()
        .then(() => {
          consecutiveFailures = 0;
          setEngineUnreachable(false);
        })
        .catch((err) => {
          consecutiveFailures += 1;
          console.error("Failed to reach the engine", err);
          if (consecutiveFailures >= FAILURES_BEFORE_VISIBLE) setEngineUnreachable(true);
        });
    };
    refresh();
    // Inside the desktop shell the engine PUSHES changes via
    // `lighthouse:vault-changed` (the event name predates 0.15.0 and is kept so
    // an older webview still listens), so the poll is only a slow safety net
    // there; on the web there is no push channel and the 4 s poll does the work.
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
  }, [load, setEngineUnreachable]);
}
