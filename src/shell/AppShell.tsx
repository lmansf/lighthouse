"use client";

import { useEffect } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { useRagStore } from "@/stores/useRagStore";
import { LeftRail } from "./LeftRail";

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
    padding: tokens.spacingHorizontalL,
    overflow: "hidden",
  },
});

interface AppShellProps {
  /**
   * Rendered inside the fixed left rail. Hosts onboarding before the user is
   * set up, then the Ask/chat panel afterwards.
   */
  rail: React.ReactNode;
  /** The primary workspace, filling the rest of the screen - the file explorer. */
  content: React.ReactNode;
}

/**
 * The application frame: a fixed left rail + a full-bleed workspace. Owned by
 * the shell team. It also kicks the one-time RAG data load so every feature
 * sees populated stores on first paint.
 */
export function AppShell({ rail, content }: AppShellProps) {
  const styles = useStyles();
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
    // Keep the tree live: re-read the vault on an interval and whenever the
    // window regains focus, so files added *outside* an in-app upload — copied
    // into the vault folder directly, or via a native dialog — appear without a
    // manual reload. Polling (a fresh scan) is used rather than fs.watch, which
    // is unreliable on Windows/WSL-mounted and network paths.
    const POLL_MS = 4000;
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  return (
    <main className={styles.root}>
      <LeftRail>{rail}</LeftRail>
      <div className={styles.main}>{content}</div>
    </main>
  );
}
