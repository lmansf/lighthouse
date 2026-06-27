"use client";

import { useEffect, useState } from "react";
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
   * Rendered inside the collapsible left rail. Hosts onboarding before the
   * user is set up, then the Ask/chat panel afterwards.
   */
  rail: React.ReactNode;
  /** The primary workspace, filling the rest of the screen - the file explorer. */
  content: React.ReactNode;
}

/**
 * The application frame: a collapsible left rail + a full-bleed workspace.
 * Owned by the shell team. It also kicks the one-time RAG data load so every
 * feature sees populated stores on first paint.
 */
export function AppShell({ rail, content }: AppShellProps) {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(false);
  const load = useRagStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className={styles.root}>
      <LeftRail collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)}>
        {rail}
      </LeftRail>
      <div className={styles.main}>{content}</div>
    </main>
  );
}
