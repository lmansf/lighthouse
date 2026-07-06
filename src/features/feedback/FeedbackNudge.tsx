"use client";

/**
 * A gentle feedback nudge. After the user has actively used Lighthouse for a
 * few minutes (counting only time the window is visible), a small non-invasive
 * bubble slides up in the bottom-left corner asking "What do you think so
 * far?". Expanding it opens a single-question feature-interest vote (which
 * shelved features they'd use) rather than a long survey.
 *
 * Persistence semantics: only a SUBMITTED form sets the permanent shown flag
 * (never ask again). Dismissing the bubble or "Maybe later" merely snoozes —
 * a snoozedUntil timestamp a few days out — so a "not right now" doesn't
 * silently discard the user's only chance to be asked.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { ChatSparkleRegular, DismissRegular } from "@fluentui/react-icons";
import { FeatureInterestVote } from "@/features/feedback/FeatureInterestVote";

/** Active (window-visible) time before the nudge surfaces. */
const NUDGE_AFTER_MS = 5 * 60 * 1000;
/** localStorage key — set only when feedback was SUBMITTED; never ask again. */
const SHOWN_KEY = "lighthouse.feedbackNudge.shown";
/** localStorage key — epoch ms until which a dismissed/"maybe later" nudge sleeps. */
const SNOOZED_UNTIL_KEY = "lighthouse.feedbackNudge.snoozedUntil";
/** How long a snooze lasts — long enough to not nag, short enough to still ask. */
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

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
    // Feedback already submitted on this install, or the nudge is snoozed into
    // the future? Stay quiet. (getItem(null) → Number(null) is 0 → not snoozed.)
    try {
      if (localStorage.getItem(SHOWN_KEY)) return;
      const snoozedUntil = Number(localStorage.getItem(SNOOZED_UNTIL_KEY));
      if (Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) return;
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
        // Another modal is up (quick-start tour, bug report, a dialog) —
        // don't pile a second interruption on top; retry next tick.
        if (document.querySelector(".fui-DialogSurface")) return;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        // Nothing is persisted at surface time — only the user's response
        // (submit ⇒ permanent flag, dismiss/"maybe later" ⇒ snooze) decides.
        setVisible(true);
      }
    }, 15 * 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /** "Not right now" (bubble ✕, dialog dismiss, "Maybe later"): sleep a few days. */
  function snooze() {
    try {
      localStorage.setItem(SNOOZED_UNTIL_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* best effort */
    }
    setOpen(false);
    setVisible(false);
  }

  /** Feedback submitted: record the permanent flag so we never ask again. */
  function complete() {
    try {
      localStorage.setItem(SHOWN_KEY, "1");
      localStorage.removeItem(SNOOZED_UNTIL_KEY); // moot once permanently done
    } catch {
      /* best effort */
    }
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
            onClick={snooze}
          />
        </div>
      )}

      {/* Esc / click-away is a "not now", not a "never" — snooze, don't burn. */}
      <Dialog open={open} onOpenChange={(_, d) => !d.open && snooze()}>
        <DialogSurface>
          <DialogBody>
            <DialogContent>
              <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM }}>
                <FeatureInterestVote onDone={complete} />
                <Button appearance="subtle" onClick={snooze}>
                  Maybe later
                </Button>
              </div>
            </DialogContent>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
