import { create } from "zustand";

/**
 * Theme preference: light, dark, or follow the OS. `mode` is what the user
 * chose (persisted); `resolved` is what actually renders ("system" collapsed
 * to the OS's current scheme). app/providers.tsx swaps the Fluent theme off
 * `resolved`; Preferences writes `mode` via `setMode`.
 */
export type ThemeMode = "light" | "dark" | "system";

const KEY = "lighthouse.theme.mode";

function loadMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    return "system";
  }
}

function saveMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* private mode / storage full - the in-session choice still applies */
  }
}

/** Collapse a mode to what should render right now (SSR defaults to light). */
function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeStore {
  /** The user's persisted choice. */
  mode: ThemeMode;
  /** What actually renders - "system" resolved against the OS scheme. */
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  // The initial state is a deterministic light/system, NOT the stored/OS
  // value: zustand v5 hands `getInitialState()` to useSyncExternalStore as the
  // hydration snapshot, and it must match what the server rendered - otherwise
  // React adopts the server's light styles without ever re-rendering them
  // (production skips attribute diffing during hydration) and a dark-OS user
  // would be stuck on light. The bootstrap below moves state to the real value
  // right after module init; useSyncExternalStore sees the change post-
  // hydration and re-renders with the correct theme.
  mode: "system",
  resolved: "light",
  setMode: (mode) => {
    saveMode(mode);
    set({ mode, resolved: resolve(mode) });
  },
}));

// Client bootstrap: adopt the persisted mode, and track the OS scheme so
// "system" follows a live light<->dark switch without a reload. Module scope
// (not a hook) so it runs once no matter how many components subscribe.
if (typeof window !== "undefined") {
  const stored = loadMode();
  useThemeStore.setState({ mode: stored, resolved: resolve(stored) });
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      // resolve() re-reads matchMedia; for explicit light/dark modes this is a
      // no-op (resolved doesn't change), so no guard on mode is needed.
      useThemeStore.setState({ resolved: resolve(useThemeStore.getState().mode) });
    });
}
