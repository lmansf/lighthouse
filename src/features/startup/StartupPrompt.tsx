"use client";

/**
 * One-time "run Lighthouse at startup?" prompt (issue #29). We ask a desktop
 * user whether to launch at login (default on) and record the answer so it
 * never asks again. The Electron main process reads the resulting preference
 * on its next launch. No-op on the web build.
 *
 * The ask is DEFERRED: interrupting someone's very first seconds in the app
 * with an OS-integration question is jarring, so we wait until they've had
 * ~2.5 minutes of window-visible use (same visible-time pattern as
 * FeedbackNudge) before asking. Persistence semantics are unchanged.
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

/** Active (window-visible) time before the startup question is asked. */
const PROMPT_AFTER_MS = 2.5 * 60 * 1000;

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
  // Accumulated active (visible) milliseconds and the timestamp the current
  // visible stretch began. Refs so the interval reads fresh values without
  // re-subscribing (mirrors FeedbackNudge).
  const activeMs = useRef(0);
  const since = useRef<number | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;

    since.current = document.hidden ? null : Date.now();

    const onVisibility = () => {
      if (document.hidden) {
        if (since.current != null) {
          activeMs.current += Date.now() - since.current;
          since.current = null;
        }
      } else if (since.current == null) {
        since.current = Date.now();
      }
    };

    const timer = setInterval(() => {
      const live = since.current != null ? Date.now() - since.current : 0;
      if (activeMs.current + live < PROMPT_AFTER_MS) return;
      // Another modal is up (quick-start tour, feedback, a dialog) — don't
      // stack a second one; retry next tick.
      if (document.querySelector(".fui-DialogSurface")) return;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      // Fetch at ask time (not mount) so the switch reflects the freshest
      // runOnStartup value, and an already-answered question stays quiet.
      void (async () => {
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
    }, 15 * 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
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
