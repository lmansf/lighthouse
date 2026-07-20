"use client";

/**
 * §5 (iOS field patch 1): the compact phone layout's ONE width signal and its
 * pure verdict.
 *
 * paneLayout() is the single decision-maker for how the shell arranges its
 * panes: below COMPACT_BREAKPOINT on a MOBILE shell the chat pane is the
 * screen, the sidebar becomes an overlay drawer, section panels become
 * full-width sheets, and the explorer's resize machinery (handle + persisted
 * width) does not exist. The desktop platform NEVER takes the compact branch
 * — at any window width — so desktop rendering is byte-for-byte the 0.13.0
 * tree (the structural pin the unit tests hold); an iPad at ≥700pt likewise
 * keeps the desktop arrangement.
 *
 * The runtime signal is one shared matchMedia subscription (module singleton
 * behind useCompactViewport) — no per-component resize listeners, no
 * window-size polling. The verdict only THRESHOLDS the width, so the media
 * query's boundary crossing is the only width change that can alter any
 * output; sub-threshold pixel changes never re-render anything.
 */
import { useSyncExternalStore } from "react";
import { platformKind, type PlatformKind } from "./desktopBridge";

/** Compact when the viewport is NARROWER than this (px). */
export const COMPACT_BREAKPOINT = 700;

export interface PaneLayout {
  /** True only on a mobile shell below the breakpoint. */
  compact: boolean;
  /** How the file sidebar renders: a normal column, or an overlay drawer. */
  sidebarMode: "column" | "drawer";
  /** Whether the drawer is on screen right now (compact only — a stale
   *  drawerOpen can never leak into the desktop arrangement). */
  drawerVisible: boolean;
  /** The explorer resize handle exists only in the column arrangement. */
  showResizeHandle: boolean;
  /** Whether the persisted explorerWidth is applied to the sidebar. In the
   *  drawer it is neither applied nor (with the handle gone) ever persisted. */
  applyExplorerWidth: boolean;
  /** Section panels (Insights, History, …) render as full-width safe-area
   *  sheets instead of an inline column. */
  sectionsAsSheets: boolean;
}

/** The §5 verdict — pure, host-testable (test/paneLayout.test.mjs pins it,
 *  including the desktop-never-compact structural pin). */
export function paneLayout(
  width: number,
  drawerOpen: boolean,
  platform: PlatformKind,
): PaneLayout {
  const compact = platform !== "desktop" && width < COMPACT_BREAKPOINT;
  return {
    compact,
    sidebarMode: compact ? "drawer" : "column",
    drawerVisible: compact && drawerOpen,
    showResizeHandle: !compact,
    applyExplorerWidth: !compact,
    sectionsAsSheets: compact,
  };
}

// --- The ONE runtime width signal -------------------------------------------
// A module-level matchMedia singleton; every consumer (AppShell, the chat
// header's drawer button) shares the same subscription. The query is derived
// from COMPACT_BREAKPOINT so the CSS-side boundary and the verdict can't
// drift. -0.02px is the fractional-width guard (the media-query idiom for a
// strict `< 700`).
const COMPACT_QUERY = `(max-width: ${COMPACT_BREAKPOINT - 0.02}px)`;

let mql: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function ensureQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (!mql) {
    mql = window.matchMedia(COMPACT_QUERY);
    mql.addEventListener("change", () => {
      for (const l of listeners) l();
    });
  }
  return mql;
}

function subscribe(cb: () => void): () => void {
  ensureQuery();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while the viewport is below COMPACT_BREAKPOINT. SSR renders the
 *  non-compact (desktop) arrangement; the client corrects on hydration. */
export function useCompactViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ensureQuery()?.matches ?? false,
    () => false,
  );
}

/**
 * The live verdict for components. The boolean media-query state maps to a
 * representative width on the matching side of the threshold — legitimate
 * because the verdict only thresholds it (see module doc).
 */
export function usePaneLayout(drawerOpen: boolean): PaneLayout {
  const compactViewport = useCompactViewport();
  return paneLayout(
    compactViewport ? COMPACT_BREAKPOINT - 1 : COMPACT_BREAKPOINT,
    drawerOpen,
    platformKind(),
  );
}
