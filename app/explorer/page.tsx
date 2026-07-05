"use client";

import { useEffect } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { useLicenseStore, isLocked } from "@/stores/useLicenseStore";
import { useVaultTree } from "@/shell/useVaultTree";
import { invokeShell } from "@/features/widget/WidgetBar";

/**
 * The standalone vault-explorer window (Tauri label "explorer", route
 * /explorer — the widget's 📁 button; docs/widget-scope.md §7 W2). Mounts the
 * SAME FileExplorer as the main sidebar — same stores, same eye toggles, same
 * live freshness via useVaultTree — in its own decorated window, so widget
 * users can curate what the AI sees without opening the full app.
 *
 * Quiet like the widget page: nothing from app/page.tsx (launch ping, usage
 * publish, nudges, version badge) mounts here — a third webview running those
 * would double-count telemetry (widget-scope §2.4). License is re-checked on
 * every window focus: curation is a paid surface, and the trial can lapse
 * while the window sits open.
 */

const useStyles = makeStyles({
  root: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  explorer: { flex: 1, minHeight: 0 },
  lockBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorStatusWarningBackground1,
    borderBottom: `1px solid ${tokens.colorStatusWarningBorder1}`,
  },
});

export default function ExplorerPage() {
  const styles = useStyles();
  useVaultTree();

  const status = useLicenseStore((s) => s.status);
  const check = useLicenseStore((s) => s.check);
  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);
  const locked = isLocked(status);

  return (
    <div className={styles.root}>
      {locked && (
        <div className={styles.lockBar}>
          <Text size={200}>Your trial has ended — the vault is read-only from here.</Text>
          <Button size="small" appearance="primary" onClick={() => void invokeShell("show_main")}>
            Open Lighthouse
          </Button>
        </div>
      )}
      {/* Same greyed-inert treatment the main window gives a locked vault. */}
      <div
        className={styles.explorer}
        {...(locked ? { "aria-hidden": true, inert: true } : {})}
        style={locked ? { filter: "grayscale(1)", opacity: 0.45, pointerEvents: "none" } : undefined}
      >
        <FileExplorer />
      </div>
    </div>
  );
}
