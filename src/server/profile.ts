/**
 * Local profile + onboarding state, persisted to `profile.json`.
 *
 * RAG Vault is a single-user standalone app, so "auth" is just a locally-stored
 * profile plus the chosen model provider/key. Provider API keys are persisted
 * separately in the encrypted install-global secrets store (./secrets) — they
 * survive sign-out and vault switches, never leave the machine, and are never
 * returned to the client (only `hasApiKey` / `keyedProviders`).
 */
import type { OnboardingState } from "@/contracts";
import { profilePath, readJson, writeJson } from "./config";
import { REMOTE_PROVIDERS, remoteProvider } from "./llm";
import { providerAllowed } from "./policy";
import { getProviderKey, setProviderKey } from "./secrets";

/** Local model provider (key-less, runs on-device) used by the play_first flow. */
const LOCAL_PROVIDER_ID = "local";
const LOCAL_MODEL_ID = "lighthouse-local";

interface StoredProfile extends OnboardingState {
  /**
   * LEGACY, read-only: single plaintext key slot from the one-provider
   * (Anthropic) era. Migrated into the encrypted secrets store on load and
   * stripped from disk; never written non-empty again.
   */
  apiKey?: string;
  /**
   * LEGACY, read-only: the pre-0.11 plaintext per-provider key map. Migrated
   * into the encrypted install-global secrets store (./secrets) on load and
   * stripped from disk. Keys are surfaced to the client solely as `hasApiKey`
   * + `keyedProviders`, never raw.
   */
  apiKeys?: Record<string, string>;
  /**
   * The user's explicit default-inclusion choice, if they made one during
   * onboarding. Absent ⇒ fall back to the conservative default (exclude). The
   * vault engine reads this to decide whether a newly-added file (no explicit
   * flag) is searchable by default. See `effectiveDefaultInclusion`.
   */
  defaultInclusionChoice?: "include" | "exclude";
}

const EMPTY: StoredProfile = {
  step: "vault",
  user: null,
  providerId: null,
  modelId: null,
  hasApiKey: false,
};

/**
 * Provider ids the app can actually answer with: local, Anthropic, and every
 * wired OpenAI-compatible vendor — derived from the engine's own table so the
 * two can't drift. A profile carrying anything else (a provider from a build
 * that listed more than it wired, or a removed one) is normalized to the
 * private local default, so the UI never claims excerpts go to a provider
 * that is never called. Stored keys are left untouched in case it returns.
 */
const KNOWN_PROVIDER_IDS = new Set([
  LOCAL_PROVIDER_ID,
  "anthropic",
  ...REMOTE_PROVIDERS.map((p) => p.id),
]);

function load(): StoredProfile {
  let p: StoredProfile = { ...EMPTY, ...readJson(profilePath(), EMPTY) };
  let dirty = false;
  // Migrate the legacy single-key slot into the per-provider map. It can only
  // be an Anthropic key: every build that wrote it offered exactly one keyed
  // provider (openai/google/mistral appeared in an ancient picker but were
  // never wired, and their profiles were normalized to local).
  if (!p.apiKeys || Object.keys(p.apiKeys).length === 0) {
    if (p.apiKey) {
      p = { ...p, apiKeys: { anthropic: p.apiKey } };
      dirty = true;
    }
  }
  // One-time migration: plaintext keys move out of profile.json into the
  // encrypted install-global secrets store (./secrets) and the plaintext
  // copies are stripped from disk. Existing sealed values win so an old
  // profile restored from backup can't clobber newer keys. After this,
  // profile.json never carries a raw key again (and sign-out — which resets
  // the profile — no longer discards them).
  if (p.apiKeys && Object.keys(p.apiKeys).length > 0) {
    for (const [id, k] of Object.entries(p.apiKeys)) {
      if (k && !getProviderKey(id)) setProviderKey(id, k);
    }
    p = { ...p, apiKeys: undefined, apiKey: undefined };
    dirty = true;
  }
  if (p.providerId && !KNOWN_PROVIDER_IDS.has(p.providerId)) {
    p = { ...p, providerId: LOCAL_PROVIDER_ID, modelId: LOCAL_MODEL_ID };
    dirty = true;
  }
  if (dirty) save(p);
  return p;
}
function save(p: StoredProfile): void {
  writeJson(profilePath(), p);
}

/**
 * The user's *effective* default-inclusion behavior: their explicit onboarding
 * choice if they made one, else the conservative default of `exclude` (nothing
 * is searchable until the user includes it — the app's original behavior).
 * Onboarding always persists an explicit choice, so the fallback only applies
 * to a profile that never completed registration. This is the single source of
 * truth the vault engine and the UI both consult.
 */
export function effectiveDefaultInclusion(): "include" | "exclude" {
  const choice = load().defaultInclusionChoice;
  return choice === "include" || choice === "exclude" ? choice : "exclude";
}

/** Persist the user's explicit include/exclude-by-default choice. */
export function setDefaultInclusion(value: "include" | "exclude"): void {
  save({ ...load(), defaultInclusionChoice: value });
}

/** Public onboarding state — never includes the raw keys. */
export function getState(): OnboardingState {
  const p = load();
  const { apiKey, apiKeys, defaultInclusionChoice, ...pub } = p;
  void apiKey;
  void apiKeys;
  void defaultInclusionChoice;
  const keyed = keyedProviders(p);
  // "Has a key" is now per-provider: true when the SELECTED provider has one.
  // The legacy stored flag only backs up pre-map anthropic profiles.
  const hasApiKey =
    Boolean(p.providerId) &&
    p.providerId !== LOCAL_PROVIDER_ID &&
    (keyed.includes(p.providerId!) || (p.providerId === "anthropic" && pub.hasApiKey));
  return {
    ...pub,
    hasApiKey,
    keyedProviders: keyed,
    // The effective default for newly-added files (explicit choice or fallback).
    defaultInclusion: effectiveDefaultInclusion(),
  };
}

/**
 * Every keyed provider id with a usable key — stored in the map, in the
 * legacy slot (anthropic), or supplied via its env var.
 */
function keyedProviders(p: StoredProfile): string[] {
  return ["anthropic", ...REMOTE_PROVIDERS.map((r) => r.id)].filter((id) =>
    Boolean(resolveKey(id, p)),
  );
}

export function finishVault(): void {
  // First run starts at the vault step (where the user's documents live).
  // Once acknowledged, advance to the interface-mode chooser (window vs
  // widget). The chooser is desktop-only; on the web twin the client
  // auto-advances past the mode step. PARITY: mirrors profile.rs finish_vault.
  save({ ...load(), step: "mode" });
}

export function finishMode(): void {
  // The window/widget interface choice has been made (or auto-skipped on the
  // web twin); continue to the model picker. PARITY: profile.rs finish_mode.
  save({ ...load(), step: "select-model" });
}

export function selectModel(providerId: string, modelId: string, apiKey: string): void {
  const p = load();
  // Managed policy: never persist (or seal a key for) a disallowed provider.
  // The op layer rejects with a real error before calling here; this
  // belt-and-braces returns without changing the profile for any other caller.
  // llm.ts additionally refuses at call time.
  if (!providerAllowed(providerId)) return;
  const key = apiKey.trim();
  // A pasted key is stored under the provider it was pasted FOR — sealed in
  // the install-global secrets store (./secrets), never in this file. An
  // empty field keeps that provider's existing key (switch model w/o
  // re-pasting).
  if (key && providerId !== LOCAL_PROVIDER_ID) setProviderKey(providerId, key);
  save({
    ...p,
    providerId,
    modelId,
    // Raw keys no longer live in profile.json (see load()'s migration); the
    // legacy fields stay declared read-only for old files.
    apiKeys: undefined,
    apiKey: undefined,
    hasApiKey: Boolean(key) || p.hasApiKey,
    // The user picks their default-inclusion preference next (the final step);
    // completeOnboarding() lands on "done". PARITY: profile.rs select_model.
    step: "inclusion",
  });
}

export function completeOnboarding(): void {
  save({ ...load(), step: "done" });
}

export function signOut(): void {
  // Resets identity/onboarding only. Provider API keys live in the
  // install-global secrets store and deliberately SURVIVE sign-out — they are
  // app credentials, not identity (pre-0.11 they sat in this file and were
  // silently discarded here, forcing a re-paste after every sign-out).
  save({ ...EMPTY });
}

/**
 * Resolved model config for the chat route: the SELECTED provider's key, with
 * its env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) taking precedence over
 * the stored one.
 */
export function modelConfig(): { providerId: string | null; modelId: string | null; apiKey: string | null } {
  const p = load();
  const apiKey = p.providerId ? resolveKey(p.providerId, p) : null;
  return { providerId: p.providerId, modelId: p.modelId, apiKey };
}

/**
 * The key a chat with `providerId` would use right now (env → stored map →
 * legacy anthropic slot). Null for local/unknown providers or when unkeyed.
 */
export function resolvedKeyFor(providerId: string): string | null {
  return resolveKey(providerId, load());
}

function envVarKey(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

function resolveKey(providerId: string, p: StoredProfile): string | null {
  if (providerId === LOCAL_PROVIDER_ID) return null;
  const envName =
    providerId === "anthropic" ? "ANTHROPIC_API_KEY" : remoteProvider(providerId)?.envKey;
  if (envName) {
    const k = envVarKey(envName);
    if (k) return k;
  }
  // Google publishes both spellings; accept the older one too.
  if (providerId === "google") {
    const k = envVarKey("GOOGLE_API_KEY");
    if (k) return k;
  }
  // The persisted home: the encrypted install-global secrets store.
  const sealed = getProviderKey(providerId);
  if (sealed) return sealed;
  // Transient safety net for a profile object read before load()'s migration
  // stripped its plaintext fields (normally both are empty).
  const stored = p.apiKeys?.[providerId];
  if (stored) return stored;
  if (providerId === "anthropic" && p.apiKey) return p.apiKey;
  return null;
}
