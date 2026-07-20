"use client";

/**
 * Sectioned-sidebar flyout (openspec: field-patch-0.12.5 §1) — the second left
 * column that slides out between the sidebar and main when a section header is
 * clicked. It mounts only while a section is open (one at a time), renders that
 * section's existing component verbatim, and closes on the X, Esc, a re-click of
 * its rail row, or a click outside the flyout+rail.
 *
 * Its width persists per window mode via the shared store (the explorer-width
 * idiom); a resize handle on its right edge reuses AppShell's ARIA
 * window-splitter pattern — pointer drag with capture, plus arrow/Home/End
 * keyboard resize. The slide honors prefers-reduced-motion. Beam tokens only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, mergeClasses, shorthands, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { sectionById } from "./sidebarSections";
import { FLYOUT_PANEL_ID } from "./SectionRail";
import { LAYOUT } from "./theme";
import { useSidebarFlyout } from "@/stores/useSidebarFlyout";
import { FLYOUT_MIN, FLYOUT_MAX } from "@/stores/sidebarFlyoutReducer";

/**
 * Portaled Fluent overlays a section may open (dialogs, menus, popovers,
 * tooltips) mount OUTSIDE the flyout DOM. Esc must reach them first, and a click
 * inside them must not read as "outside the flyout" — so both close paths spare
 * anything inside one of these surfaces. (`.fui-DialogSurface` is the same hook
 * FirstRunTour keys its first-run ordering off.)
 */
const OVERLAY_SELECTOR =
  '.fui-DialogSurface, .fui-MenuPopover, .fui-PopoverSurface, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]';

const useStyles = makeStyles({
  flyout: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    flexShrink: 0,
    minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
    overflow: "hidden",
    // The slide-in: transform + fade, honored off for reduced motion. Width is
    // NOT transitioned (it must track the drag handle live).
    transitionProperty: "transform, opacity",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
  // Pre-entrance state: nudged left + transparent; cleared on the next frame so
  // the panel eases into place.
  entering: { transform: "translateX(-12px)", opacity: 0 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    height: `${LAYOUT.headerHeight}px`,
    flexShrink: 0,
    ...shorthands.padding(0, tokens.spacingHorizontalS, 0, tokens.spacingHorizontalM),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  title: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    ...shorthands.padding(0, tokens.spacingHorizontalM),
  },
  // The right-edge resize divider — AppShell's handle, mirrored. A grab strip on
  // the border with a centered ::after hairline that lights on hover/focus/drag.
  handle: {
    flexShrink: 0,
    alignSelf: "stretch",
    width: "8px",
    marginLeft: "-4px",
    marginRight: "-4px",
    position: "relative",
    zIndex: 2,
    cursor: "col-resize",
    outlineStyle: "none",
    touchAction: "none",
    "::after": {
      content: '""',
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "50%",
      width: "2px",
      transform: "translateX(-50%)",
      backgroundColor: "transparent",
      transitionProperty: "background-color",
      transitionDuration: tokens.durationFast,
      transitionTimingFunction: tokens.curveEasyEase,
      "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
    },
    ":hover::after": { backgroundColor: tokens.colorNeutralStroke1 },
    ":focus-visible::after": { backgroundColor: tokens.colorBrandStroke1 },
  },
  handleActive: { "::after": { backgroundColor: tokens.colorBrandStroke1 } },
  // §5 compact: the panel as a full-width safe-area sheet over everything —
  // the phone has no room for a second column. Width comes from the viewport
  // (the store's persisted flyoutWidth is NOT applied), and the resize handle
  // does not exist. Esc and the X close it; there is no "outside" to click.
  sheet: {
    position: "fixed",
    inset: 0,
    zIndex: 30,
    width: "100%",
    borderRightWidth: 0,
    paddingTop: "var(--lh-safe-top)",
    paddingBottom: "var(--lh-safe-bottom)",
    paddingLeft: "var(--lh-safe-left)",
    paddingRight: "var(--lh-safe-right)",
  },
  // A thumb-sized close target on the sheet (≥44pt).
  sheetClose: { minWidth: "44px", minHeight: "44px" },
});

export function SectionFlyout({ compact = false }: { compact?: boolean } = {}) {
  const styles = useStyles();
  const openSection = useSidebarFlyout((s) => s.openSection);
  const flyoutWidth = useSidebarFlyout((s) => s.flyoutWidth);
  const setWidth = useSidebarFlyout((s) => s.setWidth);
  const close = useSidebarFlyout((s) => s.close);

  const section = sectionById(openSection);
  const asideRef = useRef<HTMLElement>(null);
  const [entered, setEntered] = useState(false);
  const [resizing, setResizing] = useState(false);

  // Entrance: clear the pre-entrance offset on the next frame so it eases in.
  useEffect(() => {
    if (!section) {
      setEntered(false);
      return;
    }
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, [section]);

  // Esc closes (capture so it wins even if focus is inside a section control that
  // doesn't stop propagation).
  useEffect(() => {
    if (!section) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let an open dialog/menu inside a section handle Esc first — don't yank
      // the whole flyout out from under it.
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [section, close]);

  // Click-outside: a pointerdown anywhere that is neither inside the flyout nor
  // inside the rail (which owns its own toggle) closes it. Not armed for the
  // §5 sheet — it covers the viewport, so there is no outside; Esc + X close.
  useEffect(() => {
    if (!section || compact) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (asideRef.current?.contains(t)) return;
      if (t.closest("[data-section-rail]")) return;
      // A click inside a portaled dialog/menu the section opened is NOT outside.
      if (t.closest(OVERLAY_SELECTOR)) return;
      close();
    };
    // Defer attaching until the next tick so the opening click (on the rail row)
    // doesn't immediately count as an outside click on some event orderings.
    const id = window.setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [section, close, compact]);

  // Pointer drag on the right edge: capture so moves keep arriving past other
  // elements; read the live start width from the store (getState is never stale).
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — the move listener still tracks within the strip */
    }
    dragRef.current = { startX: e.clientX, startW: useSidebarFlyout.getState().flyoutWidth };
    setResizing(true);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(d.startW + (e.clientX - d.startX));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
  };

  // Keyboard resize (the ARIA window-splitter pattern): arrows nudge, Home/End
  // jump to the bounds.
  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 24;
      const cur = useSidebarFlyout.getState().flyoutWidth;
      let next: number | null = null;
      if (e.key === "ArrowLeft") next = cur - STEP;
      else if (e.key === "ArrowRight") next = cur + STEP;
      else if (e.key === "Home") next = FLYOUT_MIN;
      else if (e.key === "End") next = FLYOUT_MAX;
      if (next !== null) {
        e.preventDefault();
        setWidth(next);
      }
    },
    [setWidth],
  );

  if (!section) return null;
  const Body = section.Component;

  return (
    <>
      <aside
        ref={asideRef}
        id={FLYOUT_PANEL_ID}
        role={compact ? "dialog" : "region"}
        aria-modal={compact || undefined}
        aria-label={section.label}
        className={mergeClasses(styles.flyout, !entered && styles.entering, compact && styles.sheet)}
        style={
          // §5 sheet: viewport-sized — the persisted flyoutWidth is not applied.
          compact
            ? undefined
            : ({
                width: `${flyoutWidth}px`,
                ...(resizing ? { transitionProperty: "none" } : {}),
              } as React.CSSProperties)
        }
      >
        <div className={styles.header}>
          <Text weight="semibold" className={styles.title}>
            {section.label}
          </Text>
          <Button
            appearance="subtle"
            size={compact ? "medium" : "small"}
            className={compact ? styles.sheetClose : undefined}
            icon={<DismissRegular />}
            aria-label="Close"
            onClick={() => close()}
          />
        </div>
        <div className={styles.body}>
          <Body />
        </div>
      </aside>
      {/* The resize handle exists only in the inline-column arrangement — a
          full-width sheet has nothing to resize. */}
      {!compact && (
        <div
          className={mergeClasses(styles.handle, resizing && styles.handleActive)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize section panel (drag, or use arrow keys)"
          aria-valuemin={FLYOUT_MIN}
          aria-valuemax={FLYOUT_MAX}
          aria-valuenow={flyoutWidth}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onHandleKeyDown}
        />
      )}
    </>
  );
}
