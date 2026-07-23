"use client";

/**
 * §31 §3: the dialog surface — one shared component for every dialog in the
 * app. Fluent's Dialog machinery stays as the HEADLESS layer (portal, focus
 * trap, modality, Esc handling — exactly the "headless primitive with the
 * token skin" the spec allows); every visible pixel is ours:
 *
 *  - desktop: a floating 16-radius card on the ambient shadow, rising 8px
 *    with a fade on the §1 spring; the backdrop is the quiet 20% scrim.
 *  - compact: the sheet idiom — bottom-anchored full-width panel, 26pt
 *    concentric top radius, a grabber, sliding up on the spring, and
 *    (§43 §6) swipe-to-dismiss (the §2 Sheet remains the primitive for
 *    NON-dialog surfaces; dialogs keep Fluent's focus/modal machinery and
 *    adopt the sheet's geometry AND gesture).
 *
 * §43 §6 swipe-dismiss: because this is the ONE compact-dialog primitive,
 * wiring the gesture here fixes Preferences, AI models, Audit log, About,
 * Business definitions and Saved views at once. The grabber is the drag handle
 * (and a real Close control for keyboard/AT); a downward drag from the grabber
 * OR from the top of the scrolled content (sheetDragArms) translates the panel
 * and, on release, dismisses on a flick or a past-slack drag (sheetDragDismisses
 * — the §2 Sheet's proven verdict, tested pure in test/sheetDismiss.test.mjs) or
 * springs back. A swipe MID-content just scrolls (overscroll-behavior:contain
 * stays). Dismiss calls Fluent's own requestOpenChange(false) via the dialog
 * context, so every caller's onOpenChange fires exactly as it does for Esc/scrim
 * — no per-call-site wiring, and never the shell's Esc→back path.
 *
 * Migration is an import + tag swap: `<DialogSurface>` → `<LhDialogSurface>`;
 * DialogBody/Title/Content/Actions stay Fluent (they're layout that already
 * rides the token skin).
 */
import { useCallback, useRef, useState } from "react";
import {
  DialogSurface,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  useDialogContext_unstable,
  type DialogSurfaceProps,
} from "@fluentui/react-components";
import { usePaneLayout } from "../paneLayout";
import { sheetDragArms, sheetDragDismisses } from "./sheetDismiss";

/** The exit slide before Fluent unmounts the surface (matches --lh-dur feel). */
const EXIT_MS = 260;
/** A body drag must move this far DOWN before it commits to a dismiss (vs a
 *  scroll intent); the grabber commits on any move. */
const ENGAGE_PX = 6;

const useStyles = makeStyles({
  scrim: { backgroundColor: "rgba(0, 0, 0, 0.2)" },
  card: {
    ...shorthands.borderRadius("var(--lh-radius-surface)"),
    ...shorthands.borderStyle("none"),
    boxShadow: "0 0 0 0.5px var(--lh-separator), var(--lh-shadow-sheet)",
    animationName: {
      from: { opacity: 0, transform: "translateY(8px) scale(0.98)" },
      to: { opacity: 1, transform: "translateY(0) scale(1)" },
    },
    animationDuration: "var(--lh-dur)",
    animationTimingFunction: "var(--lh-spring)",
  },
  sheet: {
    // The sheet arrangement: pinned to the bottom edge, full width, top
    // corners on the 26pt radius, safe-area padded.
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    marginBottom: 0,
    maxWidth: "100%",
    width: "100%",
    ...shorthands.borderRadius(0),
    borderTopLeftRadius: "var(--lh-radius-sheet)",
    borderTopRightRadius: "var(--lh-radius-sheet)",
    ...shorthands.borderStyle("none"),
    boxShadow: "inset 0 0.5px 0 var(--lh-glass-highlight), 0 0 0 0.5px var(--lh-separator), var(--lh-shadow-sheet)",
    paddingBottom: "calc(var(--lh-safe-bottom, 0px) + 16px)",
    paddingLeft: "calc(var(--lh-safe-left, 0px) + 16px)",
    paddingRight: "calc(var(--lh-safe-right, 0px) + 16px)",
    maxHeight: "calc(100dvh - var(--lh-safe-top, 0px) - 24px)",
    overflowY: "auto",
    overscrollBehavior: "contain",
    animationName: {
      from: { opacity: 0.6, transform: "translateY(48px)" },
      to: { opacity: 1, transform: "translateY(0)" },
    },
    animationDuration: "var(--lh-dur)",
    animationTimingFunction: "var(--lh-spring-bounce)",
  },
  // §43 §6: while a dismiss drag is engaged the panel tracks the finger 1:1
  // (no transition) and native scroll stands down (touch-action none).
  sheetDragging: { transitionProperty: "none", touchAction: "none" },
  // Between drags (spring-back / the exit slide) the panel eases on the spring.
  sheetSpring: {
    transitionProperty: "transform",
    transitionDuration: "var(--lh-dur)",
    transitionTimingFunction: "var(--lh-spring-bounce)",
    willChange: "transform",
  },
  grabber: {
    width: "36px",
    height: "5px",
    ...shorthands.borderRadius("var(--lh-capsule)"),
    backgroundColor: "var(--lh-label-quaternary)",
    marginTop: "-6px",
    marginBottom: "10px",
    marginLeft: "auto",
    marginRight: "auto",
    // §43 §6: it's the drag handle AND a Close control now — a bigger, grabbable
    // hit area with its own touch-action so a drag here never scrolls the body.
    boxSizing: "content-box",
    ...shorthands.padding("10px", "16px"),
    cursor: "grab",
    touchAction: "none",
    ...shorthands.border("none"),
    backgroundClip: "content-box",
    display: "block",
  },
  // (Reduced motion: both animations ride var(--lh-dur*), which the global
  // PRM override collapses to 0.01ms — entrances become cuts, no extra CSS.)
});

// Keep the grabber's Griffel class stable for tests without exporting styles.
export type LhDialogSurfaceProps = DialogSurfaceProps;

/**
 * The one dialog surface. Drop-in for Fluent's `DialogSurface` — same props,
 * same children (DialogBody/Title/Content/Actions), adaptive geometry.
 */
export function LhDialogSurface({ className, children, backdrop, style, ...rest }: LhDialogSurfaceProps) {
  const styles = useStyles();
  const compact = usePaneLayout(false).compact;
  // Fluent's own close request — the same one Esc/scrim use; the caller's
  // onOpenChange fires through it (no per-dialog wiring). No-op off a provider.
  const requestOpenChange = useDialogContext_unstable((ctx) => ctx.requestOpenChange);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  // `engaged` gates the inline transform so it never shadows the entrance
  // animation until a drag has actually begun this mount.
  const [engaged, setEngaged] = useState(false);
  const closingRef = useRef(false);
  // True for the duration of a gesture that actually engaged a drag — it
  // suppresses the synthetic click the browser fires on pointerup so a
  // spring-back (release on the grabber) can never fall through to onClick.
  const draggedRef = useRef(false);
  const drag = useRef<{
    startY: number;
    lastY: number;
    lastT: number;
    v: number;
    fromHandle: boolean;
    captured: boolean;
  } | null>(null);

  // Animate the panel down, then let Fluent unmount it (its requestOpenChange
  // runs the caller's onOpenChange). Idempotent — the first dismiss wins.
  const dismiss = useCallback(
    (event: React.SyntheticEvent<HTMLElement>) => {
      if (closingRef.current) return;
      closingRef.current = true;
      setDragging(false);
      setEngaged(true);
      setDragY(surfaceRef.current?.offsetHeight ?? 800);
      window.setTimeout(() => {
        requestOpenChange({
          open: false,
          type: "backdropClick",
          event: event as unknown as React.MouseEvent<HTMLElement>,
        });
      }, EXIT_MS);
    },
    [requestOpenChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!compact || closingRef.current || e.button !== 0) return;
    const surface = surfaceRef.current;
    const fromHandle = !!(e.target as HTMLElement).closest?.("[data-lh-grabber]");
    const atScrollTop = (surface?.scrollTop ?? 0) <= 0;
    if (!sheetDragArms({ fromHandle, atScrollTop })) return; // a mid-content drag scrolls
    draggedRef.current = false;
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0, fromHandle, captured: false };
    // The grabber can't scroll (touch-action none), so capture immediately; a
    // body drag waits until it commits downward, so native scroll is undisturbed
    // if the user is really scrolling up.
    if (fromHandle) {
      try {
        surface?.setPointerCapture(e.pointerId);
        drag.current.captured = true;
      } catch {
        /* capture unsupported — moves still track within the surface */
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!dragging) {
      // A body drag going UP is a scroll — release the candidate and let it be.
      if (!d.fromHandle && dy < -ENGAGE_PX) {
        drag.current = null;
        return;
      }
      const commits = d.fromHandle ? Math.abs(dy) > 2 : dy > ENGAGE_PX;
      if (!commits) return;
      if (!d.captured) {
        try {
          surfaceRef.current?.setPointerCapture(e.pointerId);
          d.captured = true;
        } catch {
          /* capture unsupported */
        }
      }
      setDragging(true);
      setEngaged(true);
      draggedRef.current = true;
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    // Track the finger downward; upward is clamped at rest (bottom-anchored).
    setDragY(Math.max(0, dy));
    e.preventDefault();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const wasDragging = dragging;
    setDragging(false);
    if (d.captured) {
      try {
        surfaceRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
    }
    if (!wasDragging) return; // a tap (no engage) — the grabber's onClick handles it
    if (sheetDragDismisses({ offset: dragY, velocity: d.v })) {
      dismiss(e);
    } else {
      setDragY(0); // spring back (the spring transition is live now)
    }
  };

  // The grabber is a real Close control for keyboard / assistive tech (drag is a
  // pointer-only affordance); a pointer TAP that never engaged also lands here.
  const onGrabberActivate = (e: React.SyntheticEvent<HTMLElement>) => {
    // Suppress the click the browser fires at the end of a drag (engage set the
    // flag); a genuine tap never engaged, so it dismisses.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    dismiss(e);
  };
  const onGrabberKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dismiss(e);
    }
  };

  // Callers that pass their own backdrop keep it; everyone else gets the scrim.
  const backdropSlot = backdrop !== undefined ? backdrop : { className: styles.scrim };
  const dragStyle: React.CSSProperties | undefined =
    compact && engaged ? { transform: `translateY(${dragY}px)` } : undefined;

  return (
    <DialogSurface
      {...rest}
      ref={surfaceRef}
      backdrop={backdropSlot}
      style={dragStyle ? { ...(style as React.CSSProperties), ...dragStyle } : style}
      className={mergeClasses(
        compact ? styles.sheet : styles.card,
        compact && dragging && styles.sheetDragging,
        compact && engaged && !dragging && styles.sheetSpring,
        className,
      )}
      onPointerDown={compact ? onPointerDown : undefined}
      onPointerMove={compact ? onPointerMove : undefined}
      onPointerUp={compact ? onPointerUp : undefined}
      onPointerCancel={compact ? onPointerUp : undefined}
    >
      {compact && (
        <div
          className={styles.grabber}
          data-lh-grabber
          role="button"
          tabIndex={0}
          aria-label="Close"
          onClick={onGrabberActivate}
          onKeyDown={onGrabberKeyDown}
        />
      )}
      {children}
    </DialogSurface>
  );
}
