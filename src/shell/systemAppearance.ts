"use client";

/**
 * §31: the OS "Reduce Transparency" accessibility setting. WKWebView exposes
 * no `prefers-reduced-transparency` media query, so the shell reads the OS
 * setting natively (iOS UIAccessibility / macOS NSWorkspace — the
 * `reduce_transparency` command in lighthouse-desktop) and providers.tsx
 * stamps `data-reduce-transparency` on the document root, which globals.css
 * turns into the solid-surface overrides. Outside the Tauri shell (web dev,
 * tests) there is no OS to ask — resolve false and let the in-app glass
 * slider be the only control.
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function readReduceTransparency(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const core = await import("@tauri-apps/api/core");
    return Boolean(await core.invoke<boolean>("reduce_transparency"));
  } catch {
    // Older shell without the command — behave as if the setting is off.
    return false;
  }
}
