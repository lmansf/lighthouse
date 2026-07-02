/**
 * Local profile + onboarding state, persisted to `.rag-vault/profile.json`.
 *
 * RAG Vault is a single-user standalone app, so "auth" is just a locally-stored
 * profile plus the chosen model provider/key. The API key never leaves the
 * machine and is never returned to the client (only `hasApiKey` is exposed).
 */
import type { OnboardingState, User } from "@/contracts";
import { profilePath, readJson, writeJson } from "./config";
import { getVariant } from "./experiment";

/** Local model provider (key-less, runs on-device) used by the play_first flow. */
const LOCAL_PROVIDER_ID = "local";
const LOCAL_MODEL_ID = "lighthouse-local";

interface StoredProfile extends OnboardingState {
  /** Kept server-side only; surfaced to the client solely as `hasApiKey`. */
  apiKey?: string;
  /** Whether the user has ever explicitly saved a model choice (server-only).
   *  Distinguishes the INITIAL selection from later changes, for analytics. */
  modelEverSelected?: boolean;
}

/** Result of a model selection so the API route can emit a `model_selected`
 *  analytics event (initial choice + any change) — profile.ts must NOT import the
 *  telemetry layer (license.ts imports profile.ts, so that would be a cycle). */
export interface ModelSelectionResult {
  initial: boolean;
  changed: boolean;
  provider: string;
  model: string;
  previousProvider: string | null;
  previousModel: string | null;
}

const EMPTY: StoredProfile = {
  step: "sign-in",
  user: null,
  providerId: null,
  modelId: null,
  hasApiKey: false,
};

function load(): StoredProfile {
  return { ...EMPTY, ...readJson(profilePath(), EMPTY) };
}
function save(p: StoredProfile): void {
  writeJson(profilePath(), p);
}

/** Public onboarding state — never includes the raw key. */
export function getState(): OnboardingState {
  const { apiKey, modelEverSelected, ...pub } = load();
  void apiKey;
  void modelEverSelected;
  return {
    ...pub,
    hasApiKey: Boolean(apiKey) || pub.hasApiKey,
    // Surface the A/B variants so the client can branch copy/affordances.
    onboardingVariant: getVariant("onboarding"),
    defaultInclusionVariant: getVariant("default_inclusion"),
  };
}

export function signIn(email: string): User {
  const p = load();
  const user: User = { id: "local", name: email.split("@")[0] || "User", email };
  save({ ...p, user, step: "register" });
  return user;
}

export function register(name: string, email: string): User {
  const p = load();
  const user: User = { id: "local", name, email };
  save({ ...p, user, step: "register" });
  return user;
}

export function finishRegistration(): ModelSelectionResult | null {
  const p = load();
  // Onboarding A/B: play_first defers the API-key prompt - drop straight into the
  // workspace on the bundled, key-less local model so the user reaches a real
  // first answer before any friction. They can still connect a cloud model later
  // (the select-model UI stays reachable). key_first keeps the classic flow:
  // pick a model and paste a key during onboarding.
  if (getVariant("onboarding") === "play_first") {
    const providerId = p.providerId ?? LOCAL_PROVIDER_ID;
    const modelId = p.modelId ?? LOCAL_MODEL_ID;
    const initial = !p.modelEverSelected;
    save({ ...p, providerId, modelId, step: "done", modelEverSelected: true });
    // play_first assigns the local model WITHOUT an explicit user selection, so
    // report it as the initial model — otherwise these users are invisible in
    // "which models people use" until they happen to switch to a cloud model.
    return initial
      ? { initial: true, changed: false, provider: providerId, model: modelId, previousProvider: p.providerId, previousModel: p.modelId }
      : null;
  }
  save({ ...p, step: "select-model" });
  return null;
}

export function selectModel(
  providerId: string,
  modelId: string,
  apiKey: string,
): ModelSelectionResult {
  const p = load();
  const key = apiKey.trim();
  const initial = !p.modelEverSelected;
  const changed = p.providerId !== providerId || p.modelId !== modelId;
  save({
    ...p,
    providerId,
    modelId,
    apiKey: key || p.apiKey,
    hasApiKey: Boolean(key) || p.hasApiKey,
    step: "done",
    modelEverSelected: true,
  });
  return {
    initial,
    changed,
    provider: providerId,
    model: modelId,
    previousProvider: p.providerId,
    previousModel: p.modelId,
  };
}

export function completeOnboarding(): void {
  save({ ...load(), step: "done" });
}

export function signOut(): void {
  save({ ...EMPTY });
}

/** Resolved model config for the chat route (env key overrides stored key). */
export function modelConfig(): { providerId: string | null; modelId: string | null; apiKey: string | null } {
  const p = load();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || p.apiKey || null;
  return { providerId: p.providerId, modelId: p.modelId, apiKey };
}
