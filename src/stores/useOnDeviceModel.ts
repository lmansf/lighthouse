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
 * once, lazily, and ONLY on a mobile shell — desktop always shows local via
 * modelProvidersFor's `platform === "desktop"` short-circuit, so it never asks.
 * Any failure (plain web, an older shell without the command, a malformed
 * reply) leaves the fail-closed default { available: false, tier: "none" },
 * which keeps desktop and mobile-without-a-backend byte-identical.
 */
export type OnDeviceTier = "foundation" | "gguf" | "llama-server" | "none";

export interface OnDeviceModelState {
  available: boolean;
  tier: OnDeviceTier;
}

const DEFAULT: OnDeviceModelState = { available: false, tier: "none" };

const useStore = create<OnDeviceModelState>(() => ({ ...DEFAULT }));

const TIERS: readonly OnDeviceTier[] = ["foundation", "gguf", "llama-server", "none"];

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
    | { available?: unknown; tier?: unknown }
    | undefined;
  if (!reply || typeof reply !== "object") return; // failure ⇒ stay at the default
  const tier =
    typeof reply.tier === "string" && (TIERS as readonly string[]).includes(reply.tier)
      ? (reply.tier as OnDeviceTier)
      : "none";
  useStore.setState({ available: reply.available === true, tier });
}

let settled = false;

/**
 * Ask the shell whether an on-device backend is wired, once. Cheap + idempotent:
 * a plain-web browser settles without asking (the command never exists there); a
 * mobile shell asks exactly once — but only after `platformKind()` has resolved
 * to a mobile form factor (it is primed asynchronously from the first engine
 * payload, so the first hook uses can precede it); a desktop shell never asks
 * (local always shows there) and simply re-checks on the next use.
 */
function maybeProbe(): void {
  if (settled || typeof window === "undefined") return;
  if (!isDesktopShell()) {
    settled = true; // plain web/dev — nothing to probe, ever
    return;
  }
  if (!isMobileShell()) return; // desktop, or platform not yet primed — recheck next use
  settled = true;
  void probe();
}

/**
 * The on-device-model availability, availability-probed once on a mobile shell.
 * Components read `{ available, tier }`, thread `available` into
 * `modelProvidersFor(platform, onDeviceBackend)` / `switchChoices(...)`, and use
 * `tier` to pick `ON_DEVICE_MODEL_COPY[tier]` for the honest description line.
 */
export function useOnDeviceModel(): OnDeviceModelState {
  maybeProbe();
  return useStore();
}

/** Non-hook selector: is an on-device backend wired? (= the store's `available`). */
export function onDeviceBackendReady(): boolean {
  return useStore.getState().available;
}
