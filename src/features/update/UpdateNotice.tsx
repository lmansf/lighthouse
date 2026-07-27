"use client";

/**
 * "Update available — click to update", shown directly above Settings in the
 * sidebar footer once the shell's boot-time release check finds a newer
 * version. Clicking downloads this platform's installer and hands off to it
 * (Windows relaunches through the installer; macOS opens the dmg; platforms
 * without an installable asset open the releases page instead) — the
 * update_now command owns the per-platform behavior.
 *
 * Desktop-only by construction: the state arrives from the shell, either as
 * the re-broadcast boot event (lighthouse:update-state) or from the
 * update_state command at mount (the event can fire before this component
 * exists). On the web build both paths are silent, so it renders nothing.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Link, Text, Tooltip, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { IconDownload } from "@/shell/icons";
import { isDesktopShell } from "@/shell/desktopBridge";

/** Releases page — the fallback when an in-app update can't start. */
const RELEASES_URL = "https://github.com/lmansf/lighthouse/releases";

type UpdateState = {
  phase?: string;
  version?: string;
  url?: string;
  canInstall?: boolean;
};

async function invokeShell(cmd: string): Promise<unknown> {
  if (!isDesktopShell()) return undefined;
  try {
    const core = await import("@tauri-apps/api/core");
    return await core.invoke(cmd);
  } catch (err) {
    console.error(`Update shell command "${cmd}" failed`, err);
    return undefined;
  }
}

const useStyles = makeStyles({
  card: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    boxSizing: "border-box",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.border("1px", "solid", tokens.colorBrandStroke2),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    marginBottom: tokens.spacingVerticalS,
  },
  text: { flexGrow: 1, minWidth: 0 },
  // Quiet reassurance under the button: an in-place update keeps everything the
  // user cares about, so "Update & relaunch" never reads as "start over".
  reassure: { flexBasis: "100%", color: tokens.colorNeutralForeground3 },
  // Update-failure line: the reason + a link to the releases page, so a failed
  // click never looks like a dead button.
  errorRow: { flexBasis: "100%", display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  errorText: { color: tokens.colorStatusDangerForeground1 },
});

export function UpdateNotice({ collapsed }: { collapsed?: boolean }) {
  const styles = useStyles();
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Wall-clock of the last on-focus nudge — a light guard against IPC on a
  // focus storm (the shell throttle is the real ceiling).
  const lastNudge = useRef(0);

  useEffect(() => {
    // The boot event may have fired before this mounted — ask once, and keep
    // listening for the (later) live event either way.
    void invokeShell("update_state").then((s) => {
      const state = s as UpdateState | undefined;
      if (state?.phase === "available") setUpdate(state);
    });
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<UpdateState>).detail;
      if (detail?.phase === "available") setUpdate(detail);
    };
    window.addEventListener("lighthouse:update-state", onState);

    // Re-check when the app returns to the foreground, so a release that shipped
    // while it sat in the tray surfaces promptly — not only on the 6 h tick or a
    // restart ("updates that feel automatic"). The shell throttles this hard (a
    // shared 20-min clock), so it can't spam GitHub; the 60 s guard here just
    // avoids needless IPC on a focus storm. A newer release, if found, comes
    // back as an update-state event (handled above) and raises the banner — so
    // this stays useful even while the component is rendering null because no
    // update is known yet (the effect runs regardless of that early return).
    const nudge = () => {
      const now = Date.now();
      if (now - lastNudge.current < 60_000) return;
      lastNudge.current = now;
      void invokeShell("check_updates_now");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") nudge();
    };
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("lighthouse:update-state", onState);
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!update) return null;

  // Do the invoke inline (rather than via invokeShell, which swallows errors)
  // so a genuine failure surfaces instead of silently re-enabling the button.
  const install = async () => {
    setBusy(true);
    setFailed(false);
    if (!isDesktopShell()) {
      setBusy(false);
      return;
    }
    try {
      const core = await import("@tauri-apps/api/core");
      const res = (await core.invoke("update_now")) as { ok?: boolean } | undefined;
      // Windows exits into the installer before this resolves; if we're still
      // here the shell opened a dmg or the releases page — stand down.
      setBusy(false);
      if (res && res.ok === false) setUpdate(null); // fell back to the page
    } catch (err) {
      console.error('Shell command "update_now" failed', err);
      setBusy(false);
      setFailed(true);
    }
  };

  // Collapsed rail: a compact download dot so an update is never hidden behind a
  // thin sidebar.
  if (collapsed) {
    return (
      <Tooltip content={`Update to Lighthouse ${update.version}`} relationship="label">
        <Button
          size="small"
          appearance="primary"
          shape="circular"
          icon={<IconDownload />}
          aria-label={`Update to Lighthouse ${update.version}`}
          disabled={busy}
          onClick={() => void install()}
        />
      </Tooltip>
    );
  }

  return (
    <div className={styles.card}>
      <Text size={200} className={styles.text}>
        Lighthouse {update.version} is available
      </Text>
      <Button
        size="small"
        appearance="primary"
        icon={<IconDownload />}
        disabled={busy}
        onClick={() => void install()}
      >
        {busy ? "Downloading…" : update.canInstall ? "Update & relaunch" : "Get it"}
      </Button>
      {update.canInstall && !failed && (
        <Text size={100} className={styles.reassure}>
          Updates in place — your settings, files, and local model are kept.
        </Text>
      )}
      {failed && (
        <div className={styles.errorRow}>
          <Text size={200} className={styles.errorText}>
            Update couldn&apos;t start.
          </Text>
          <Link href={RELEASES_URL} target="_blank" rel="noreferrer">
            Download from Releases →
          </Link>
        </div>
      )}
    </div>
  );
}
