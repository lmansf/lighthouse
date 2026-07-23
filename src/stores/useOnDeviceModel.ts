"use client";

import { create } from "zustand";
import { isDesktopShell, isMobileShell } from "@/shell/desktopBridge";

/**
 * add-mobile-local-inference: whether an on-device PRIVATE-model backend is
 * actually wired on THIS device, and which tier serves it. The engine already
 * owns the verdict (localModel.ts::localModelAvailable / the Rust twin); this
 * store carries the SHELL's answer into the UI so the roster
 * (`modelProvidersFor(platform, onDeviceBackend)`) and the honest per-tier copy
 * (`ON_DEVICE_MODEL_COPY`) can light the local entry up on a mobile shell.
 *
 * Contract consumed (backed separately by the Rust shell): the Tauri command
 * `private_model_availability` → { available, tier, reason }. The probe runs
 * lazily and ONLY on a mobile shell — desktop always shows local via
 * modelProvidersFor's `platform === "desktop"` short-circuit, so it never asks.
 * Any failure (plain web, an older shell without the command, a malformed
 * reply) leaves the fail-closed default { available: false, tier: "none" },
 * which keeps desktop and mobile-without-a-backend byte-identical.
 *
 * Unavailability is often TRANSIENT (iOS field report, 0.13.8): Apple
 * Intelligence gets enabled in the Settings app mid-session, or the on-device
 * model is still downloading (`modelNotReady`). So an AVAILABLE verdict latches
 * for the session, but an unavailable one does NOT — the store re-probes on the
 * next use (throttled) and when the app returns to the foreground, which is
 * exactly the "flipped the toggle in Settings, came back" flow. The Rust side's
 * `ensure` is idempotent and re-wires the engine's loopback URL the moment the
 * backend turns usable, so a mid-session flip lights the provider up live. The
 * honest `reason` is KEPT (not discarded) so Settings can say what to do
 * instead of silently hiding the private option.
 */
// §42: "llama" is the Tier-2 in-process GGUF backend (llama.cpp + Metal) on a
// non-FM iPhone — distinct from "llama-server" (the desktop supervised server).
export type OnDeviceTier = "foundation" | "gguf" | "llama" | "llama-server" | "none";

export interface OnDeviceModelState {
  available: boolean;
  tier: OnDeviceTier;
  /** The shell's honest unavailability reason (null when available/unknown). */
  reason: string | null;
  /**
   * §42 §4: the device is CAPABLE of the Tier-2 model but the ~1.1 GB GGUF
   * isn't downloaded yet (bridge code -7). The roster shows a download CTA in
   * exactly this state — never on a below-the-bar device, where the
   * empty-provider truths stand instead.
   */
  download: boolean;
}

const DEFAULT: OnDeviceModelState = {
  available: false,
  tier: "none",
  reason: null,
  download: false,
};

const useStore = create<OnDeviceModelState>(() => ({ ...DEFAULT }));

const TIERS: readonly OnDeviceTier[] = [
  "foundation",
  "gguf",
  "llama",
  "llama-server",
  "none",
];

/** Minimum ms between re-probes while the verdict is unavailable. */
const RETRY_MS = 4_000;

/**
 * Invoke a shell (Rust/Tauri) command, reusing the already-present
 * `@tauri-apps/api/core` via a dynamic import — the same tiny helper WidgetBar
 * and UpdateNotice each define locally (no new dependency). Resolves undefined
 * outside the shell or on any failure, so it never throws into the probe.
 */
async function invokeShell(cmd: string): Promise<unknown> {
  if (!isDesktopShell()) return undefined; // no Tauri shell ⇒ no command to call
  try {
    const core = await import("@tauri-apps/api/core");
    return await core.invoke(cmd);
  } catch {
    return undefined; // older shell / command absent ⇒ stay at the default
  }
}

async function probe(): Promise<void> {
  const reply = (await invokeShell("private_model_availability")) as
    | { available?: unknown; tier?: unknown; reason?: unknown; download?: unknown }
    | undefined;
  if (!reply || typeof reply !== "object") return; // failure ⇒ stay at the default
  const tier =
    typeof reply.tier === "string" && (TIERS as readonly string[]).includes(reply.tier)
      ? (reply.tier as OnDeviceTier)
      : "none";
  const available = reply.available === true;
  const download = reply.download === true;
  // §42 §4: the download-offer state (-7) is NOT "settled" — the model can be
  // installed mid-session, after which the next probe finds the live backend.
  if (available) settled = true; // a wired backend is stable for the session
  useStore.setState({
    available,
    tier,
    reason: !available && typeof reply.reason === "string" ? reply.reason : null,
    download,
  });
}

let settled = false;
let lastProbe = 0;
let foregroundHooked = false;

/**
 * Ask the shell whether an on-device backend is wired. Cheap + idempotent: a
 * plain-web browser settles without asking (the command never exists there); a
 * desktop shell never asks (local always shows there); a mobile shell asks on
 * first use — but only after `platformKind()` has resolved to a mobile form
 * factor (it is primed asynchronously from the first engine payload, so the
 * first hook uses can precede it). AVAILABLE latches; UNAVAILABLE re-probes on
 * later uses (≥ RETRY_MS apart) and on return to the foreground, because the
 * blocking condition (Apple Intelligence off, model still downloading) is
 * user-fixable mid-session.
 */
function maybeProbe(): void {
  if (settled || typeof window === "undefined") return;
  if (!isDesktopShell()) {
    settled = true; // plain web/dev — nothing to probe, ever
    return;
  }
  if (!isMobileShell()) return; // desktop, or platform not yet primed — recheck next use
  if (!foregroundHooked) {
    foregroundHooked = true;
    // The canonical recovery flow: user flips Apple Intelligence on in the
    // Settings app (or the model finishes downloading while away) and returns.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || settled) return;
      lastProbe = Date.now();
      void probe();
    });
  }
  const now = Date.now();
  if (now - lastProbe < RETRY_MS) return;
  lastProbe = now;
  void probe();
}

/**
 * The on-device-model availability, probed on a mobile shell (available latches;
 * unavailable retries). Components read `{ available, tier, reason }`, thread
 * `available` into `modelProvidersFor(platform, onDeviceBackend)` /
 * `switchChoices(...)`, use `tier` to pick `ON_DEVICE_MODEL_COPY[tier]` for the
 * honest description line, and surface `reason` when the backend is unavailable
 * so the user learns what would enable it instead of seeing nothing.
 */
export function useOnDeviceModel(): OnDeviceModelState {
  maybeProbe();
  return useStore();
}

/** Non-hook selector: is an on-device backend wired? (= the store's `available`). */
export function onDeviceBackendReady(): boolean {
  return useStore.getState().available;
}
