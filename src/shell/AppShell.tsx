"use client";

import { useEffect, useState } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { useRagStore } from "@/stores/useRagStore";
import { Sidebar } from "./Sidebar";
import { isDesktopShell } from "./desktopBridge";
import { StartupPrompt } from "@/features/startup/StartupPrompt";
import { useUsageCapture } from "@/features/usage/useUsageCapture";

const useStyles = makeStyles({
  root: {
    display: "flex",
    height: "100vh",
    width: "100vw",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  main: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
});

interface AppShellProps {
  /** The collapsible left sidebar — the file explorer. */
  sidebar: React.ReactNode;
  /** The primary workspace, front and center — the chat panel. */
  main: React.ReactNode;
}

/**
 * The application frame: a collapsible file sidebar + a front-and-center
 * workspace (chat). Owned by the shell team. It also kicks the one-time RAG
 * data load so every feature sees populated stores on first paint.
 */
export function AppShell({ sidebar, main }: AppShellProps) {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(false);
  const load = useRagStore((s) => s.load);

  // Capture coarse UI interactions for best-effort usage logging (consent-gated
  // inside the hook). Mounted here so it covers the whole post-onboarding app.
  useUsageCapture();

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

  // Global keyboard shortcuts (documented in the Quick start guide):
  // Ctrl/Cmd+N — new chat · Ctrl/Cmd+B — toggle the file sidebar ·
  // Ctrl/Cmd+, — open Preferences. Features receive them as CustomEvents so
  // the shell stays decoupled from feature internals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const fire = (name: string) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(name));
      };
      if (e.key === "n" || e.key === "N") fire("lighthouse:new-chat");
      else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        setCollapsed((c) => !c);
      } else if (e.key === ",") fire("lighthouse:open-preferences");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className={styles.root}>
      <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)}>
        {sidebar}
      </Sidebar>
      <div className={styles.main}>{main}</div>
      <StartupPrompt />
    </main>
  );
}
