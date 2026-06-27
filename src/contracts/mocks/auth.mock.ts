import type { AuthService } from "../services";
import type { OnboardingState, User } from "../types";

/**
 * In-memory AuthService. No real identity provider; everything resolves
 * locally so the onboarding flow is fully exercisable. Swap for NextAuth /
 * Entra behind this surface later.
 */
class MockAuthService implements AuthService {
  private state: OnboardingState = {
    step: "sign-in",
    user: null,
    providerId: null,
    modelId: null,
    hasApiKey: false,
  };

  getState(): OnboardingState {
    return { ...this.state };
  }

  async signIn(email: string): Promise<User> {
    const user: User = { id: "u-1", name: email.split("@")[0] || "User", email };
    this.state = { ...this.state, user, step: "register" };
    return user;
  }

  async register(name: string, email: string): Promise<User> {
    const user: User = { id: "u-1", name, email };
    this.state = { ...this.state, user, step: "register" };
    return user;
  }

  async finishRegistration(): Promise<void> {
    this.state = { ...this.state, step: "select-model" };
  }

  async selectModel(providerId: string, modelId: string, apiKey: string): Promise<void> {
    this.state = {
      ...this.state,
      providerId,
      modelId,
      hasApiKey: apiKey.trim().length > 0,
      step: "done",
    };
  }

  async completeOnboarding(): Promise<void> {
    this.state = { ...this.state, step: "done" };
  }

  async signOut(): Promise<void> {
    this.state = {
      step: "sign-in",
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
