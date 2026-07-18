"use client";

import { create } from "zustand";
import {
  initialFlyoutState,
  clampFlyoutWidth,
  reduceOpen,
  reduceToggle,
  reduceClose,
  reduceSetWidth,
  reduceHydrate,
  type FlyoutState,
  type FlyoutHydrate,
} from "./sidebarFlyoutReducer";

/**
 * Sectioned-sidebar flyout store (openspec: field-patch-0.12.5 §1). Holds which
 * section's flyout is open and the panel width, and persists both the way the
 * 0.12.3 explorer width persists: an instant localStorage cache for first paint
 * plus a durable `POST /api/settings` (per-mode width, debounced; the open
 * section immediate). The pure state math lives in `sidebarFlyoutReducer.ts` so
 * it unit-tests without React/Fluent; this module is only the side effects.
 *
 * Mirrors useAppearanceStore's shape: SSR-safe defaults at create, a browser
 * bootstrap that adopts the cache, and AppShell reconciling against the
 * authoritative settings file (it owns the `uiMode` + the fetch, and validates
 * the open-section id against the registry before handing it to `hydrate`).
 */

type UiMode = "window" | "widget";
const CACHE_KEY = "lighthouse.sidebar.flyout";

interface FlyoutCache {
  open?: string | null;
  width?: { window?: number; widget?: number };
}

function readCache(): FlyoutCache {
  if (typeof window === "undefined") return {};
  try {
    const p = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "{}");
    return p && typeof p === "object" ? (p as FlyoutCache) : {};
  } catch {
    return {};
  }
}

function writeCache(patch: FlyoutCache): void {
  if (typeof window === "undefined") return;
  try {
    const cur = readCache();
    const next: FlyoutCache = {
      ...cur,
      ...patch,
      width: { ...(cur.width ?? {}), ...(patch.width ?? {}) },
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — the in-session state still works */
  }
}

// The persisted-width key: the current window mode. Module-scoped (not store
// state) because it keys persistence but never renders; AppShell teaches it via
// hydrate({ mode }) once /api/settings answers. Until then "window" — the same
// default AppShell uses for its own width, so a pre-reconcile write lands in the
// right bucket on the overwhelmingly common window-mode desktop.
let mode: UiMode = "window";
let postTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the open-section id: cache immediately, settings file right away (a
 *  400 on the web build is expected and ignored). Empty string = closed. */
function persistOpen(openSection: string | null): void {
  writeCache({ open: openSection });
  void fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ openFlyout: openSection ?? "" }),
  }).catch(() => {
    /* desktop-only endpoint; the web build 400s — the cache is enough */
  });
}

/** Persist the width for the current mode: cache immediately, settings file on a
 *  short debounce so a drag coalesces into one write (the AppShell precedent). */
function persistWidth(width: number): void {
  const c = clampFlyoutWidth(width);
  writeCache({ width: { [mode]: c } });
  if (postTimer) clearTimeout(postTimer);
  postTimer = setTimeout(() => {
    void fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flyoutWidth: { mode, width: c } }),
    }).catch(() => {
      /* web build / offline — the cache carries reload persistence */
    });
  }, 400);
}

interface SidebarFlyoutStore extends FlyoutState {
  /** Open a section's flyout (one at a time). */
  open: (id: string) => void;
  /** Toggle: open a section, or close it if it's already open (header re-click). */
  toggle: (id: string) => void;
  /** Close whatever flyout is open (Esc / click-outside / the X). */
  close: () => void;
  /** Set + persist the flyout width, clamped to the bounds. */
  setWidth: (w: number) => void;
  /**
   * Adopt persisted/cached values WITHOUT re-persisting (no echo write). Also the
   * seam AppShell uses to teach the store the current window mode. Called from
   * the browser bootstrap (cache) and from AppShell's settings reconcile.
   */
  hydrate: (partial: FlyoutHydrate & { mode?: UiMode }) => void;
}

export const useSidebarFlyout = create<SidebarFlyoutStore>((set, get) => ({
  ...initialFlyoutState,
  open: (id) => {
    const next = reduceOpen(get(), id);
    if (next === get()) return;
    set(next);
    persistOpen(next.openSection);
  },
  toggle: (id) => {
    const next = reduceToggle(get(), id);
    if (next === get()) return;
    set(next);
    persistOpen(next.openSection);
  },
  close: () => {
    const next = reduceClose(get());
    if (next === get()) return;
    set(next);
    persistOpen(next.openSection);
  },
  setWidth: (w) => {
    const next = reduceSetWidth(get(), w);
    set(next);
    persistWidth(next.flyoutWidth);
  },
  hydrate: (partial) => {
    if (partial.mode === "window" || partial.mode === "widget") mode = partial.mode;
    set(reduceHydrate(get(), partial));
  },
}));

// Browser bootstrap: adopt the cached values immediately (instant paint, pre-
// fetch), mirroring AppShell's synchronous width cache. The AppShell settings
// fetch reconciles against the authoritative per-mode file right after. Width
// comes from the window bucket — the default mode until AppShell learns it.
if (typeof window !== "undefined") {
  const cache = readCache();
  useSidebarFlyout.getState().hydrate({
    openSection: cache.open ?? null,
    flyoutWidth: cache.width?.window,
  });
}
