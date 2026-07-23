/**
 * §43 §6 — the compact-dialog swipe-dismiss verdicts (CONVENTIONS "pure
 * verdict-fn pattern" + "interaction specs"). Ported from the §2 Sheet's proven
 * handler (src/shell/Sheet.tsx: DISMISS_SLACK / DISMISS_VELOCITY) so the shared
 * LhDialog compact sheet dismisses with the same feel. Two decisions, both pure
 * and host-tested (test/sheetDismiss.test.mjs):
 *
 *   - sheetDragArms: MAY a downward drag begin dismissing? From the grabber/
 *     header, always. From the body, ONLY when the scroll container is at the
 *     top (scrollTop 0) — otherwise a downward swipe is a content scroll, never
 *     a dismiss. This is the discrimination that keeps mid-content scrolling
 *     intact (overscroll-behavior:contain stays).
 *   - sheetDragDismisses: on release, dismiss on a downward flick (velocity past
 *     the threshold) OR a drag past the slack offset; otherwise spring back. An
 *     upward (negative) offset never dismisses.
 */

/** Drag past rest by this many px (or flick faster than the velocity) to dismiss. */
export const SHEET_DISMISS_SLACK = 80;
/** Downward flick speed (px/ms) that dismisses regardless of distance. */
export const SHEET_DISMISS_VELOCITY = 0.5;

/**
 * Whether a downward drag is allowed to begin a dismiss. The grabber/header arms
 * unconditionally (it is the drag handle); a drag starting in the scrollable
 * body arms only when that body is already scrolled to the top, so a swipe in
 * the middle of long content scrolls instead of dismissing.
 */
export function sheetDragArms({
  fromHandle,
  atScrollTop,
}: {
  fromHandle: boolean;
  atScrollTop: boolean;
}): boolean {
  return fromHandle || atScrollTop;
}

/**
 * The release verdict: dismiss on a downward flick OR a drag dragged past the
 * slack; otherwise spring back to rest. `offset` is px below rest (negative =
 * dragged up, never dismisses); `velocity` is px/ms, positive downward.
 */
export function sheetDragDismisses({
  offset,
  velocity,
}: {
  offset: number;
  velocity: number;
}): boolean {
  return velocity > SHEET_DISMISS_VELOCITY || offset > SHEET_DISMISS_SLACK;
}
