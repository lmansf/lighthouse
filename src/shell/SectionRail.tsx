"use client";

/**
 * Sectioned-sidebar rail (openspec: field-patch-0.12.5 §1). Header-only rows for
 * the six non-file sections, rendered in the sidebar body directly below the
 * Files tree. Clicking a row toggles its flyout (the SectionFlyout column);
 * `aria-expanded` reflects the open section and `aria-controls` points at the
 * flyout panel so assistive tech follows the disclosure.
 *
 * Keyboard: the rows are one roving-tabindex group — Tab reaches the rail once,
 * then Up/Down (and Home/End) move focus between rows, Enter/Space toggles (the
 * native button activation). The focus ring is the Beam focus token, visible in
 * both themes. Beam tokens only; no hardcoded color.
 */
import { useRef, useState } from "react";
import { Text, makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { ChevronRightRegular, MoreHorizontalRegular } from "@fluentui/react-icons";
import { SIDEBAR_SECTIONS, type SidebarSection } from "./sidebarSections";
import { useSidebarFlyout } from "@/stores/useSidebarFlyout";
import { usePaneLayout } from "./paneLayout";

/**
 * fp3 §4: at compact the seven rail sections don't all deserve a first-class
 * row on a phone. History + Investigations (the two the user reaches for most)
 * stay top-level; the other five fold under a "More" row that expands them as a
 * simple in-page list. Desktop / iPad-regular render all seven unchanged.
 */
const COMPACT_PRIMARY_IDS = new Set(["history", "investigations"]);

/** The id of the flyout panel the rows disclose — the rail's `aria-controls`
 *  target and the flyout region's `id` must agree. */
export const FLYOUT_PANEL_ID = "lighthouse-section-flyout";

const useStyles = makeStyles({
  rail: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  groupLabel: {
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    minHeight: "34px",
    // fp3 §4: touch-grade 48pt rows on a coarse pointer (the files page).
    "@media (pointer: coarse)": { minHeight: "48px" },
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.border("none"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
    ":active": { backgroundColor: tokens.colorSubtleBackgroundPressed },
    // The Beam focus ring — amber in both themes (colorStrokeFocus2), inset so it
    // reads inside the sidebar's tight gutter.
    outlineStyle: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: "-2px",
    },
  },
  // The open section: a quiet brand tint + amber mark, the "selected view" idiom.
  rowActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
  icon: {
    display: "inline-flex",
    fontSize: "20px",
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
  },
  iconActive: { color: tokens.colorBrandForeground1 },
  label: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    fontSize: "16px",
    color: tokens.colorNeutralForeground3,
    transitionProperty: "transform",
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  chevronOpen: { transform: "rotate(90deg)" },
  // fp3 §4: the five secondary sections under an expanded "More" — indented one
  // step so the two-level grouping reads at a glance.
  subRow: { paddingLeft: tokens.spacingHorizontalXL },
});

export function SectionRail({ page = false }: { page?: boolean } = {}) {
  const styles = useStyles();
  const openSection = useSidebarFlyout((s) => s.openSection);
  const toggle = useSidebarFlyout((s) => s.toggle);
  // Platform-aware compact (fp3 §4): desktop NEVER compacts at any width (the
  // paneLayout structural pin), so the desktop/iPad-regular render below stays
  // byte-for-byte the seven-row rail. Only a mobile shell <700pt folds.
  const compact = usePaneLayout(false).compact;
  // fp4 §3: the dedicated Sections PAGE (page=true) never folds — it shows every
  // section as a flat 48pt row with History + Investigations promoted to the top.
  // Only the files-page rail folds the five secondaries under a "More" row.
  const fold = compact && !page;
  const [moreOpen, setMoreOpen] = useState(false);
  // Roving tabindex over the CURRENTLY VISIBLE rows: exactly one is tabbable;
  // arrows move the focus (and the tabbable row) within the group.
  const [focusIdx, setFocusIdx] = useState(0);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The visible section rows, in order. On the Sections page every section is a
  // top-level row, History + Investigations first (the fp3 §4 primaries), then
  // the rest in registry order. Elsewhere the order is the registry's verbatim.
  const ordered = page
    ? [
        ...SIDEBAR_SECTIONS.filter((s) => COMPACT_PRIMARY_IDS.has(s.id)),
        ...SIDEBAR_SECTIONS.filter((s) => !COMPACT_PRIMARY_IDS.has(s.id)),
      ]
    : SIDEBAR_SECTIONS;
  // Full list off-fold (desktop, iPad-regular, and the Sections page); when
  // folding (the compact files-page rail) only the primaries sit at top level.
  const primary = fold ? ordered.filter((s) => COMPACT_PRIMARY_IDS.has(s.id)) : ordered;
  const secondary = fold ? ordered.filter((s) => !COMPACT_PRIMARY_IDS.has(s.id)) : [];
  // Total tabbable rows: primary + (folding ? the "More" row + expanded secondary : 0).
  const rowCount = primary.length + (fold ? 1 + (moreOpen ? secondary.length : 0) : 0);

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(rowCount - 1, i));
    setFocusIdx(clamped);
    btnRefs.current[clamped]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rowCount - 1);
    }
    // Enter/Space fall through to the button's native click → toggle.
  };

  const sectionRow = (section: SidebarSection, i: number, sub = false) => {
    const isOpen = openSection === section.id;
    const Icon = section.icon;
    return (
      <button
        key={section.id}
        type="button"
        ref={(el) => {
          btnRefs.current[i] = el;
        }}
        className={mergeClasses(styles.row, sub && styles.subRow, isOpen && styles.rowActive)}
        aria-expanded={isOpen}
        aria-controls={isOpen ? FLYOUT_PANEL_ID : undefined}
        tabIndex={i === focusIdx ? 0 : -1}
        onClick={() => toggle(section.id)}
        onFocus={() => setFocusIdx(i)}
        onKeyDown={(e) => onKeyDown(e, i)}
      >
        <span className={mergeClasses(styles.icon, isOpen && styles.iconActive)} aria-hidden>
          <Icon />
        </span>
        <Text size={300} className={styles.label}>
          {section.label}
        </Text>
        <span className={mergeClasses(styles.chevron, isOpen && styles.chevronOpen)} aria-hidden>
          <ChevronRightRegular />
        </span>
      </button>
    );
  };

  const moreIdx = primary.length; // the "More" row's flat index

  return (
    <nav aria-label="Sections" data-section-rail className={styles.rail}>
      {/* The Sections page carries its own header title, so the rail drops this
          duplicate group label there (fp4 §3); every other surface keeps it. */}
      {!page && (
        <Text size={100} weight="semibold" className={styles.groupLabel} aria-hidden>
          Sections
        </Text>
      )}
      {primary.map((section, i) => sectionRow(section, i))}
      {fold && (
        <>
          <button
            type="button"
            ref={(el) => {
              btnRefs.current[moreIdx] = el;
            }}
            className={styles.row}
            aria-expanded={moreOpen}
            tabIndex={moreIdx === focusIdx ? 0 : -1}
            onClick={() => setMoreOpen((o) => !o)}
            onFocus={() => setFocusIdx(moreIdx)}
            onKeyDown={(e) => onKeyDown(e, moreIdx)}
          >
            <span className={styles.icon} aria-hidden>
              <MoreHorizontalRegular />
            </span>
            <Text size={300} className={styles.label}>
              More
            </Text>
            <span
              className={mergeClasses(styles.chevron, moreOpen && styles.chevronOpen)}
              aria-hidden
            >
              <ChevronRightRegular />
            </span>
          </button>
          {moreOpen && secondary.map((section, j) => sectionRow(section, moreIdx + 1 + j, true))}
        </>
      )}
    </nav>
  );
}
