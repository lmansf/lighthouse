"use client";

/**
 * A gentle feedback nudge. After the user has actively used Lighthouse for a
 * few minutes (counting only time the window is visible), it asks "What do you
 * think so far?" and opens the single "Send feedback" flow (the same dialog the
 * FAB and the settings-menu item open) — which composes locally and hands off
 * to the user's own mail client or browser. The app transmits nothing.
 *
 * Presentation is mode-aware (§33 §1). DESKTOP keeps the small corner bubble —
 * now riding the same tab-bar/safe-area offset expression as the bug FAB
 * (both vars are 0 on desktop, so it is pixel-identical there; defensive for
 * any future compact-with-pill arrangement). COMPACT never renders a fixed
 * pill at all (the pre-tab-bar pill sat over the navigation): eligibility
 * instead sets a PENDING flag, and the ask presents as a small centered modal
 * only in a calm moment on the Chat tab — dwell held, no sheet, no dialog,
 * keyboard down, tour inactive, nothing streaming — decided by the pure
 * `nudgePresentVerdict` (test/feedbackNudge.test.mjs pins the truth table).
 *
 * Persistence semantics (unchanged keys): engaging (opening the feedback flow)
 * sets the permanent shown flag (never ask again). Dismissing the bubble,
 * "Maybe later", or the modal's "Not now" merely snoozes — a snoozedUntil
 * timestamp a few days out — so a "not right now" doesn't silently discard the
 * user's only chance to be asked.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconChatAI, IconClose } from "@/shell/icons";
import { LhDialogSurface } from "@/shell/controls";
import { useAnySheetOpen } from "@/shell/Sheet";
import { useShellUi } from "@/shell/shellSignals";
import { NUDGE_DWELL_MS, nudgeCalm, nudgePresentVerdict } from "./nudgeVerdict";

/** Active (window-visible) time before the nudge surfaces. */
const NUDGE_AFTER_MS = 5 * 60 * 1000;
/** localStorage key — set only when the feedback flow was OPENED; never ask again. */
const SHOWN_KEY = "lighthouse.feedbackNudge.shown";
/** localStorage key — epoch ms until which a dismissed/"maybe later" nudge sleeps. */
const SNOOZED_UNTIL_KEY = "lighthouse.feedbackNudge.snoozedUntil";
/** How long a snooze lasts — long enough to not nag, short enough to still ask. */
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/** How often the compact presenter re-checks the calm-moment gate. */
const GATE_TICK_MS = 500;

const useStyles = makeStyles({
  bubble: {
    position: "fixed",
    left: tokens.spacingHorizontalL,
    // The bug FAB's offset expression: clear of the compact tab bar (content
    // height + home-indicator inset). Both vars are 0 on desktop — where this
    // bubble actually renders — so it computes to the original bottom there.
    bottom: `calc(var(--lh-tabbar-h, 0px) + var(--lh-safe-bottom, 0px) + ${tokens.spacingVerticalL})`,
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
  modalSurface: { maxWidth: "360px" },
  modalBody: { color: tokens.colorNeutralForeground2 },
});

export function FeedbackNudge() {
  const styles = useStyles();
  // Eligibility fired (5 minutes of visible use, not shown, not snoozed).
  const [eligible, setEligible] = useState(false);
  // Desktop bubble on screen.
  const [visible, setVisible] = useState(false);
  // Compact calm-moment modal on screen.
  const [modalOpen, setModalOpen] = useState(false);
  const shell = useShellUi();
  const sheetOpen = useAnySheetOpen();
  // Accumulated active (visible) milliseconds and the timestamp the current
  // visible stretch began. Refs so the interval reads fresh values without
  // re-subscribing.
  const activeMs = useRef(0);
  const since = useRef<number | null>(null);

  useEffect(() => {
    // Feedback already opened on this install, or the nudge is snoozed into the
    // future? Stay quiet. (getItem(null) → Number(null) is 0 → not snoozed.)
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
        // Another modal is up (the first-run tour, feedback dialog, a dialog) —
        // don't pile a second interruption on top; retry next tick. The tour's
        // anchored TeachingPopover isn't a DialogSurface, so also honor its
        // body marker. (Compact re-checks all of this per present attempt via
        // the verdict, but holding eligibility itself back keeps the desktop
        // pill's long-standing behavior byte-identical.)
        if (document.querySelector(".fui-DialogSurface") || document.body.dataset.tourActive) return;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        // Nothing is persisted at surface time — only the user's response
        // (open ⇒ permanent flag, dismiss/"maybe later" ⇒ snooze) decides.
        setEligible(true);
      }
    }, 15 * 1000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // DESKTOP presentation: the corner bubble, exactly as before.
  useEffect(() => {
    if (eligible && !shell.compact) setVisible(true);
  }, [eligible, shell.compact]);

  // COMPACT presentation (§33 §1): hold the PENDING eligibility until a calm
  // moment on the Chat tab, re-checked on a slow tick; the dwell clock resets
  // whenever calm breaks, so the modal only ever fades into stillness.
  useEffect(() => {
    if (!eligible || !shell.compact || modalOpen) return;
    let dwellMs = 0;
    const tick = setInterval(() => {
      const gate = {
        compact: shell.compact,
        onChatTab: shell.activeTab === "chat",
        dwellMs,
        sheetOpen,
        dialogOpen: !!document.querySelector(".fui-DialogSurface"),
        keyboardUp: shell.keyboardUp,
        tourActive: !!document.body.dataset.tourActive,
        streaming: shell.streaming,
      };
      dwellMs = nudgeCalm(gate) ? dwellMs + GATE_TICK_MS : 0;
      if (nudgePresentVerdict({ ...gate, dwellMs })) {
        clearInterval(tick);
        setModalOpen(true);
      }
    }, GATE_TICK_MS);
    return () => clearInterval(tick);
  }, [eligible, modalOpen, sheetOpen, shell]);

  /** "Not right now" (bubble ✕ / modal "Not now"): sleep a few days. */
  function snooze() {
    try {
      localStorage.setItem(SNOOZED_UNTIL_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* best effort */
    }
    setVisible(false);
    setModalOpen(false);
    setEligible(false);
  }

  /** Open the one Send-feedback flow and record the permanent flag. */
  function openFeedback() {
    try {
      localStorage.setItem(SHOWN_KEY, "1");
      localStorage.removeItem(SNOOZED_UNTIL_KEY); // moot once permanently done
    } catch {
      /* best effort */
    }
    setVisible(false);
    setModalOpen(false);
    setEligible(false);
    window.dispatchEvent(new CustomEvent("lighthouse:open-feedback"));
  }

  // Compact: the calm-moment modal (the house Dialog — its surface already
  // fades/scales on the motion tokens, which collapse to a plain fade under
  // reduced motion). Never a fixed pill over the tab bar.
  if (shell.compact) {
    if (!modalOpen) return null;
    return (
      <Dialog
        open
        modalType="modal"
        onOpenChange={(_, d) => {
          if (!d.open) snooze(); // Esc / outside tap = "not now", never a re-nag loop
        }}
      >
        <LhDialogSurface className={styles.modalSurface} aria-label="Quick feedback">
          <DialogBody>
            <DialogTitle>What do you think so far?</DialogTitle>
            <DialogContent>
              <Text className={styles.modalBody}>
                A quick note goes straight to the maker — the app itself sends nothing.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={snooze}>
                Not now
              </Button>
              <Button appearance="primary" icon={<IconChatAI />} onClick={openFeedback}>
                Share feedback
              </Button>
            </DialogActions>
          </DialogBody>
        </LhDialogSurface>
      </Dialog>
    );
  }

  if (!visible) return null;

  return (
    <div className={styles.bubble} role="dialog" aria-label="Quick feedback">
      <Button
        className={styles.prompt}
        appearance="transparent"
        icon={<IconChatAI />}
        onClick={openFeedback}
      >
        What do you think so far?
      </Button>
      <Button
        className={styles.dismiss}
        appearance="subtle"
        icon={<IconClose />}
        aria-label="Dismiss"
        onClick={snooze}
      />
    </div>
  );
}
