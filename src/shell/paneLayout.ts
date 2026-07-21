"use client";

/**
 * §5 (iOS field patch 1) → 0.13.10 §1: the compact layout's ONE viewport
 * signal and its pure verdict.
 *
 * paneLayout() is the single decision-maker for how the shell arranges its
 * panes: when the viewport's SHORT side is below COMPACT_BREAKPOINT on a
 * MOBILE shell the chat pane is the screen, the sidebar becomes a full-screen
 * PAGE that slides in from the left edge (fp3 §3 — no scrim, no overlay), and
 * the explorer's resize machinery (handle + persisted width) does not exist.
 * Thresholding the SHORT side (0.13.10 §1) makes a phone compact in BOTH
 * orientations — 844×390 landscape has an 844px width but only 390px of
 * height, and the desktop arrangement never fit there — while an iPad at
 * 1180×820 keeps the regular column (short side 820 ≥ 700) and narrow Split
 * View/Slide Over stays compact exactly as before. The desktop platform NEVER
 * takes the compact branch — at any window size, however short — so desktop
 * rendering is byte-for-byte unchanged (the structural pin the unit tests
 * hold).
 *
 * The runtime signal is one shared matchMedia subscription (module singleton
 * behind useCompactViewport) — a max-width/max-height media-query PAIR whose
 * OR is exactly "short side < breakpoint"; no per-component resize listeners,
 * no window-size polling. The verdict only THRESHOLDS the dimension, so the
 * query's boundary crossing is the only viewport change that can alter any
 * output; sub-threshold pixel changes never re-render anything.
 */
import { useSyncExternalStore } from "react";
import { platformKind, type PlatformKind } from "./desktopBridge";

/** Compact when the viewport's SHORT side is under this (px). */
export const COMPACT_BREAKPOINT = 700;

export interface PaneLayout {
  /** True only on a mobile shell below the breakpoint. */
  compact: boolean;
  /** How the file sidebar renders: a normal column (desktop / iPad ≥700pt), or
   *  — at compact (fp3 §3) — a full-screen "page" that slides in from the left
   *  edge over the chat (no scrim, no 85vw overlay). */
  sidebarMode: "column" | "page";
  /** Whether the files page is on screen right now (compact only — a stale
   *  drawerOpen can never leak into the desktop arrangement). */
  drawerVisible: boolean;
  /** The explorer resize handle exists only in the column arrangement. */
  showResizeHandle: boolean;
  /** Whether the persisted explorerWidth is applied to the sidebar. In the
   *  drawer it is neither applied nor (with the handle gone) ever persisted. */
  applyExplorerWidth: boolean;
  /** fp4 §3: the compact bottom tab bar (Chat · Files · Settings) is
   *  THE navigation on a mobile shell below the breakpoint. Desktop and an
   *  iPad-regular (≥700pt) never show it — they keep the persistent column — so
   *  this is `compact` exactly, and the unit tests pin the never-on-desktop
   *  half as a structural invariant. */
  showTabBar: boolean;
}

/**
 * fp4 §3 → 0.13.10 §2: the compact bottom-nav destinations. The set + order
 * live HERE as pure data (no Fluent, no icons) so `paneLayout` owns WHAT the
 * tabs are and WHEN the bar shows (`showTabBar`), and both are host-testable.
 * The tab bar component is purely presentational: it maps each id to an icon
 * and renders the labels.
 *
 * - chat: home / the ask surface (the base layer — no page overlaid).
 * - files: the fp3 §3 full-screen files page.
 * - settings: Settings as its own full page (0.13.10 §2 — the Sections tab is
 *   retired; its capabilities relocated to the chat header, Settings, and chat
 *   chips per the §30 audit).
 */
export type CompactTab = "chat" | "files" | "settings";

export interface CompactTabDef {
  id: CompactTab;
  /** The label under the icon (byte-identical across twins; pinned). */
  label: string;
}

export const COMPACT_TABS: readonly CompactTabDef[] = [
  { id: "chat", label: "Chat" },
  { id: "files", label: "Files" },
  { id: "settings", label: "Settings" },
];

/** The §5 verdict — pure, host-testable (test/paneLayout.test.mjs pins it,
 *  including the desktop-never-compact structural pin). `minDim` is the
 *  viewport's SHORT side (0.13.10 §1): min(width, height), so a phone is
 *  compact in both orientations while an iPad in full landscape stays regular. */
export function paneLayout(
  minDim: number,
  drawerOpen: boolean,
  platform: PlatformKind,
): PaneLayout {
  const compact = platform !== "desktop" && minDim < COMPACT_BREAKPOINT;
  return {
    compact,
    sidebarMode: compact ? "page" : "column",
    drawerVisible: compact && drawerOpen,
    showResizeHandle: !compact,
    applyExplorerWidth: !compact,
    showTabBar: compact,
  };
}

// --- The ONE runtime viewport signal ----------------------------------------
// A module-level matchMedia singleton; every consumer (AppShell, the chat
// header's drawer button) shares the same subscription. 0.13.10 §1: the query
// is a max-width/max-height PAIR — the comma is a media-query OR, and
// (w < 700) OR (h < 700) is exactly min(w, h) < 700 — so one matchMedia still
// carries the whole short-side signal (the single-signal discipline). Derived
// from COMPACT_BREAKPOINT so the CSS-side boundary and the verdict can't
// drift. -0.02px is the fractional-width guard (the media-query idiom for a
// strict `< 700`).
const COMPACT_QUERY = `(max-width: ${COMPACT_BREAKPOINT - 0.02}px), (max-height: ${COMPACT_BREAKPOINT - 0.02}px)`;

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

/** True while the viewport's SHORT side is below COMPACT_BREAKPOINT. SSR
 *  renders the non-compact (desktop) arrangement; the client corrects on
 *  hydration. Platform-blind — the desktop pin lives in paneLayout(), which
 *  every layout consumer goes through. */
export function useCompactViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ensureQuery()?.matches ?? false,
    () => false,
  );
}

/**
 * The live verdict for components. The boolean media-query state maps to a
 * representative min-dimension on the matching side of the threshold —
 * legitimate because the verdict only thresholds it (see module doc).
 */
export function usePaneLayout(drawerOpen: boolean): PaneLayout {
  const compactViewport = useCompactViewport();
  return paneLayout(
    compactViewport ? COMPACT_BREAKPOINT - 1 : COMPACT_BREAKPOINT,
    drawerOpen,
    platformKind(),
  );
}

// --- The touch (pointer) axis (iOS field patch 3 §2) ------------------------
// A SECOND, orthogonal signal. `compact` (above) thresholds WIDTH and drives
// PRESENTATION (drawer/page/sheets); this thresholds the primary POINTER and
// drives SIZING (≥44pt tap targets, touch-action). They are deliberately
// distinct: an iPad at ≥700pt is NOT compact (keeps the desktop arrangement)
// but IS coarse-pointer (gets touch-grade sizing), and a desktop with a
// touchscreen is coarse yet must never compact. Same shared-singleton pattern
// as the width query — one matchMedia, every consumer subscribes.
const COARSE_POINTER_QUERY = "(pointer: coarse)";

let pmql: MediaQueryList | null = null;
const pointerListeners = new Set<() => void>();

function ensurePointerQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (!pmql) {
    pmql = window.matchMedia(COARSE_POINTER_QUERY);
    pmql.addEventListener("change", () => {
      for (const l of pointerListeners) l();
    });
  }
  return pmql;
}

function subscribePointer(cb: () => void): () => void {
  ensurePointerQuery();
  pointerListeners.add(cb);
  return () => pointerListeners.delete(cb);
}

/**
 * True when the primary input is a coarse pointer (touch): every iPhone and
 * iPad, plus a touchscreen laptop. The tap-sizing axis — NOT a form-factor or
 * width proxy. SSR renders the fine-pointer (mouse) default; the client
 * corrects on hydration. Hardware keyboards are orthogonal again: an iPad with
 * a Magic Keyboard is still coarse-pointer, so keyboard affordances stay live
 * even where the touch HINT COPY is hidden.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribePointer,
    () => ensurePointerQuery()?.matches ?? false,
    () => false,
  );
}
