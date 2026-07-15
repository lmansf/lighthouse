"use client";

import { makeStyles, tokens } from "@fluentui/react-components";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { useVaultTree } from "@/shell/useVaultTree";

/**
 * The standalone vault-explorer window (Tauri label "explorer", route
 * /explorer — the widget's 📁 button; docs/widget-scope.md §7 W2). Mounts the
 * SAME FileExplorer as the main sidebar — same stores, same eye toggles, same
 * live freshness via useVaultTree — in its own decorated window, so widget
 * users can curate what the AI sees without opening the full app.
 *
 * Quiet like the widget page: nothing from app/page.tsx (nudges, version badge)
 * mounts here — a third webview running those would double-count (widget-scope
 * §2.4). The vault is always available: Lighthouse has no accounts and no lock.
 */

const useStyles = makeStyles({
  root: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  explorer: { flex: 1, minHeight: 0 },
});

export default function ExplorerPage() {
  const styles = useStyles();
  useVaultTree();

  return (
    <div className={styles.root}>
      <div className={styles.explorer}>
        <FileExplorer />
      </div>
    </div>
  );
}
