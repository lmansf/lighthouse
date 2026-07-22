"use client";

/**
 * First-run interface mode chooser (desktop only). Lighthouse can live as a
 * regular app window (the default) or — experimentally — as a floating
 * always-on-top search bar with the main window tucked away in the tray. The
 * choice is asked exactly once: `ModeChooserAuto` fetches /api/settings on
 * mount and only opens when this is a desktop install whose `uiMode` is still
 * null (never chosen). Everything else — web build, already chosen, settings
 * unreachable — settles silently.
 *
 * Whatever path closes the chooser, `onSettled` fires exactly once: it
 * un-gates the quick-start tour (app/page.tsx), so it must never be lost —
 * even when persisting the choice fails. Dismissing without choosing (Esc)
 * records "window": choosing nothing keeps the default, and recording it
 * keeps the dialog from re-asking every launch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconSearchAI, IconWindow } from "@/shell/icons";
import { isDesktopShell } from "@/shell/desktopBridge";
import { LhDialogSurface } from "@/shell/controls";

type UiMode = "window" | "widget";

/**
 * The summon shortcut, spelled the way the user's platform spells it. Guarded
 * for SSR (falls back to the generic form); only ever rendered client-side —
 * dialog surfaces don't mount until opened — so the UA-specific string never
 * causes a hydration mismatch.
 */
export function summonHotkey(): string {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent;
    if (ua.includes("Mac")) return "Control + ⌘ + Shift + Space";
    if (ua.includes("Windows")) return "Ctrl + Win + Shift + Space";
  }
  return "Ctrl + Super + Shift + Space";
}

/**
 * The primary command-modifier key, spelled for the user's platform: ⌘ on
 * macOS, "Ctrl" everywhere else. Guarded for SSR (defaults to "Ctrl") and only
 * ever rendered client-side, so the UA branch never trips a hydration mismatch.
 * Shared by the in-app shortcut hints (sidebar, settings) and the Quick Start
 * tour so a single helper decides how ⌘/Ctrl is shown across the app.
 */
export function modKey(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")) return "⌘";
  return "Ctrl";
}

/**
 * Render a tauri global-hotkey accelerator ("ctrl+super+shift+space") as a
 * human-readable chord ("Ctrl + Super + Shift + Space"). The `super` modifier
 * follows the platform (⌘ on macOS, "Win" on Windows, else "Super"); main-key
 * tokens drop their "Key"/"Digit" prefixes (KeyP → P, Digit3 → 3) and are
 * title-cased. Guarded for SSR like `summonHotkey`, and only rendered
 * client-side, so the UA branch never trips a hydration mismatch.
 */
export function prettyShortcut(accel: string): string {
  if (!accel) return "";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isWindows = ua.includes("Windows");
  const isMac = ua.includes("Mac") && !isWindows;
  const superLabel = isMac ? "⌘" : isWindows ? "Win" : "Super";
  return accel
    .split("+")
    .map((raw) => {
      const part = raw.trim();
      if (!part) return "";
      switch (part.toLowerCase()) {
        case "ctrl":
        case "control":
          return "Ctrl";
        case "super":
        case "meta":
        case "cmd":
        case "command":
          return superLabel;
        case "alt":
        case "option":
          return "Alt";
        case "shift":
          return "Shift";
        default: {
          const token = part.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=[0-9]$)/, "");
          return token.charAt(0).toUpperCase() + token.slice(1);
        }
      }
    })
    .filter(Boolean)
    .join(" + ");
}

/**
 * Show + focus the floating search-bar widget. Same guarded dynamic-import
 * pattern as the widget's own `invokeShell` (WidgetBar.tsx): resolves quietly
 * outside the Tauri shell so plain-web renders and Playwright runs never
 * throw; inside the shell a failed command is logged, never fatal.
 */
export async function showWidget(): Promise<void> {
  if (!isDesktopShell()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("widget_show");
  } catch (err) {
    console.error('Shell command "widget_show" failed', err);
  }
}

const useStyles = makeStyles({
  content: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  cards: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  // The options as large clickable cards (native <button>s, so they're
  // tabbable and Enter/Space-activatable for free): quiet neutral tiles that
  // take the brand stroke + tint when selected. Border width stays 1px in
  // both states so selecting never shifts layout.
  card: {
    display: "flex",
    alignItems: "flex-start",
    gap: tokens.spacingHorizontalM,
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
    boxSizing: "border-box",
    fontFamily: tokens.fontFamilyBase,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.border("1px", "solid", tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusLarge,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  cardSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
    ":hover": { backgroundColor: tokens.colorBrandBackground2 },
  },
  cardIcon: {
    fontSize: "24px",
    flexShrink: 0,
    marginTop: "2px",
    color: tokens.colorBrandForeground1,
  },
  cardText: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  cardTitle: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  cardBody: { color: tokens.colorNeutralForeground2 },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** One selectable mode card: icon, title (+ optional badge), subtitle. */
function ModeCard({
  selected,
  onSelect,
  icon,
  title,
  badge,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  body: string;
}) {
  const styles = useStyles();
  return (
    <button
      type="button"
      className={mergeClasses(styles.card, selected && styles.cardSelected)}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={styles.cardIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.cardText}>
        <span className={styles.cardTitle}>
          {title}
          {badge}
        </span>
        <Text size={200} className={styles.cardBody}>
          {body}
        </Text>
      </span>
    </button>
  );
}

/**
 * Asks the window-vs-widget question once on a fresh desktop install. Always
 * calls `onSettled` exactly once — immediately when there's nothing to ask,
 * otherwise when the dialog closes (Continue or dismiss).
 */
export function ModeChooserAuto({ onSettled }: { onSettled: () => void }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<UiMode>("window");
  const [saving, setSaving] = useState(false);
  // Launch-at-login consent, asked here so widget mode (which hides the main
  // window) can't strand the separate startup prompt. Opt-IN (default off): a
  // first-run user shouldn't be enrolled into autostart just by clicking
  // Continue — they tick the box if they want it. Still changeable in
  // Preferences either way.
  const [runOnStartup, setRunOnStartup] = useState(false);
  // False when the shell couldn't register the global shortcut (Wayland) —
  // the hint then points at the tray instead of promising a dead hotkey.
  // Absent (web parity route) counts as fine: the chooser only opens on
  // desktop installs anyway. (`desktop: true` alone is a sufficient gate
  // today — the legacy Electron shell that also set it stopped shipping at
  // 0.3.1, and the Tauri no-bundle dev mode degrades to window mode.)
  const [hotkeyOk, setHotkeyOk] = useState(true);
  // Widget hand-off confirmation: choosing widget mode tucks the main window
  // into the tray, so a one-time note reassures the user it didn't just quit.
  const [trayHintOpen, setTrayHintOpen] = useState(false);

  // onSettled must fire exactly once whatever path resolves the chooser; the
  // ref keeps the mount effect off the (inline, per-render) prop identity.
  const settledRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settle = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettledRef.current();
  }, []);

  useEffect(() => {
    let alive = true;
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        // Only a DESKTOP-form-factor install that has never chosen gets asked
        // (§1 platform gate): window/widget/tray/summon-hotkey are desktop
        // concepts, so the dialog never mounts on ios/android. Anything else
        // (web build, mobile, already chosen, unreadable settings) settles now.
        if (d && d.platform === "desktop" && d.uiMode == null) {
          setHotkeyOk(d.summonHotkeyOk !== false);
          setOpen(true);
        } else settle();
      })
      .catch(() => {
        if (alive) settle();
      });
    return () => {
      alive = false;
    };
  }, [settle]);

  /** Persist the choice — best-effort: a failed POST must never trap the user.
   *  `withStartup` carries the launch-at-login consent + startupAsked only on
   *  the EXPLICIT Continue path (the user saw and could untick the checkbox).
   *  Esc must NOT enroll autostart — pressing Escape to skip a dialog is not
   *  consent — so the dismiss path omits those keys, leaving startup unasked
   *  for the deferred StartupPrompt to handle in the (always-available) main
   *  window it falls back to. */
  async function persist(mode: UiMode, withStartup: boolean) {
    const body: Record<string, unknown> = { uiMode: mode };
    if (withStartup) {
      body.runOnStartup = runOnStartup;
      body.startupAsked = true;
    }
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      /* best-effort — the chooser still settles */
    }
  }

  async function confirm() {
    setSaving(true);
    await persist(selected, true); // explicit consent for launch-at-login
    if (selected === "widget") {
      // Show the widget right away so the choice has a visible effect — picking
      // widget mode and seeing nothing happen would read as broken…
      await showWidget();
      // …then confirm the hand-off before settling: the main window is tucking
      // into the tray, and vanishing with no word reads as "the app quit".
      setSaving(false);
      setOpen(false);
      setTrayHintOpen(true);
      return;
    }
    setOpen(false);
    settle();
  }

  /** Esc (or any non-Continue close): choosing nothing keeps the default —
   *  record "window" so the question never re-asks on later launches, but do
   *  NOT enroll autostart (no explicit consent was given). */
  function dismiss() {
    if (saving || settledRef.current) return;
    void persist("window", false);
    setOpen(false);
    settle();
  }

  const hotkey = summonHotkey();

  return (
    <>
    <Dialog
      open={open}
      // alert: clicking outside must not silently dismiss a one-time question.
      modalType="alert"
      onOpenChange={(_, d) => {
        if (!d.open) dismiss();
      }}
    >
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>How should Lighthouse live on your desktop?</DialogTitle>
          <DialogContent>
            <div className={styles.content}>
              <div className={styles.cards} role="group" aria-label="Interface mode">
                <ModeCard
                  selected={selected === "window"}
                  onSelect={() => setSelected("window")}
                  icon={<IconWindow />}
                  title="Window mode"
                  body="The classic app window — your files and chat side by side, and the floating search bar one hotkey away."
                />
                <ModeCard
                  selected={selected === "widget"}
                  onSelect={() => setSelected("widget")}
                  icon={<IconSearchAI />}
                  title="Widget mode"
                  badge={
                    <Badge size="small" appearance="tint" color="warning">
                      Experimental
                    </Badge>
                  }
                  body="Lighthouse lives as a floating search bar on your desktop; the main window stays tucked away in the tray until you ask for it."
                />
              </div>
              <Text size={200} className={styles.hint}>
                {hotkeyOk
                  ? `Either way, ${hotkey} summons the search bar from anywhere. Change this anytime in Preferences.`
                  : "Your system doesn't support the global shortcut, so summon the search bar from the tray icon's “Show search bar”. Change modes anytime in Preferences."}
              </Text>
              <Checkbox
                checked={runOnStartup}
                onChange={(_, d) => setRunOnStartup(Boolean(d.checked))}
                label="Open Lighthouse when I sign in to my computer"
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={saving}
              icon={saving ? <Spinner size="tiny" /> : undefined}
              onClick={() => void confirm()}
            >
              Continue
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>

    {/* Widget hand-off: confirm the move to the tray so the disappearing main
        window never reads as "the app quit". Settles the chooser on ack. */}
    <Dialog
      open={trayHintOpen}
      modalType="alert"
      onOpenChange={(_, d) => {
        if (!d.open) {
          setTrayHintOpen(false);
          settle();
        }
      }}
    >
      <LhDialogSurface>
        <DialogBody>
          <DialogTitle>Lighthouse is now in your tray</DialogTitle>
          <DialogContent>
            <Text>
              {hotkeyOk
                ? `The main window is tucked away. Press ${hotkey} anywhere to summon the floating search bar — and open the full window whenever you need it from the Lighthouse tray icon.`
                : "The main window is tucked away. Open the search bar (and the full window) anytime from the Lighthouse tray icon’s menu."}
            </Text>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              onClick={() => {
                setTrayHintOpen(false);
                settle();
              }}
            >
              Got it
            </Button>
          </DialogActions>
        </DialogBody>
      </LhDialogSurface>
    </Dialog>
    </>
  );
}
