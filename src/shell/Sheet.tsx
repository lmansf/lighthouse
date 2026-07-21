"use client";

/**
 * 0.13.10 §2: the shared full-screen SHEET primitive — the §25 sheet idiom
 * (safe-area inset:0 surface, header with a ≥44pt close, scrollable body,
 * entrance ease, Esc-close) extracted from the retired SectionFlyout so any
 * feature can float a compact surface without the sections registry. History
 * and the investigation picker mount through this on compact.
 *
 * The module also carries the ONE "a sheet is open" signal
 * (useAnySheetOpen) the shell needs to slide the tab bar away — a plain
 * mount counter behind useSyncExternalStore, replacing the flyout store's
 * openSection !== null.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { LAYOUT } from "./theme";

/**
 * Portaled Fluent overlays a sheet's content may open (dialogs, menus,
 * popovers, tooltips) mount OUTSIDE the sheet DOM. Esc must reach them first —
 * the close path spares anything inside one of these surfaces.
 */
export const OVERLAY_SELECTOR =
  '.fui-DialogSurface, .fui-MenuPopover, .fui-PopoverSurface, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]';

// --- The "any sheet open" signal ---------------------------------------------
let openCount = 0;
const countListeners = new Set<() => void>();
function bumpCount(delta: number) {
  openCount += delta;
  for (const l of countListeners) l();
}
function subscribeCount(cb: () => void): () => void {
  countListeners.add(cb);
  return () => countListeners.delete(cb);
}

/** True while ANY Sheet is mounted — the tab bar slides away for the duration. */
export function useAnySheetOpen(): boolean {
  return useSyncExternalStore(
    subscribeCount,
    () => openCount > 0,
    () => false,
  );
}

const useStyles = makeStyles({
  sheet: {
    position: "fixed",
    inset: 0,
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground2,
    paddingTop: "var(--lh-safe-top)",
    paddingBottom: "var(--lh-safe-bottom)",
    paddingLeft: "var(--lh-safe-left)",
    paddingRight: "var(--lh-safe-right)",
    // The slide-in: transform + fade, honored off for reduced motion.
    transitionProperty: "transform, opacity",
    transitionDuration: tokens.durationSlow,
    transitionTimingFunction: tokens.curveEasyEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0.01ms" },
  },
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
  // A thumb-sized close target (≥44pt).
  close: { minWidth: "44px", minHeight: "44px" },
});

interface SheetProps {
  /** The sheet's header title — matches the content's own aria-label. */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * A full-screen compact sheet. Mount it conditionally — while mounted it
 * covers the viewport (there is no "outside" to click; Esc and the X close),
 * counts toward useAnySheetOpen, and eases in unless motion is reduced.
 */
export function Sheet({ title, onClose, children }: SheetProps) {
  const styles = useStyles();
  const [entered, setEntered] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount = open: count for the tab bar, ease in on the next frame.
  useEffect(() => {
    bumpCount(1);
    const r = requestAnimationFrame(() => setEntered(true));
    return () => {
      cancelAnimationFrame(r);
      bumpCount(-1);
    };
  }, []);

  // Esc closes (capture so it wins even inside content that doesn't stop
  // propagation) — unless a portaled overlay is up, which owns Esc first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={mergeClasses(styles.sheet, !entered && styles.entering)}
    >
      <div className={styles.header}>
        <Text weight="semibold" className={styles.title}>
          {title}
        </Text>
        <Button
          appearance="subtle"
          className={styles.close}
          icon={<DismissRegular />}
          aria-label="Close"
          onClick={() => onClose()}
        />
      </div>
      <div className={styles.body}>{children}</div>
    </aside>
  );
}
