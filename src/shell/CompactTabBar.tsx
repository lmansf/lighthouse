"use client";

/**
 * fp4 §3: the compact bottom tab bar — THE navigation on a mobile shell
 * below the breakpoint (Chat · Files · Settings). It is deliberately a THIN
 * presentational component: the tab set + order + when-to-show live in
 * `paneLayout` (COMPACT_TABS / showTabBar, pure + tested); this only maps each id
 * to an icon and reports taps.
 *
 * iOS-idiomatic: fixed to the bottom, above the pages/sheets it navigates
 * between; safe-area-inset-bottom aware so it never rides under the home
 * indicator; ≥44pt targets with the active tab marked (filled glyph + amber +
 * aria-current). It slides out of view while the software keyboard is up (the
 * parent passes `hidden`) so it never floats mid-screen, and the slide honors
 * prefers-reduced-motion. Desktop / iPad-regular never mount it (paneLayout's
 * showTabBar is false there — the structural pin).
 */
import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import {
  ChatRegular,
  ChatFilled,
  FolderRegular,
  FolderFilled,
  SettingsRegular,
  SettingsFilled,
} from "@fluentui/react-icons";
import { COMPACT_TABS, type CompactTab } from "./paneLayout";

/** The tab bar's content height in px (excludes the safe-area inset it adds
 *  below). Exported so AppShell can reserve exactly this much space above the
 *  bar (via the --lh-tabbar-h var) for the composer, pages, and the bug FAB. */
export const TAB_BAR_CONTENT_HEIGHT = 49;

/** Outline glyph (inactive) + filled glyph (active) per destination — the iOS
 *  tab-bar idiom. Kept here, not in paneLayout, so the verdict stays Fluent-free. */
const TAB_ICONS: Record<CompactTab, { rest: React.ReactNode; active: React.ReactNode }> = {
  chat: { rest: <ChatRegular />, active: <ChatFilled /> },
  files: { rest: <FolderRegular />, active: <FolderFilled /> },
  settings: { rest: <SettingsRegular />, active: <SettingsFilled /> },
};

const useStyles = makeStyles({
  bar: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    // Above the files page (21) and section sheets (30) so it stays reachable
    // while a tab's page is on screen; the pages reserve room for it.
    zIndex: 40,
    display: "flex",
    height: `calc(${TAB_BAR_CONTENT_HEIGHT}px + var(--lh-safe-bottom, 0px))`,
    // Sit the row above the home indicator + notch gutters.
    paddingBottom: "var(--lh-safe-bottom, 0px)",
    paddingLeft: "var(--lh-safe-left, 0px)",
    paddingRight: "var(--lh-safe-right, 0px)",
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderTop("1px", "solid", tokens.colorNeutralStroke2),
    // Slide down out of view when hidden (keyboard up / modal sheet); honored
    // off for reduced motion, where it just snaps.
    transitionProperty: "transform, opacity",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  hidden: {
    transform: "translateY(100%)",
    opacity: 0,
    // Never intercept taps while parked off-screen.
    pointerEvents: "none",
  },
  tab: {
    flex: 1,
    minWidth: 0,
    // A thumb-sized target that fills the bar's content height.
    minHeight: `${TAB_BAR_CONTENT_HEIGHT}px`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2px",
    ...shorthands.border("none"),
    ...shorthands.padding(tokens.spacingVerticalXS, 0),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    fontFamily: "inherit",
    // No tap-highlight flash; the active state is the affordance.
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  tabActive: { color: tokens.colorBrandForeground1 },
  icon: { fontSize: "24px", display: "inline-flex", lineHeight: 1 },
  label: {
    fontSize: tokens.fontSizeBase100,
    lineHeight: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
});

interface CompactTabBarProps {
  /** The destination currently on screen — its tab is marked active. */
  active: CompactTab;
  /** A tap on a tab. Selecting the active tab is the caller's scroll-to-top. */
  onSelect: (tab: CompactTab) => void;
  /** Slide the bar out of view (software keyboard up, or a modal sheet open). */
  hidden?: boolean;
}

export function CompactTabBar({ active, onSelect, hidden = false }: CompactTabBarProps) {
  const styles = useStyles();
  return (
    <nav
      aria-label="Primary"
      data-compact-tabbar
      // Off the a11y tree while parked off-screen so it isn't a stray landmark.
      aria-hidden={hidden || undefined}
      className={mergeClasses(styles.bar, hidden && styles.hidden)}
    >
      {COMPACT_TABS.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            className={mergeClasses(styles.tab, isActive && styles.tabActive)}
            aria-current={isActive ? "page" : undefined}
            aria-label={t.label}
            tabIndex={hidden ? -1 : 0}
            onClick={() => onSelect(t.id)}
          >
            <span className={styles.icon} aria-hidden>
              {isActive ? TAB_ICONS[t.id].active : TAB_ICONS[t.id].rest}
            </span>
            <span className={styles.label}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
