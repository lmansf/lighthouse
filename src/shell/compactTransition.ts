import type { CompactTab } from "./paneLayout";

/**
 * §43 §3 — the compact page-stack verdict (CONVENTIONS "pure verdict-fn
 * pattern"). The compact shell shows Chat as an always-mounted base with the
 * Files and Settings tabs riding over it as z-21 full-screen pages. Before this
 * change every tab switch unmounted the outgoing page INSTANTLY, so the Chat
 * base flashed through on Files→Settings and Settings vanished without an exit
 * on Settings→Chat.
 *
 * This module owns the one testable decision behind the fix: given the
 * destination tab and the tab being left (kept mounted for the slide, `null`
 * once settled), what page layers mount, in what slide phase, at what z. The
 * shell renders Chat unconditionally beneath whatever this returns; the layers
 * are ordered bottom-to-top and their z agrees with that order.
 *
 * Invariants (pinned in test/compactTransition.test.mjs):
 *   - settled (leaving === null): exactly the destination page mounts, at rest,
 *     z 21 — byte-identical to the pre-§43 single-page render (Chat mounts no
 *     layer);
 *   - INTO a page: the destination `enter`s (slides in) on top at z 22; if the
 *     tab being left is ALSO a page it stays mounted BENEATH it at rest (z 21) —
 *     never the Chat base between two pages;
 *   - INTO chat: the left page `exit`s (slides out) over the Chat base, which is
 *     the revealed destination; there is no incoming layer;
 *   - the layer directly beneath the incoming is always the outgoing tab, and
 *     once settled only the destination remains mounted.
 *
 * prefers-reduced-motion is handled in CSS (the page style cross-fades instead
 * of sliding); this verdict is motion-mode agnostic.
 */

/** The two tabs that render as full-screen pages over the Chat base. */
export type CompactPageTab = "files" | "settings";

export const isCompactPageTab = (t: CompactTab): t is CompactPageTab =>
  t === "files" || t === "settings";

/** z of a page at rest — TODAY'S geometry; the constraint pins it to 21. */
export const PAGE_Z_REST = 21;
/** The incoming page floats one layer above a resting outgoing during the slide. */
export const PAGE_Z_ENTER = 22;

/**
 * The page slide duration in ms — mirrors styles.page's transitionDuration
 * (tokens.durationSlow = 300ms). The transition clears on the page's
 * transitionend; this drives the fallback timeout so a dropped event can never
 * strand the outgoing page mounted.
 */
export const PAGE_SLIDE_MS = 300;
/** Slack added to the fallback timeout over the nominal slide duration. */
export const PAGE_SLIDE_SLACK_MS = 80;

export type CompactPagePhase = "enter" | "exit" | "rest";

export interface CompactPageLayer {
  /** Which page renders. */
  tab: CompactPageTab;
  /** `enter` slides in from the left; `exit` slides out to the left; `rest` sits
   *  static (a settled page, or the outgoing page beneath an incoming one). */
  phase: CompactPagePhase;
  /** Stacking order — the incoming page (enter) rides above everything else. */
  z: number;
}

/**
 * The pure verdict: the page layers to mount for the compact shell, ordered
 * bottom-to-top. `active` is the destination tab (what the tab bar selected);
 * `leaving` is the tab being slid away from, kept mounted until the slide ends,
 * or `null` once settled. Chat is the base and never appears here.
 */
export function compactPageLayers(
  active: CompactTab,
  leaving: CompactTab | null,
): CompactPageLayer[] {
  const settling = leaving !== null && leaving !== active;
  const layers: CompactPageLayer[] = [];

  if (!settling) {
    // Settled: exactly the destination page (if it is a page) at rest.
    if (isCompactPageTab(active)) {
      layers.push({ tab: active, phase: "rest", z: PAGE_Z_REST });
    }
    return layers;
  }

  if (isCompactPageTab(active)) {
    // INTO a page. If we're also leaving a page, it rests beneath (added first,
    // so it sits lower in DOM order too); the destination slides in above it.
    if (isCompactPageTab(leaving as CompactTab)) {
      layers.push({ tab: leaving as CompactPageTab, phase: "rest", z: PAGE_Z_REST });
    }
    layers.push({ tab: active, phase: "enter", z: PAGE_Z_ENTER });
  } else if (isCompactPageTab(leaving as CompactTab)) {
    // INTO chat: the left page slides OUT over the Chat base (the destination).
    layers.push({ tab: leaving as CompactPageTab, phase: "exit", z: PAGE_Z_REST });
  }

  return layers;
}
