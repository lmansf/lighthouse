/**
 * Local profile + onboarding state, persisted to `.rag-vault/profile.json`.
 *
 * RAG Vault is a single-user standalone app, so "auth" is just a locally-stored
 * profile plus the chosen model provider/key. The API key never leaves the
 * machine and is never returned to the client (only `hasApiKey` is exposed).
 */
import type { OnboardingState, User } from "@/contracts";
import { profilePath, readJson, writeJson } from "./config";

interface StoredProfile extends OnboardingState {
  /** Kept server-side only; surfaced to the client solely as `hasApiKey`. */
  apiKey?: string;
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
  const { apiKey, ...pub } = load();
  void apiKey;
  return { ...pub, hasApiKey: Boolean(apiKey) || pub.hasApiKey };
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

export function finishRegistration(): void {
  save({ ...load(), step: "select-model" });
}

export function selectModel(providerId: string, modelId: string, apiKey: string): void {
  const p = load();
  const key = apiKey.trim();
  save({
    ...p,
    providerId,
    modelId,
    apiKey: key || p.apiKey,
    hasApiKey: Boolean(key) || p.hasApiKey,
    step: "done",
  });
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
