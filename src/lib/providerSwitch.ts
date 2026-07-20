/**
 * Quick provider switch (time-savers TS-8) — pure derivations behind the chat
 * header's provider menu. Kept UI-free so the node suite can pin exactly which
 * providers the menu offers and exactly which selectModel arguments a switch
 * sends (never a key) without a DOM.
 *
 * MODEL_PROVIDERS is imported from the catalog module directly (not the
 * contracts barrel) so node tests can load this without dragging the real
 * services in — same precedent as lib/evidencePack.ts.
 */
import { MODEL_PROVIDERS, modelProvidersFor } from "../contracts/mocks/providers";
import type { PlatformKind } from "../contracts/services";

export interface SwitchChoice {
  id: string;
  label: string;
  /** Menu secondary line — only the private model carries one. */
  hint?: string;
}

/** The private model's menu hint (mirrors the picker's privacy framing). */
export const LOCAL_HINT = "runs on this device";

/**
 * Providers the header switcher offers, in catalog order: the private model
 * FIRST and ONLY when its weights are actually ready (a not-ready local
 * selection would silently answer extractively), then every cloud vendor with
 * a stored key (`keyedProviders` carries key PRESENCE only, never keys). The
 * active provider gets no special seat: an unkeyed cloud selection still
 * yields a menu of real, one-click destinations only.
 *
 * §3: the roster is platform-filtered (modelProvidersFor) — on a mobile shell
 * the local entry is GONE regardless of `localReady` (the engine reports
 * "unsupported" there, so localReady can't be true anyway; the filter makes
 * it structural).
 */
export function switchChoices(
  keyedProviders: string[] | undefined,
  localReady: boolean,
  platform: PlatformKind,
): SwitchChoice[] {
  const keyed = new Set(keyedProviders ?? []);
  const out: SwitchChoice[] = [];
  for (const p of modelProvidersFor(platform)) {
    if (p.id === "local") {
      if (localReady) out.push({ id: p.id, label: p.label, hint: LOCAL_HINT });
    } else if (keyed.has(p.id)) {
      out.push({ id: p.id, label: p.label });
    }
  }
  return out;
}

/**
 * The exact selectModel arguments for a header switch to `targetProviderId`:
 * keep the current model when re-selecting the current provider (and the
 * catalog still lists that model), else the provider's first (curated-default)
 * model. `apiKey` is ALWAYS the empty string — both engines keep the target
 * provider's stored key on an empty field (profile.ts / profile.rs
 * select_model), so a switch never needs, sees, or touches a key.
 */
export function switchArgs(
  targetProviderId: string,
  current: { providerId: string | null; modelId: string | null },
): { providerId: string; modelId: string; apiKey: "" } {
  const models = MODEL_PROVIDERS.find((p) => p.id === targetProviderId)?.models ?? [];
  const keep =
    targetProviderId === current.providerId &&
    current.modelId &&
    models.includes(current.modelId)
      ? current.modelId
      : (models[0] ?? "");
  return { providerId: targetProviderId, modelId: keep, apiKey: "" };
}

/**
 * Compact trigger label: the privacy word for the device path (the local
 * provider, or no provider at all — both answer on this machine, exactly the
 * `originOf` rule the provenance stamp uses), else the vendor's catalog label.
 */
export function shortProviderLabel(providerId: string | null): string {
  if (!providerId || providerId === "local") return "Private";
  return MODEL_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
}
