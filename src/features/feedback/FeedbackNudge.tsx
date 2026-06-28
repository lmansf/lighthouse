"use client";

/**
 * A gentle, one-time feedback nudge. After the user has actively used Lighthouse
 * for a few minutes (counting only time the window is visible), a small
 * non-invasive bubble slides up in the bottom-left corner asking "What do you
 * think so far?". Expanding it opens the same feedback form used elsewhere
 * (in "mid-session" mode). It appears at most once per install — dismissing or
 * submitting records a localStorage flag so it never nags again.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ChatSparkleRegular, DismissRegular } from "@fluentui/react-icons";
import { FeedbackForm } from "@/features/license/LicenseGate";

/** Active (window-visible) time before the nudge surfaces. */
const NUDGE_AFTER_MS = 5 * 60 * 1000;
/** localStorage key — set once the nudge has been shown, so it never repeats. */
const SHOWN_KEY = "lighthouse.feedbackNudge.shown";

const useStyles = makeStyles({
  bubble: {
    position: "fixed",
    left: tokens.spacingHorizontalL,
    bottom: tokens.spacingVerticalL,
    zIndex: 900,
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    maxWidth: "320px",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
  },
  prompt: {
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    justifyContent: "flex-start",
    fontWeight: tokens.fontWeightSemibold,
  },
  dismiss: { minWidth: "auto" },
});

export function FeedbackNudge() {
  const styles = useStyles();
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  // Accumulated active (visible) milliseconds and the timestamp the current
  // visible stretch began. Refs so the interval reads fresh values without
  // re-subscribing.
  const activeMs = useRef(0);
  const since = useRef<number | null>(null);

  useEffect(() => {
    // Already shown on this install? Never nudge again.
    try {
      if (localStorage.getItem(SHOWN_KEY)) return;
    } catch {
      return; // storage blocked — don't risk nagging every load
    }

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
      if (activeMs.current + live >= NUDGE_AFTER_MS) {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        // Mark shown the moment it surfaces, so a reload mid-nudge won't repeat it.
        try {
          localStorage.setItem(SHOWN_KEY, "1");
        } catch {
          /* best effort */
        }
        setVisible(true);
      }
    }, 15 * 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  function dismiss() {
    setOpen(false);
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <>
      {!open && (
        <div className={styles.bubble} role="dialog" aria-label="Quick feedback">
          <Button
            className={styles.prompt}
            appearance="transparent"
            icon={<ChatSparkleRegular />}
            onClick={() => setOpen(true)}
          >
            What do you think so far?
          </Button>
          <Button
            className={styles.dismiss}
            appearance="subtle"
            icon={<DismissRegular />}
            aria-label="Dismiss"
            onClick={() => setVisible(false)}
          />
        </div>
      )}

      <Dialog open={open} onOpenChange={(_, d) => !d.open && dismiss()}>
        <DialogSurface>
          <DialogBody>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM }}>
                <FeedbackForm mode="mid-session" onDone={dismiss} />
                <Text
                  as="span"
                  style={{ textAlign: "center", cursor: "pointer", color: tokens.colorNeutralForeground3 }}
                  onClick={dismiss}
                >
                  Maybe later
                </Text>
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
