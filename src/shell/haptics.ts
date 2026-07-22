"use client";

/**
 * §31 haptics: the two touches Lighthouse uses, as fire-and-forget no-ops
 * everywhere they can't (or shouldn't) run. iOS only by design — macOS,
 * Windows, Linux, and the plain web resolve to nothing, and a shell without
 * the plugin (an older build) lands in the catch. Callers never await these.
 *
 *  - selectionChanged(): the iOS selection tick — segment changes, switch
 *    flips, picker rows.
 *  - impactLight(): a light impact — sheet detent snaps.
 *
 * The tauri-plugin-haptics npm wrapper is a thin shim over these exact
 * invoke calls (verified against the crate's commands.rs — vibrate /
 * impact_feedback{style} / notification_feedback{type} / selection_feedback,
 * styles serde-camelCased), so the UI calls the plugin directly and the
 * JS bundle stays wrapper-free.
 */

import { platformKind } from "./desktopBridge";

function canHaptic(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    platformKind() === "ios"
  );
}

function invokePlugin(cmd: string, args?: Record<string, unknown>): void {
  void import("@tauri-apps/api/core")
    .then((core) => core.invoke(cmd, args))
    .catch(() => {
      /* plugin absent (older shell) — quiet no-op */
    });
}

export function selectionChanged(): void {
  if (!canHaptic()) return;
  invokePlugin("plugin:haptics|selection_feedback");
}

export function impactLight(): void {
  if (!canHaptic()) return;
  invokePlugin("plugin:haptics|impact_feedback", { style: "light" });
}
