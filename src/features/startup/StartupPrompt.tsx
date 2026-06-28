"use client";

/**
 * One-time "run Lighthouse at startup?" prompt (issue #29). The first time a
 * desktop user reaches the app, we ask whether to launch at login (default on)
 * and record the answer so it never asks again. The Electron main process reads
 * the resulting preference on its next launch. No-op on the web build.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Switch,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  body: { color: tokens.colorNeutralForeground2 },
});

export function StartupPrompt() {
  const styles = useStyles();
  const desktop = useRagStore((s) => s.desktop);
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  // Guard so a dismiss + the Save button can't both POST.
  const persisted = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/settings");
        const d = await r.json();
        if (!cancelled && d.desktop && !d.startupAsked) {
          setOn(d.runOnStartup !== false);
          setOpen(true);
        }
      } catch {
        /* settings unavailable — just don't prompt */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  async function persist(runOnStartup: boolean) {
    if (persisted.current) return;
    persisted.current = true;
    setBusy(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runOnStartup, startupAsked: true }),
    }).catch(() => {});
    setBusy(false);
    setOpen(false);
  }

  if (!desktop) return null;

  return (
    <Dialog
      open={open}
      // Dismissing (Esc / click-away) still records the current choice so the
      // prompt doesn't reappear next launch.
      onOpenChange={(_, d) => {
        if (!d.open) void persist(on);
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Open Lighthouse at startup?</DialogTitle>
          <DialogContent>
            <div className={styles.content}>
              <Text className={styles.body}>
                Lighthouse can open automatically when you sign in to your computer, so
                your vault is always ready in the background. You can change this anytime.
              </Text>
              <Switch
                checked={on}
                onChange={(_, d) => setOn(Boolean(d.checked))}
                label="Open Lighthouse when I sign in"
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => void persist(on)}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
