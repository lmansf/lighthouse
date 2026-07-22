"use client";

/**
 * 0.13.10 §2 → §31 §2: the shared compact SHEET primitive, now the full Apple
 * bottom-sheet idiom — a floating glass panel that slides up over a scrim,
 * with a 36×5 grabber, medium/large detents with snap, swipe-to-dismiss, and
 * a concentric 26pt top radius. History, the investigation picker, and the
 * detail sheets mount through this on compact.
 *
 * Mechanics: the panel is sized to the LARGE detent (viewport minus the top
 * safe area and a breathing gap) and detents/dragging move it with a single
 * translateY. Dragging rides pointer capture on the header/grabber region —
 * the body keeps native scrolling (overscroll contained) and is never
 * hijacked. On release, position + flick velocity pick large, medium, or
 * dismiss; snaps ring the §1 spring tokens (one soft overshoot) and tick a
 * light haptic on iOS. Close (X, Esc, scrim tap, swipe) animates the panel
 * out before unmounting; reduced motion collapses every leg to a fade via the
 * global token overrides.
 *
 * The §31 §2 glass budget: this panel and the compact tab bar are the ONLY
 * two glass surfaces — the scrim is plain, the content layer is never glass,
 * and the recipe solidifies at intensity 0 / OS Reduce Transparency.
 *
 * The module also carries the ONE "a sheet is open" signal (useAnySheetOpen)
 * the shell needs to slide the tab bar away — a plain mount counter behind
 * useSyncExternalStore, replacing the flyout store's openSection !== null.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { IconClose } from "@/shell/icons";
import { impactLight } from "./haptics";

/**
 * Portaled Fluent overlays a sheet's content may open (dialogs, menus,
 * popovers, listboxes) mount OUTSIDE the sheet DOM. Esc must reach them
 * first — the close path spares anything inside one of these surfaces.
 * Deliberately no bare dialog-role selector here: the Sheet's own root (and
 * the shell's compact pages) carry that role, so a bare selector matched the
 * sheet itself and Esc could never close it. Fluent's portaled dialogs are
 * covered by their .fui-DialogSurface class.
 */
export const OVERLAY_SELECTOR =
  '.fui-DialogSurface, .fui-MenuPopover, .fui-PopoverSurface, [role="menu"], [role="listbox"], [role="tooltip"]';

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

/** Non-hook snapshot for event handlers (the shell's Esc arbitration). */
export function anySheetOpen(): boolean {
  return openCount > 0;
}

/** True while ANY Sheet is mounted — the tab bar slides away for the duration. */
export function useAnySheetOpen(): boolean {
  return useSyncExternalStore(
    subscribeCount,
    () => openCount > 0,
    () => false,
  );
}

// --- Detents -----------------------------------------------------------------

export type SheetDetent = "medium" | "large";

/** The medium detent shows this fraction of the viewport height. */
const MEDIUM_FRACTION = 0.55;
/** Breathing gap above the large detent (below the safe area). */
const LARGE_TOP_GAP = 10;
/** Drag past medium by this many px (or flick faster than DISMISS_VELOCITY)
 *  to dismiss. */
const DISMISS_SLACK = 80;
const DISMISS_VELOCITY = 0.5; // px/ms downward
/** How long the exit leg is given before unmount (matches --lh-dur). */
const EXIT_MS = 260;

const useStyles = makeStyles({
  // The scrim: plain (never glass), tap-to-dismiss, under the panel.
  scrim: {
    position: "fixed",
    inset: 0,
    zIndex: 29,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    transitionProperty: "opacity",
    transitionDuration: "var(--lh-dur-fade)",
    transitionTimingFunction: "linear",
  },
  scrimHidden: { opacity: 0 },
  panel: {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    // Large-detent height; detents/drag translate the panel, never resize it.
    height: "calc(100dvh - var(--lh-safe-top, 0px) - 10px)",
    // §31 §2: concentric sheet-top radius (26pt).
    borderTopLeftRadius: "var(--lh-radius-sheet)",
    borderTopRightRadius: "var(--lh-radius-sheet)",
    // The glass recipe (shared tokens; solid at level 0 / Reduce Transparency).
    backgroundColor:
      "color-mix(in srgb, var(--lh-bg-elevated) calc(100% - 38% * var(--lh-glass-level)), transparent)",
    backdropFilter:
      "blur(calc(var(--lh-glass-blur) * var(--lh-glass-level))) saturate(calc(100% + 80% * var(--lh-glass-level)))",
    boxShadow:
      "inset 0 0.5px 0 var(--lh-glass-highlight), 0 0 0 0.5px var(--lh-separator), var(--lh-shadow-sheet)",
    paddingLeft: "var(--lh-safe-left)",
    paddingRight: "var(--lh-safe-right)",
    // Detent snaps + entrance/exit — the bouncier spring sells the snap.
    transitionProperty: "transform",
    transitionDuration: "var(--lh-dur)",
    transitionTimingFunction: "var(--lh-spring-bounce)",
    willChange: "transform",
  },
  // While a pointer drags, the panel tracks the finger 1:1 — no easing.
  panelDragging: { transitionProperty: "none" },
  // The grabber region: the drag handle. Touch-action none so the drag owns
  // vertical pans here (the BODY keeps native scrolling).
  handleRegion: {
    touchAction: "none",
    cursor: "grab",
    flexShrink: 0,
  },
  grabber: {
    width: "36px",
    height: "5px",
    ...shorthands.borderRadius("var(--lh-capsule)"),
    backgroundColor: "var(--lh-label-quaternary)",
    marginTop: "8px",
    marginBottom: "4px",
    marginLeft: "auto",
    marginRight: "auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    minHeight: "44px",
    flexShrink: 0,
    ...shorthands.padding(0, tokens.spacingHorizontalS, 0, tokens.spacingHorizontalM),
  },
  title: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    // Never chain a body overscroll into the page behind the sheet.
    overscrollBehavior: "contain",
    ...shorthands.padding(0, tokens.spacingHorizontalM),
    paddingBottom: "var(--lh-safe-bottom)",
  },
  // A thumb-sized close target (≥44pt).
  close: { minWidth: "44px", minHeight: "44px" },
});

interface SheetProps {
  /** The sheet's header title — matches the content's own aria-label. */
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Where the sheet opens (drag between detents afterwards). Default large —
   *  parity with the previous full-screen surface; pickers pass "medium". */
  initialDetent?: SheetDetent;
}

/** The translateY (px) that presents a detent, given the panel's height. */
function detentOffset(detent: SheetDetent, panelHeight: number): number {
  if (detent === "large") return 0;
  const medium = Math.round(window.innerHeight * MEDIUM_FRACTION);
  return Math.max(0, panelHeight - medium);
}

/**
 * A compact bottom sheet. Mount it conditionally — while mounted it floats
 * over a scrim (tap outside, Esc, the X, or a downward swipe close it),
 * counts toward useAnySheetOpen, and springs between its detents.
 */
export function Sheet({ title, onClose, children, initialDetent = "large" }: SheetProps) {
  const styles = useStyles();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [detent, setDetent] = useState<SheetDetent>(initialDetent);
  const [dragging, setDragging] = useState(false);
  // The panel's current translateY. Starts off-screen (100% ≈ panel height);
  // the first frame springs it to the initial detent.
  const [offset, setOffset] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount = open: count for the tab bar, slide up on the next frame.
  useEffect(() => {
    bumpCount(1);
    const el = panelRef.current;
    if (el) setOffset(el.offsetHeight);
    const r = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const h = panelRef.current?.offsetHeight ?? 0;
        setOffset(detentOffset(initialDetent, h));
      }),
    );
    return () => {
      cancelAnimationFrame(r);
      bumpCount(-1);
    };
    // initialDetent is an opening posture, not a live prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The animated close: every close path funnels here so the panel slides out
  // before the caller unmounts it. Reduced motion (global token overrides)
  // makes the wait invisible.
  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    const h = panelRef.current?.offsetHeight ?? 0;
    setOffset(h);
    window.setTimeout(() => {
      onCloseRef.current();
    }, EXIT_MS);
  }, [closing]);

  // Esc closes (capture so it wins even inside content that doesn't stop
  // propagation) — unless a portaled overlay is up, which owns Esc first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Rotation/resize: re-seat the current detent (skip mid-drag/close).
  useEffect(() => {
    const onResize = () => {
      if (dragging || closing) return;
      const h = panelRef.current?.offsetHeight ?? 0;
      setOffset(detentOffset(detent, h));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [detent, dragging, closing]);

  // --- Drag on the grabber/header region --------------------------------------
  const drag = useRef<{ startY: number; startOffset: number; lastY: number; lastT: number; v: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (closing) return;
    const h = panelRef.current?.offsetHeight ?? 0;
    drag.current = {
      startY: e.clientY,
      startOffset: offset ?? detentOffset(detent, h),
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
    };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    // Track the finger; a small rubber-band above the large detent.
    const raw = d.startOffset + (e.clientY - d.startY);
    setOffset(raw >= 0 ? raw : raw / 3);
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    const h = panelRef.current?.offsetHeight ?? 0;
    const cur = offset ?? 0;
    const mediumOff = detentOffset("medium", h);
    // Flick or far-past-medium → dismiss; otherwise snap to the nearest detent.
    if (d.v > DISMISS_VELOCITY || cur > mediumOff + DISMISS_SLACK) {
      close();
      return;
    }
    const next: SheetDetent = Math.abs(cur - mediumOff) < Math.abs(cur - 0) ? "medium" : "large";
    if (next !== detent) impactLight();
    setDetent(next);
    setOffset(detentOffset(next, h));
  };

  return (
    <>
      <div
        className={mergeClasses(styles.scrim, (closing || offset === null) && styles.scrimHidden)}
        onClick={close}
        aria-hidden
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={mergeClasses(styles.panel, dragging && styles.panelDragging)}
        style={offset === null ? { transform: "translateY(100%)" } : { transform: `translateY(${offset}px)` }}
      >
        <div
          className={styles.handleRegion}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className={styles.grabber} aria-hidden />
          <div className={styles.header}>
            <Text weight="semibold" className={styles.title}>
              {title}
            </Text>
            <Button
              appearance="subtle"
              className={styles.close}
              icon={<IconClose />}
              aria-label="Close"
              onClick={close}
            />
          </div>
        </div>
        <div className={styles.body}>{children}</div>
      </aside>
    </>
  );
}
