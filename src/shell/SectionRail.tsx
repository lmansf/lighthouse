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
import { ChevronRightRegular } from "@fluentui/react-icons";
import { SIDEBAR_SECTIONS } from "./sidebarSections";
import { useSidebarFlyout } from "@/stores/useSidebarFlyout";

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
});

export function SectionRail() {
  const styles = useStyles();
  const openSection = useSidebarFlyout((s) => s.openSection);
  const toggle = useSidebarFlyout((s) => s.toggle);
  // Roving tabindex: exactly one row is tabbable; arrows move the focus (and the
  // tabbable row) within the group.
  const [focusIdx, setFocusIdx] = useState(0);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(SIDEBAR_SECTIONS.length - 1, i));
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
      focusRow(SIDEBAR_SECTIONS.length - 1);
    }
    // Enter/Space fall through to the button's native click → toggle.
  };

  return (
    <nav aria-label="Sections" data-section-rail className={styles.rail}>
      <Text size={100} weight="semibold" className={styles.groupLabel} aria-hidden>
        Sections
      </Text>
      {SIDEBAR_SECTIONS.map((section, i) => {
        const isOpen = openSection === section.id;
        const Icon = section.icon;
        return (
          <button
            key={section.id}
            type="button"
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            className={mergeClasses(styles.row, isOpen && styles.rowActive)}
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
            <span
              className={mergeClasses(styles.chevron, isOpen && styles.chevronOpen)}
              aria-hidden
            >
              <ChevronRightRegular />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
