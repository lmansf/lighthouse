"use client";

import { useEffect, useState } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { Sidebar } from "./Sidebar";
import { useVaultTree } from "./useVaultTree";
import { StartupPrompt } from "@/features/startup/StartupPrompt";

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
/** Remembered across launches, like the theme — a rail user shouldn't have to
 *  re-collapse the sidebar every single time they open the app. */
const SIDEBAR_COLLAPSED_KEY = "lighthouse.sidebar.collapsed";

export function AppShell({ sidebar, main }: AppShellProps) {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Persist the collapsed choice so it survives a relaunch.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage blocked — the in-session state still works */
    }
  }, [collapsed]);

  // One-time RAG data load + poll/push freshness (shared with the desktop
  // widget window via the hook — see src/shell/useVaultTree.ts).
  useVaultTree();

  // Global keyboard shortcuts (documented in the Quick start guide):
  // Ctrl/Cmd+N — new chat · Ctrl/Cmd+B — toggle the file sidebar ·
  // Ctrl/Cmd+P — quick-open a file · Ctrl/Cmd+, — open Preferences. Features
  // receive them as CustomEvents so the shell stays decoupled from feature
  // internals. AppShell mounts only in the MAIN window, so none of these fire
  // in the widget or standalone-explorer windows.
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
      } else if (e.key === "p" || e.key === "P") {
        // preventDefault deliberately shadows the browser's Print in the web
        // twin — inside the app, Ctrl/Cmd+P is the file finder.
        fire("lighthouse:quick-open");
      } else if (e.key === ",") fire("lighthouse:open-preferences");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Quick-open's Enter reveals a file in the sidebar explorer — make sure the
  // sidebar is actually open when that happens (a collapsed rail hides the
  // tree; the explorer itself stays mounted and handles the scroll + flash).
  useEffect(() => {
    const onReveal = () => setCollapsed(false);
    window.addEventListener("lighthouse:reveal-node", onReveal);
    return () => window.removeEventListener("lighthouse:reveal-node", onReveal);
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
