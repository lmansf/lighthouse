"use client";

/**
 * First-run orientation tour — the single, once-per-install surface that walks a
 * new user through Lighthouse's five pillars, each anchored to the real UI it
 * describes. This FOLDS IN the former Quick Start guide (there is now one
 * orientation surface, not two): it auto-opens exactly once, gated on the
 * install-global `tourShown` desktop setting — NOT localStorage — so the flag
 * survives vault switches and only a wiped app-state dir re-shows it. It is also
 * re-runnable on demand from the settings gear ("Take the tour"), which ignores
 * `tourShown`.
 *
 * Anchoring: a Fluent TeachingPopover points at each step's `[data-tour=…]`
 * element (left neutral in appearance, so its content reads correctly in light
 * and dark). When the element is missing/hidden — or TeachingPopover is
 * unavailable — the step falls back to a centered modal, so the tour never
 * breaks. Every step offers Next + Skip tour; Esc dismisses (= skip); the whole
 * thing traps focus and is keyboard-navigable.
 *
 * MAIN WINDOW ONLY: this mounts from app/page.tsx, which the widget (/widget)
 * and standalone explorer (/explorer) windows never render. So a widget-mode
 * install defers the tour to the first main-window open — it can never interrupt
 * the floating search bar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  TeachingPopover,
  TeachingPopoverSurface,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { IconAI, IconChart, IconChatAI, IconDocAdd, IconSettings } from "@/shell/icons";
import { shouldAutoOpenTour } from "./tourGating";
import { BEAM_SWEEP } from "@/shell/theme";
import { platformKind, type PlatformKind } from "@/shell/desktopBridge";
import { MOBILE_NO_PROVIDER_TRUTHS, ON_DEVICE_MODEL_COPY } from "@/contracts";
import { usePaneLayout } from "@/shell/paneLayout";
import { useOnDeviceModel } from "@/stores/useOnDeviceModel";
import { LhDialogSurface } from "@/shell/controls";

/**
 * The former Quick Start's localStorage once-flag. SummonHint keys its "wait
 * until the tour has been seen" ordering off this exact key (via a render-phase
 * snapshot), so we keep writing it the moment the tour first appears — otherwise
 * the summon hint would defer forever. The real source of truth is `tourShown`
 * in settings; this is only a cross-surface coordination bridge.
 */
const LEGACY_SHOWN_KEY = "lighthouse.quickstart.shown";

/** Fired by the settings menu's "Take the tour" item to replay it on demand. */
export const START_TOUR_EVENT = "lighthouse:start-tour";

type TourPosition = "above" | "below" | "before" | "after";

interface TourStep {
  /** The `data-tour` value of the element this step points at. */
  anchor: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  /** Preferred side of the anchor; Fluent flips it if there's no room. */
  position: TourPosition;
}

/**
 * §33 §3: targeting is MODE-aware — every step's anchor must be in the DOM in
 * the mode that shows it (test/tourAnchors.test.mjs is the anchor floor).
 * Compact's first-run lands on the Chat tab, where the tab bar is always on
 * screen — so surfaces that live behind tabs (Files, Settings) are pointed at
 * their TABS. The models step tells today's truth per device: on-device where
 * a backend reported (`onDevice` — the availability-driven roster truths),
 * cloud only when you add a key.
 */
const stepsFor = (platform: PlatformKind, compact: boolean, onDevice = false): TourStep[] =>
  compact
    ? [
        {
          anchor: "chat",
          icon: <IconChatAI />,
          title: "Ask, and get grounded answers",
          body: "Ask in plain language. Answers are built only from your visible files and cite the exact sources — tap a citation to jump to it. Tap Send to ask.",
          position: "above",
        },
        {
          anchor: "tab-files",
          icon: <IconDocAdd />,
          title: "Add files, choose what's visible",
          body: "The Files tab adds documents from the Files app — they stay on this device. The eye toggle on each row controls exactly what the AI can see, so nothing is read unless you choose it.",
          position: "above",
        },
        {
          anchor: "suggestions",
          icon: <IconChart />,
          title: "Beam: analytics you can verify",
          body: "Tap a suggested ask and Beam, the built-in analytics engine, computes the numbers from your data — then shows the exact SQL it ran. Verified figures you can check, not guesses.",
          position: "below",
        },
        {
          anchor: "models",
          icon: <IconAI />,
          title: "Private on-device, or cloud",
          body: onDevice
            ? `${ON_DEVICE_MODEL_COPY.foundation} — cloud models join only when you add a key. This line always tells you whether anything leaves this device.`
            : `${MOBILE_NO_PROVIDER_TRUTHS} This line always tells you whether anything leaves this device.`,
          position: "above",
        },
        {
          anchor: "tab-settings",
          icon: <IconSettings />,
          title: "Everything else lives here",
          body: "The Settings tab holds Preferences, AI models, and Send feedback — History is the clock button up top, and you can replay this tour anytime from “Take the tour”.",
          position: "above",
        },
      ]
    : [
        {
          anchor: "explorer",
          icon: <IconDocAdd />,
          title: "Add files, choose what's visible",
          body:
            platform === "desktop"
              ? "Drag files and folders in, or browse to them — they stay on this device. The eye toggle on each row controls exactly what the AI can see, so nothing is read unless you choose it. The lock toggle keeps a file private to this device — hidden from cloud models, while the private model can always read it."
              : "Add files and they stay on this device. The eye toggle on each row controls exactly what the AI can see, so nothing is read unless you choose it. The lock toggle keeps a file hidden from cloud models.",
          position: "after",
        },
        {
          anchor: "chat",
          icon: <IconChatAI />,
          title: "Ask, and get grounded answers",
          // §2: the keyboard-shortcut line renders only where a hardware keyboard
          // is the norm; mobile copy names the send button instead.
          body:
            platform === "desktop"
              ? "Ask in plain language. Answers are built only from your visible files and cite the exact sources — click a citation to jump to it. Enter sends; Shift+Enter adds a line."
              : "Ask in plain language. Answers are built only from your visible files and cite the exact sources — tap a citation to jump to it. Tap Send to ask.",
          position: "above",
        },
        {
          // §33 §3: retargeted from the old title-anchored `beam` step — the
          // suggestions/recipes row is the thing you can actually tap.
          anchor: "suggestions",
          icon: <IconChart />,
          title: "Beam: analytics you can verify",
          body: "Try a suggested ask — Beam, the built-in analytics engine, computes the numbers from your data, then shows the exact SQL it ran. Verified figures you can check, not guesses.",
          position: "below",
        },
        {
          anchor: "models",
          icon: <IconAI />,
          title: "Private on-device, or cloud",
          body:
            platform === "desktop"
              ? "Choose who answers: a model that runs entirely on this device, or a cloud provider. This line always tells you whether anything leaves this device."
              : onDevice
                ? `${ON_DEVICE_MODEL_COPY.foundation} — cloud models join only when you add a key. This line always tells you whether anything leaves this device.`
                : `${MOBILE_NO_PROVIDER_TRUTHS} This line always tells you whether anything leaves this device.`,
          position: "above",
        },
        {
          anchor: "settings",
          icon: <IconSettings />,
          title: "Everything else lives here",
          body: "The gear opens Preferences, AI models, and Send feedback — and you can replay this tour anytime from “Take the tour”.",
          position: "after",
        },
      ];

const useStyles = makeStyles({
  // Neutral TeachingPopover surface: it rides the Paper/Ink tokens (raised
  // background + the theme's one raised shadow); keep it compact and readable.
  surface: { maxWidth: "340px" },
  fallbackSurface: { maxWidth: "440px" },
  content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  // The Beam signature crowning each step: a slim ink→amber sweep band — a
  // hero-moment use of BEAM_SWEEP, never behind body text. Theme variant via
  // the data-theme stamp on <html> (same pattern as chat's beacon).
  beamBand: {
    height: "3px",
    flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: BEAM_SWEEP.light,
    ':global([data-theme="dark"])': { backgroundImage: BEAM_SWEEP.dark },
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  icon: { display: "inline-flex", fontSize: "20px", flexShrink: 0, color: tokens.colorBrandForeground1 },
  body: { color: tokens.colorNeutralForeground2 },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  // "1 of 5" — a quiet progress marker pinned to the left of the actions.
  count: { color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  spacer: { flex: 1 },
  // The centered-fallback title reuses the icon+label header layout, stacked
  // under the same slim sweep band as the anchored popover.
  dialogTitle: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  dialogTitleStack: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
});

export function FirstRunTour() {
  const styles = useStyles();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  // The resolved anchor element for the current step (null ⇒ centered fallback).
  const [target, setTarget] = useState<HTMLElement | null>(null);
  // Whether we've finished resolving the anchor for THIS step (gates rendering
  // so a step never briefly shows its copy positioned at the previous anchor).
  const [placed, setPlaced] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);

  // Platform-aware copy (§2): platformKind() is primed well before the tour
  // can open (the vault tree loads first), and the value never changes within
  // a session — reading it at render is stable. §33 §3: targeting follows the
  // ARRANGEMENT (compact vs not — live, so an iPad rotation retargets) and the
  // models step follows the availability-driven backend verdict.
  const compact = usePaneLayout(false).compact;
  const { available: onDevice } = useOnDeviceModel();
  const STEPS = stepsFor(platformKind(), compact, onDevice);
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  const close = useCallback(() => {
    setActive(false);
    setIndex(0);
  }, []);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i >= STEPS.length - 1) {
        setActive(false);
        return 0;
      }
      return i + 1;
    });
    // STEPS.length is the same on every render (5 steps per platform).
  }, [STEPS.length]);

  // Auto-open once per install. Gate on the install-global `tourShown` and
  // persist it true the MOMENT we decide to show — so completing AND skipping
  // both leave the tour done. A failed read means "don't greet" rather than
  // risk re-showing on every launch.
  useEffect(() => {
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !shouldAutoOpenTour(d)) return;
        setIndex(0);
        setActive(true);
        // Persist immediately. Best-effort: the plain web build has no settings
        // file, so this no-ops there and the tour re-greets on reload (desktop
        // is the shipping target; only a wiped app-state dir re-shows it).
        void fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tourShown: true }),
        }).catch(() => {});
        // Bridge flag for SummonHint's first-run ordering (see LEGACY_SHOWN_KEY).
        try {
          localStorage.setItem(LEGACY_SHOWN_KEY, "1");
        } catch {
          /* storage blocked — SummonHint simply keeps deferring, no harm */
        }
      })
      .catch(() => {
        /* settings unavailable — don't greet (never risk greeting every launch) */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Manual re-entry from the settings menu — replays the tour, ignoring
  // `tourShown` (and never re-persisting, since it's already true by now).
  // §33 §3: activation defers one frame so AppShell's same-event listener
  // (return to the Chat tab on compact) commits before anchors resolve.
  useEffect(() => {
    const onStart = () => {
      requestAnimationFrame(() => {
        setIndex(0);
        setActive(true);
      });
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  // Mark the tour active on <body> so the other first-run surfaces
  // (StartupPrompt, FeedbackNudge) don't stack on top of an anchored step — the
  // centered fallback already registers as a .fui-DialogSurface they detect, but
  // an anchored TeachingPopover does not.
  useEffect(() => {
    if (!active) return;
    document.body.dataset.tourActive = "1";
    return () => {
      delete document.body.dataset.tourActive;
    };
  }, [active]);

  // Resolve the current step's anchor, retrying across a few frames for a
  // just-mounted DOM, then fall back to centered when it's missing or hidden.
  useEffect(() => {
    if (!active) {
      setPlaced(false);
      setTarget(null);
      return;
    }
    let raf = 0;
    let tries = 0;
    let cancelled = false;
    setPlaced(false);
    const resolve = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`);
      const visible =
        !!el && el.getBoundingClientRect().width > 0 && el.offsetParent !== null;
      if (visible) {
        setTarget(el);
        setPlaced(true);
        return;
      }
      if (tries++ < 8) {
        raf = requestAnimationFrame(resolve);
        return;
      }
      setTarget(null); // give up → centered fallback
      setPlaced(true);
    };
    resolve();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [active, index, step.anchor]);

  // Move focus onto the primary action each step for a smooth keyboard flow.
  useEffect(() => {
    if (!active || !placed) return;
    const t = window.setTimeout(() => nextRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [active, placed, index]);

  if (!active || !placed) return null;

  const primaryLabel = isLast ? "Done" : "Next";
  // Defensive capability probe. The pinned Fluent version always ships
  // TeachingPopover, so in practice the fallback triggers on a missing/hidden
  // anchor — but if a bump ever dropped it, we degrade to the centered modal.
  // (typeof, not truthiness: TeachingPopoverSurface is a forwardRef object.)
  const teachingAvailable =
    typeof TeachingPopover !== "undefined" && typeof TeachingPopoverSurface !== "undefined";

  const footer = (
    <>
      <Text size={200} className={styles.count}>
        {index + 1} of {STEPS.length}
      </Text>
      <span className={styles.spacer} />
      <Button appearance="subtle" size="small" onClick={close}>
        Skip tour
      </Button>
      <Button appearance="primary" size="small" ref={nextRef} onClick={next}>
        {primaryLabel}
      </Button>
    </>
  );

  // Anchored path: a neutral TeachingPopover pointed at the real element.
  if (target && teachingAvailable) {
    return (
      <TeachingPopover
        open
        positioning={{ target, position: step.position, align: "center" }}
        onOpenChange={(_, data) => {
          if (!data.open) close(); // Esc / outside-click = skip
        }}
      >
        <TeachingPopoverSurface
          className={styles.surface}
          aria-label={`Tour step ${index + 1} of ${STEPS.length}: ${step.title}`}
          data-tour-step={index + 1}
        >
          <div className={styles.content}>
            <span className={styles.beamBand} aria-hidden />
            <div className={styles.header}>
              <span className={styles.icon} aria-hidden>
                {step.icon}
              </span>
              {step.title}
            </div>
            <Text className={styles.body}>{step.body}</Text>
            <div className={styles.footer}>{footer}</div>
          </div>
        </TeachingPopoverSurface>
      </TeachingPopover>
    );
  }

  // Fallback path: a centered modal (also detected by the first-run nudges via
  // .fui-DialogSurface). Esc closes it (= skip).
  return (
    <Dialog
      open
      modalType="modal"
      onOpenChange={(_, data) => {
        if (!data.open) close();
      }}
    >
      <LhDialogSurface className={styles.fallbackSurface} data-tour-step={index + 1}>
        <DialogBody>
          <DialogTitle>
            <span className={styles.dialogTitleStack}>
              <span className={styles.beamBand} aria-hidden />
              <span className={styles.dialogTitle}>
                <span className={styles.icon} aria-hidden>
                  {step.icon}
                </span>
                {step.title}
              </span>
            </span>
          </DialogTitle>
          <DialogContent>
            <Text className={styles.body}>{step.body}</Text>
          </DialogContent>
          <DialogActions>{footer}</DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
  );
}
