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
 *    concentric top radius, decorative grabber, sliding up on the spring
 *    (the §2 Sheet remains the primitive for NON-dialog surfaces; dialogs
 *    keep Fluent's focus/modal machinery and adopt the sheet's geometry).
 *
 * Migration is an import + tag swap: `<DialogSurface>` → `<LhDialogSurface>`;
 * DialogBody/Title/Content/Actions stay Fluent (they're layout that already
 * rides the token skin).
 */
import {
  DialogSurface,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  type DialogSurfaceProps,
} from "@fluentui/react-components";
import { usePaneLayout } from "../paneLayout";

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
  grabber: {
    width: "36px",
    height: "5px",
    ...shorthands.borderRadius("var(--lh-capsule)"),
    backgroundColor: "var(--lh-label-quaternary)",
    marginTop: "-6px",
    marginBottom: "10px",
    marginLeft: "auto",
    marginRight: "auto",
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
export function LhDialogSurface({ className, children, backdrop, ...rest }: LhDialogSurfaceProps) {
  const styles = useStyles();
  const compact = usePaneLayout(false).compact;
  // Callers that pass their own backdrop keep it; everyone else gets the scrim.
  const backdropSlot = backdrop !== undefined ? backdrop : { className: styles.scrim };
  return (
    <DialogSurface
      {...rest}
      backdrop={backdropSlot}
      className={mergeClasses(compact ? styles.sheet : styles.card, className)}
    >
      {compact && <div className={styles.grabber} aria-hidden data-lh-grabber />}
      {children}
    </DialogSurface>
  );
}
