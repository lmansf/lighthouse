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
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { SearchSparkleRegular, WindowRegular } from "@fluentui/react-icons";
import { isDesktopShell } from "@/shell/desktopBridge";

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
        // Only a desktop install that has never chosen gets asked; anything
        // else (web build, already chosen, unreadable settings) settles now.
        if (d && d.desktop === true && d.uiMode == null) setOpen(true);
        else settle();
      })
      .catch(() => {
        if (alive) settle();
      });
    return () => {
      alive = false;
    };
  }, [settle]);

  /** Persist the choice — best-effort: a failed POST must never trap the user. */
  async function persist(mode: UiMode) {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uiMode: mode }),
      });
    } catch {
      /* best-effort — the chooser still settles */
    }
  }

  async function confirm() {
    setSaving(true);
    await persist(selected);
    // Show the widget right away so the choice has a visible effect — picking
    // widget mode and seeing nothing happen would read as broken.
    if (selected === "widget") await showWidget();
    setOpen(false);
    settle();
  }

  /** Esc (or any non-Continue close): choosing nothing keeps the default —
   *  record "window" so the question never re-asks on later launches. */
  function dismiss() {
    if (saving || settledRef.current) return;
    void persist("window");
    setOpen(false);
    settle();
  }

  const hotkey = summonHotkey();

  return (
    <Dialog
      open={open}
      // alert: clicking outside must not silently dismiss a one-time question.
      modalType="alert"
      onOpenChange={(_, d) => {
        if (!d.open) dismiss();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>How should Lighthouse live on your desktop?</DialogTitle>
          <DialogContent>
            <div className={styles.content}>
              <div className={styles.cards} role="group" aria-label="Interface mode">
                <ModeCard
                  selected={selected === "window"}
                  onSelect={() => setSelected("window")}
                  icon={<WindowRegular />}
                  title="Window mode"
                  body="The classic app window — your files and chat side by side, and the floating search bar one hotkey away."
                />
                <ModeCard
                  selected={selected === "widget"}
                  onSelect={() => setSelected("widget")}
                  icon={<SearchSparkleRegular />}
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
                Either way, {hotkey} summons the search bar from anywhere. Change this anytime in
                Preferences.
              </Text>
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
      </DialogSurface>
    </Dialog>
  );
}
