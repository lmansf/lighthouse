"use client";

/**
 * First-run summon hint: a one-time, dismissible banner that teaches the global
 * summon shortcut. Desktop-only (there is no global hotkey on the web build),
 * shown once ever. It waits until the Quick Start tour has been seen (its flag
 * is set) so it never appears BEHIND that auto-opening modal — in practice it
 * greets the user on the launch after onboarding. It persists until the user
 * acknowledges it ("Got it" or the ✕): this banner teaches the app's signature
 * feature, so it must never blink out unread before the user notices it.
 * Dismissal is what writes the once-flag. Mirrors QuickStart's localStorage-
 * gated pattern.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { DismissRegular, SearchSparkleRegular } from "@fluentui/react-icons";
import { isDesktopShell } from "@/shell/desktopBridge";
import { prettyShortcut } from "@/features/onboarding/ModeChooser";

/** localStorage key — set on dismiss so the hint never returns. */
const SHOWN_KEY = "lighthouse.summonhint.shown";
/** The first-run tour's once-flag (written by FirstRunTour when it first
 *  appears) — we wait for it to be set so the two first-run surfaces never
 *  stack (the hint would lose behind the tour). */
const QUICKSTART_SHOWN_KEY = "lighthouse.quickstart.shown";

const useStyles = makeStyles({
  // A floating banner near the bottom-center of the screen. Sits above app
  // chrome; the pill-ish surface + shadow matches the widget's own resting look.
  banner: {
    position: "fixed",
    left: "50%",
    bottom: tokens.spacingVerticalXXL,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    maxWidth: "min(560px, calc(100vw - 32px))",
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow16,
    // Gentle rise + fade in; centering (translateX -50%) is preserved in the
    // keyframes' end state, and reduced motion keeps only the fade.
    transform: "translateX(-50%)",
    animationName: {
      from: { opacity: 0, transform: "translate(-50%, 8px)" },
      to: { opacity: 1, transform: "translate(-50%, 0)" },
    },
    animationDuration: "200ms",
    animationTimingFunction: "ease-out",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: { from: { opacity: 0 }, to: { opacity: 1 } },
    },
  },
  icon: { fontSize: "20px", flexShrink: 0, color: tokens.colorBrandForeground1 },
  text: { flexGrow: 1, minWidth: 0 },
  chord: { fontWeight: tokens.fontWeightSemibold },
});

export function SummonHint() {
  const styles = useStyles();
  // The current accelerator to show — non-null only once we've decided to show.
  const [shortcut, setShortcut] = useState<string | null>(null);
  // Whether the first-run tour had ALREADY been shown when this component
  // first rendered. Captured in a useState initializer (render phase) rather
  // than in the effect, because FirstRunTour — a sibling mounted in the same
  // commit — writes its "shown" flag from its OWN effect (inside an async
  // settings fetch, so even later than this component's effect). Reading the
  // flag in the effect could therefore see it already set and fire the hint on
  // the same first run, behind the tour. The render-phase read sees the
  // pre-this-commit value: unset on first run (defer), set on a later launch
  // (show, with no tour to occlude it).
  const [tourAlreadyShown] = useState(() => {
    try {
      return localStorage.getItem(QUICKSTART_SHOWN_KEY) === "1";
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(SHOWN_KEY, "1");
    } catch {
      /* storage blocked — hide anyway, worst case it re-shows next launch */
    }
    setShortcut(null);
  }, []);

  // Decide whether to show: desktop only, never shown before, and only when a
  // keyed shortcut actually registered (summonHotkeyOk !== false).
  useEffect(() => {
    if (!isDesktopShell()) return;
    // Hold until a launch AFTER the Quick Start tour was seen, so this never
    // opens behind that modal and auto-dismisses unread. The value is the
    // render-phase snapshot (see above) — false on the tour's own first run,
    // so we skip this launch without burning the flag and greet on a later one.
    if (!tourAlreadyShown) return;
    try {
      if (localStorage.getItem(SHOWN_KEY) === "1") return;
    } catch {
      return; // storage blocked — don't risk greeting on every launch
    }
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        if (d.desktop === true && d.summonHotkeyOk !== false) {
          setShortcut(
            typeof d.summonShortcut === "string" && d.summonShortcut
              ? d.summonShortcut
              : "ctrl+super+shift+space",
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tourAlreadyShown]);

  if (!shortcut) return null;

  return (
    <div className={styles.banner} role="status">
      <SearchSparkleRegular className={styles.icon} aria-hidden />
      <Text size={300} className={styles.text}>
        Tip: press <span className={styles.chord}>{prettyShortcut(shortcut)}</span> anywhere to
        summon Lighthouse&apos;s search bar.
      </Text>
      <Button size="small" appearance="primary" onClick={dismiss}>
        Got it
      </Button>
      <Button
        size="small"
        appearance="subtle"
        icon={<DismissRegular />}
        aria-label="Dismiss"
        onClick={dismiss}
      />
    </div>
  );
}
