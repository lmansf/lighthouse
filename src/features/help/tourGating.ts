/**
 * Pure gating logic for the first-run tour, split out of FirstRunTour.tsx so it
 * can be unit-tested (test/firstRunTour.test.mjs) without importing the
 * React/Fluent component tree. The component owns rendering + persistence; this
 * owns only the once-per-install decision.
 */

/** The single install-global setting that gates the once-per-install tour. */
export const TOUR_SHOWN_SETTING = "tourShown";

/**
 * Whether the tour should auto-open on this launch, given the parsed
 * `/api/settings` response (or null/undefined when the read failed).
 *
 * Greet only when we positively read settings AND `tourShown` is not yet true:
 *  - fresh install (no `tourShown` key)                 → greet
 *  - a completed OR skipped tour (both persist true)    → never again
 *  - a failed settings read                             → greet nobody (never
 *                                                         risk greeting on
 *                                                         every launch)
 *
 * Because `tourShown` lives in the install-global desktop settings — not the
 * vault, not localStorage — switching vaults leaves it true, so the tour never
 * re-shows until the app-state dir is wiped.
 */
export function shouldAutoOpenTour(
  settings: { tourShown?: boolean } | null | undefined,
): boolean {
  return !!settings && settings.tourShown !== true;
}
