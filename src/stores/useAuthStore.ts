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
   * its response — so this only rewinds the visible step; re-submitting
   * re-advances it. One deliberate forward exception (§3): the mobile model
   * slide's "Continue without a key" hops to "inclusion" with NO provider
   * selected — the profile step machine has no op for that transition, and the
   * durable finish is the terminal completeOnboarding, so quitting mid-hop
   * just resumes at select-model.
   */
  setStep: (step: OnboardingState["step"]) => void;
  finishVault: () => Promise<void>;
  finishMode: () => Promise<void>;
  selectModel: (providerId: string, modelId: string, apiKey: string) => Promise<void>;
  /**
   * Post-onboarding quick switch (chat header): re-point the active
   * provider/model with NO key — an empty key keeps the target provider's
   * stored one server-side. The shared selectModel op parks the profile on
   * the onboarding "inclusion" step (its onboarding caller continues from
   * there), so this immediately re-completes onboarding and publishes ONE
   * state update: the intermediate step must never reach the shell, which
   * would swap the running app out for the onboarding panel.
   */
  switchModel: (providerId: string, modelId: string, apiKey?: string) => Promise<void>;
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

  finishVault: async () => {
    await authService.finishVault();
    set({ onboarding: authService.getState() });
  },

  finishMode: async () => {
    await authService.finishMode();
    set({ onboarding: authService.getState() });
  },

  selectModel: async (providerId, modelId, apiKey) => {
    await authService.selectModel(providerId, modelId, apiKey);
    set({ onboarding: authService.getState() });
  },

  switchModel: async (providerId, modelId, apiKey = "") => {
    // selectModel parks the profile step machine on "inclusion" (that IS the
    // onboarding flow); a post-onboarding switch/save must restore "done"
    // before publishing ONE state, or app/page briefly swaps the shell for
    // the onboarding panel. Empty key ⇒ the stored key is kept.
    await authService.selectModel(providerId, modelId, apiKey);
    await authService.completeOnboarding();
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
