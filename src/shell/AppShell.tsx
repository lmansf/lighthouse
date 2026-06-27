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
    display: "grid",
    // Explorer on the left of the workspace, chat on the right.
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(360px, 1fr)",
    // Single full-height row so the panes fill the viewport, no dead space.
    gridTemplateRows: "minmax(0, 1fr)",
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingHorizontalL,
    overflow: "hidden",
  },
});

interface AppShellProps {
  /** Rendered inside the collapsible left rail (onboarding / nav). */
  rail: React.ReactNode;
  /** Primary workspace - the file explorer. */
  explorer: React.ReactNode;
  /** Secondary workspace - the chat panel. */
  chat: React.ReactNode;
}

/**
 * The application frame: collapsible rail + two-pane workspace. Owned by the
 * shell team. It also kicks the one-time RAG data load so every feature sees
 * populated stores on first paint.
 */
export function AppShell({ rail, explorer, chat }: AppShellProps) {
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
      <div className={styles.main}>
        {explorer}
        {chat}
      </div>
    </main>
  );
}
