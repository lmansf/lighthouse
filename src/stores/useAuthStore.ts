import { create } from "zustand";
import type { OnboardingState } from "@/contracts";
import { authService, subscribeAuth } from "@/contracts";

/**
 * Auth + onboarding progress. The onboarding feature drives this; the shell
 * reads `onboarding.step` to decide whether to show onboarding or the app.
 */
interface AuthStore {
  onboarding: OnboardingState;
  refresh: () => void;
  /**
   * Client-only step override for onboarding Back navigation. The server stays
   * authoritative on forward moves — every mutation re-syncs `onboarding` from
   * its response — so this only ever rewinds the visible step; re-submitting
   * re-advances it.
   */
  setStep: (step: OnboardingState["step"]) => void;
  signIn: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  finishRegistration: () => Promise<void>;
  selectModel: (providerId: string, modelId: string, apiKey: string) => Promise<void>;
  /** Live-test a key (empty string tests the stored one). Never persists. */
  validateKey: (
    providerId: string,
    apiKey: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  setDefaultInclusion: (value: "include" | "exclude") => Promise<void>;
  completeOnboarding: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => {
  // When the real auth service finishes hydrating a returning user's persisted
  // profile in the background, push it into the store so onboarding is skipped.
  subscribeAuth(() => set({ onboarding: authService.getState() }));

  return {
  onboarding: authService.getState(),

  refresh: () => set({ onboarding: authService.getState() }),

  setStep: (step) => set((s) => ({ onboarding: { ...s.onboarding, step } })),

  signIn: async (email, password) => {
    await authService.signIn(email, password);
    set({ onboarding: authService.getState() });
  },

  register: async (name, email, password) => {
    await authService.register(name, email, password);
    set({ onboarding: authService.getState() });
  },

  finishRegistration: async () => {
    await authService.finishRegistration();
    set({ onboarding: authService.getState() });
  },

  selectModel: async (providerId, modelId, apiKey) => {
    await authService.selectModel(providerId, modelId, apiKey);
    set({ onboarding: authService.getState() });
  },

  validateKey: (providerId, apiKey) => authService.validateKey(providerId, apiKey),

  setDefaultInclusion: async (value) => {
    await authService.setDefaultInclusion(value);
    set({ onboarding: authService.getState() });
  },

  completeOnboarding: async () => {
    await authService.completeOnboarding();
    set({ onboarding: authService.getState() });
  },

  signOut: async () => {
    await authService.signOut();
    set({ onboarding: authService.getState() });
  },
  };
});
