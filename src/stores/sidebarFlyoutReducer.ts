/**
 * Sectioned-sidebar flyout — the PURE reducer core (openspec: field-patch-0.12.5
 * §1). The Files tree anchors the sidebar; the six other sections become
 * header-only rows that slide out a second panel (the flyout). This module holds
 * ONLY the state math — open/toggle/close, width clamping, and hydration from a
 * persisted partial — with no React, no zustand, no Fluent, and no `window`. That
 * keeps it importable straight into the node test runner (which cannot load
 * `.tsx` or `@fluentui/react-components`), so the open/close/persist logic is unit
 * tested in isolation. The zustand store (`useSidebarFlyout.ts`) wraps these with
 * the side effects (localStorage cache + `POST /api/settings`).
 *
 * Width bounds mirror the settings twin's FLYOUT_WIDTH_MIN/MAX (both the TS
 * `src/server/settings.ts` and the Rust `settings.rs`) — keep the three in sync.
 */

/** Flyout width drag bounds. PARITY: FLYOUT_WIDTH_MIN/MAX in settings.ts + settings.rs. */
export const FLYOUT_MIN = 280;
export const FLYOUT_MAX = 680;
/** The width a never-dragged flyout opens at (until the user resizes or a
 *  persisted width hydrates). Sits comfortably inside the bounds. */
export const FLYOUT_DEFAULT = 360;

/** Clamp a width to the flyout bounds and round to a whole pixel — the same
 *  shape as AppShell's `clampWidth` for the sidebar. Non-finite ⇒ the default. */
export function clampFlyoutWidth(w: number): number {
  if (!Number.isFinite(w)) return FLYOUT_DEFAULT;
  return Math.min(FLYOUT_MAX, Math.max(FLYOUT_MIN, Math.round(w)));
}

/** The client-side flyout state. `openSection` is the id of the one open section
 *  (only one flyout at a time) or null when closed; `flyoutWidth` is the current
 *  panel width in px, always kept within bounds. */
export interface FlyoutState {
  openSection: string | null;
  flyoutWidth: number;
}

/** A persisted/partial snapshot used to hydrate — every field optional so a
 *  cache miss or a web build (no settings file) simply leaves the default. */
export interface FlyoutHydrate {
  openSection?: string | null;
  flyoutWidth?: number | null;
}

export const initialFlyoutState: FlyoutState = {
  openSection: null,
  flyoutWidth: FLYOUT_DEFAULT,
};

/** Open a specific section's flyout (replacing any other — one open at a time). */
export function reduceOpen(state: FlyoutState, id: string): FlyoutState {
  if (!id || state.openSection === id) return state;
  return { ...state, openSection: id };
}

/** Toggle a section: open it, or close it if it's already the open one. This is
 *  the header-row click / re-click behavior. */
export function reduceToggle(state: FlyoutState, id: string): FlyoutState {
  if (!id) return state;
  return { ...state, openSection: state.openSection === id ? null : id };
}

/** Close whatever flyout is open (Esc / click-outside / the X). A no-op when
 *  already closed, so it never churns state or triggers a redundant persist. */
export function reduceClose(state: FlyoutState): FlyoutState {
  if (state.openSection === null) return state;
  return { ...state, openSection: null };
}

/** Set the flyout width, clamped to the bounds. */
export function reduceSetWidth(state: FlyoutState, w: number): FlyoutState {
  const next = clampFlyoutWidth(w);
  if (next === state.flyoutWidth) return state;
  return { ...state, flyoutWidth: next };
}

/**
 * Adopt a persisted/cached snapshot. Only the fields actually present are taken
 * (so a partial hydrate never clobbers a good value with a default); the width is
 * re-clamped on the way in so a hand-edited settings file can't force an unusable
 * panel. `openSection` accepts an explicit null (persisted "closed"); an empty
 * string collapses to null. Registry validity (is this a REAL section?) is the
 * caller's job — the reducer stays registry-agnostic.
 */
export function reduceHydrate(state: FlyoutState, partial: FlyoutHydrate): FlyoutState {
  const next: FlyoutState = { ...state };
  if (partial.openSection !== undefined) {
    next.openSection = partial.openSection ? partial.openSection : null;
  }
  if (typeof partial.flyoutWidth === "number" && Number.isFinite(partial.flyoutWidth)) {
    next.flyoutWidth = clampFlyoutWidth(partial.flyoutWidth);
  }
  return next;
}
