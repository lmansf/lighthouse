"use client";

/**
 * fp4 §3 → §31 §2: the compact bottom tab bar — THE navigation on a mobile
 * shell below the breakpoint (Chat · Files · Settings). It is deliberately a
 * THIN presentational component: the tab set + order + when-to-show live in
 * `paneLayout` (COMPACT_TABS / showTabBar, pure + tested); this maps each id
 * to an icon, reports taps, and owns its own scroll-minimize state.
 *
 * §31 §2 — one of the TWO glass surfaces (with Sheet): a floating capsule
 * inset from the screen edges, riding the shared glass tokens
 * (--lh-glass-level/-blur/-saturate — solid when the level is 0 or the OS
 * Reduce Transparency attribute is stamped), with a 0.5px inner highlight and
 * the ambient card shadow. It MINIMIZES on scroll-down (labels collapse, the
 * capsule compresses toward the edge) and restores on scroll-up or
 * scroll-to-top — a capture-phase scroll listener tracks direction on
 * whichever page scroller is moving, since element scrolls don't bubble.
 * Springs ride the §1 motion tokens, which collapse under reduced motion.
 *
 * iOS-idiomatic: safe-area aware (floats above the home indicator), ≥44pt
 * targets, active tab marked (filled glyph + tint + aria-current), slides
 * fully away while the software keyboard or a sheet is up (the parent passes
 * `hidden`; hidden wins over minimized). Desktop / iPad-regular never mount
 * it (paneLayout's showTabBar is false there — the structural pin).
 */
import { useEffect, useState } from "react";
import { makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { IconChat, IconChatFilled, IconFolder, IconFolderFilled, IconSettings, IconSettingsFilled } from "@/shell/icons";
import { COMPACT_TABS, type CompactTab } from "./paneLayout";

/** The bar's content height in px (the capsule row; the float gap and
 *  safe-area ride BELOW it). Exported so AppShell can reserve exactly
 *  content + gap above the bar (via the --lh-tabbar-h var). */
export const TAB_BAR_CONTENT_HEIGHT = 49;

/** §31 §2: the float inset — the capsule hovers this far off the safe-area
 *  bottom (and the pages' reserve includes it). */
export const TAB_BAR_FLOAT_GAP = 8;

/** Outline glyph (inactive) + filled glyph (active) per destination — the iOS
 *  tab-bar idiom. Kept here, not in paneLayout, so the verdict stays Fluent-free. */
const TAB_ICONS: Record<CompactTab, { rest: React.ReactNode; active: React.ReactNode }> = {
  chat: { rest: <IconChat />, active: <IconChatFilled /> },
  files: { rest: <IconFolder />, active: <IconFolderFilled /> },
  settings: { rest: <IconSettings />, active: <IconSettingsFilled /> },
};

const useStyles = makeStyles({
  bar: {
    position: "fixed",
    // The floating capsule: inset from the edges, hovering the float gap above
    // the home indicator; centered and width-capped so a landscape phone gets
    // a pill, not a plank.
    left: `calc(12px + var(--lh-safe-left, 0px))`,
    right: `calc(12px + var(--lh-safe-right, 0px))`,
    bottom: `calc(var(--lh-safe-bottom, 0px) + ${TAB_BAR_FLOAT_GAP}px)`,
    maxWidth: "420px",
    marginLeft: "auto",
    marginRight: "auto",
    // Above the files page (21) and sheets' scrim (29) so it stays reachable
    // while a tab's page is on screen; it hides entirely under open sheets.
    zIndex: 40,
    display: "flex",
    height: `${TAB_BAR_CONTENT_HEIGHT}px`,
    ...shorthands.borderRadius("var(--lh-capsule)"),
    // §31 §2 glass recipe: translucent surface over backdrop blur+saturate,
    // 0.5px inner highlight + hairline ring + ambient shadow. At level 0 (or
    // under data-reduce-transparency) the mix is 100% and the blur is 0 —
    // a solid surface with the same geometry.
    backgroundColor:
      "color-mix(in srgb, var(--lh-bg-secondary) calc(100% - 38% * var(--lh-glass-level)), transparent)",
    backdropFilter:
      "blur(calc(var(--lh-glass-blur) * var(--lh-glass-level))) saturate(calc(100% + 80% * var(--lh-glass-level)))",
    boxShadow:
      "inset 0 0.5px 0 var(--lh-glass-highlight), 0 0 0 0.5px var(--lh-separator), var(--lh-shadow-card)",
    // Motion rides the §1 spring tokens (reduced motion collapses them globally).
    transitionProperty: "transform, opacity",
    transitionDuration: "var(--lh-dur)",
    transitionTimingFunction: "var(--lh-spring)",
  },
  // Scroll-down minimize: the capsule compresses toward the edge and the
  // labels collapse (below) — icons stay tappable; any upward scroll or
  // scroll-to-top restores. Transform-only on the bar itself.
  minimized: {
    transform: "translateY(6px) scale(0.9)",
    transformOrigin: "50% 100%",
  },
  hidden: {
    // Park fully below the viewport (past the float gap + safe area) when the
    // keyboard or a sheet is up. Wins over minimized (merge order).
    transform: `translateY(calc(100% + var(--lh-safe-bottom, 0px) + ${TAB_BAR_FLOAT_GAP + 4}px))`,
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
    ...shorthands.borderRadius("var(--lh-capsule)"),
    ...shorthands.padding(tokens.spacingVerticalXS, 0),
    backgroundColor: "transparent",
    // fg2, not fg3: the §7 contrast-on-glass gate — fg3 cannot clear 4.5:1
    // composited over worst-case blurred content at full glass; fg2 does.
    color: tokens.colorNeutralForeground2,
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
    // Collapse with the minimize (opacity + height, cheap inside the bar).
    transitionProperty: "opacity, max-height",
    transitionDuration: "var(--lh-dur-fast)",
    transitionTimingFunction: "var(--lh-spring)",
    maxHeight: "12px",
  },
  labelMinimized: { opacity: 0, maxHeight: "0px" },
});

/** Scroll-direction thresholds (px) — small enough to feel immediate, large
 *  enough not to flap on rubber-band jitter. */
const SCROLL_DELTA = 4;
const TOP_RESTORE = 8;

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
  const [minimized, setMinimized] = useState(false);

  // §31 §2: minimize on scroll-down, restore on scroll-up / scroll-to-top.
  // Capture phase because element scrolls (the transcript, the tile grid, the
  // Settings page body) don't bubble; direction is tracked per scroller.
  useEffect(() => {
    const lastY = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const y = t.scrollTop;
      const prev = lastY.get(t);
      lastY.set(t, y);
      if (y <= TOP_RESTORE) {
        setMinimized(false);
        return;
      }
      if (prev === undefined) return;
      const dy = y - prev;
      if (dy > SCROLL_DELTA) setMinimized(true);
      else if (dy < -SCROLL_DELTA) setMinimized(false);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);

  return (
    <nav
      aria-label="Primary"
      data-compact-tabbar
      // Off the a11y tree while parked off-screen so it isn't a stray landmark.
      aria-hidden={hidden || undefined}
      className={mergeClasses(styles.bar, minimized && styles.minimized, hidden && styles.hidden)}
    >
      {COMPACT_TABS.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            className={mergeClasses("lh-press", styles.tab, isActive && styles.tabActive)}
            aria-current={isActive ? "page" : undefined}
            aria-label={t.label}
            tabIndex={hidden ? -1 : 0}
            onClick={() => {
              setMinimized(false);
              onSelect(t.id);
            }}
          >
            <span className={styles.icon} aria-hidden>
              {isActive ? TAB_ICONS[t.id].active : TAB_ICONS[t.id].rest}
            </span>
            <span className={mergeClasses(styles.label, minimized && styles.labelMinimized)}>
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
