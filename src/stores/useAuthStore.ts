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
  signIn: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  selectModel: (providerId: string, modelId: string, apiKey: string) => Promise<void>;
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

  signIn: async (email, password) => {
    await authService.signIn(email, password);
    set({ onboarding: authService.getState() });
  },

  register: async (name, email, password) => {
    await authService.register(name, email, password);
    set({ onboarding: authService.getState() });
  },

  selectModel: async (providerId, modelId, apiKey) => {
    await authService.selectModel(providerId, modelId, apiKey);
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
