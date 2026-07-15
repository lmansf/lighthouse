import type { AuthService } from "../services";
import type { OnboardingState } from "../types";

/**
 * In-memory AuthService. No real identity provider; first run collects no
 * identity at all — it just walks vault → mode → model → inclusion → done so
 * the onboarding flow is fully exercisable.
 */
class MockAuthService implements AuthService {
  private state: OnboardingState = {
    step: "vault",
    user: null,
    providerId: null,
    modelId: null,
    hasApiKey: false,
  };

  getState(): OnboardingState {
    return { ...this.state };
  }

  async finishVault(): Promise<void> {
    this.state = { ...this.state, step: "mode" };
  }

  async finishMode(): Promise<void> {
    this.state = { ...this.state, step: "select-model" };
  }

  async selectModel(providerId: string, modelId: string, apiKey: string): Promise<void> {
    const keyed = new Set(this.state.keyedProviders ?? []);
    if (apiKey.trim()) keyed.add(providerId);
    this.state = {
      ...this.state,
      providerId,
      modelId,
      hasApiKey: keyed.has(providerId),
      keyedProviders: [...keyed],
      step: "inclusion",
    };
  }

  async validateKey(
    _providerId: string,
    apiKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // Deterministic mock: any non-empty key "works" unless it contains "bad",
    // so both UI states are exercisable without network.
    await new Promise((r) => setTimeout(r, 300));
    if (!apiKey.trim()) return { ok: false, error: "no key to test — paste one first" };
    if (apiKey.includes("bad")) return { ok: false, error: "the provider rejected this key (HTTP 401)" };
    return { ok: true };
  }

  async setDefaultInclusion(value: "include" | "exclude"): Promise<void> {
    this.state = { ...this.state, defaultInclusion: value };
  }

  async completeOnboarding(): Promise<void> {
    this.state = { ...this.state, step: "done" };
  }

  async signOut(): Promise<void> {
    this.state = {
      step: "vault",
      user: null,
      providerId: null,
      modelId: null,
      hasApiKey: false,
    };
  }
}

export const authService: AuthService = new MockAuthService();

/** No-op: the in-memory mock never changes state out-of-band. Mirrors the
 *  real implementation's hook so the contracts barrel can export either. */
export function subscribeAuth(_cb: () => void): () => void {
  return () => {};
}
