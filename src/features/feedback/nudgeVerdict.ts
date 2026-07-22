/**
 * §33 §1: the compact feedback nudge's presentation gate, pure for tests (the
 * warmWaitVerdict house pattern). ELIGIBILITY (5 minutes of visible use, the
 * shown/snooze localStorage keys) is unchanged and lives in FeedbackNudge; this
 * verdict decides only WHEN an eligible compact nudge may actually present:
 * a calm moment on the Chat tab — nothing mid-task, nothing over navigation.
 * Desktop never consults it (the corner pill keeps its existing behavior).
 */

/** How long the calm moment must hold before the modal fades in. */
export const NUDGE_DWELL_MS = 3_000;

export interface NudgeGate {
  /** Compact (tab-bar) arrangement — the modal path exists only there. */
  compact: boolean;
  /** The Chat tab is the one on screen. */
  onChatTab: boolean;
  /** Continuous milliseconds the calm conditions below have held. */
  dwellMs: number;
  /** Any Sheet is up (useAnySheetOpen). */
  sheetOpen: boolean;
  /** Any modal dialog is up (.fui-DialogSurface — the tour fallback included). */
  dialogOpen: boolean;
  /** Software keyboard up or an editable focused. */
  keyboardUp: boolean;
  /** The first-run tour is active (body[data-tour-active]). */
  tourActive: boolean;
  /** An answer is streaming right now. */
  streaming: boolean;
}

/** The calm-moment conditions, dwell excluded — the ticker resets its dwell
 *  clock whenever this goes false, so `dwellMs` only accumulates calm time. */
export function nudgeCalm(g: NudgeGate): boolean {
  return (
    g.onChatTab && !g.sheetOpen && !g.dialogOpen && !g.keyboardUp && !g.tourActive && !g.streaming
  );
}

/** True exactly when the compact modal may present: calm has held for the dwell. */
export function nudgePresentVerdict(g: NudgeGate): boolean {
  return g.compact && nudgeCalm(g) && g.dwellMs >= NUDGE_DWELL_MS;
}
