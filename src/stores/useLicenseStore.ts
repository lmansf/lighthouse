import { create } from "zustand";

/**
 * Trial-license state. Checked once per launch (after onboarding). When the
 * trial has ended the server has already reset the vault; the app shows the
 * "start a new trial" screen until the user mints a fresh one.
 *
 * "disabled" = licensing isn't enforced (no Supabase / not forced) — never
 * blocks. "unknown" = not yet checked — also never blocks (avoids a flash).
 */
export type LicenseStatus = "unknown" | "valid" | "expired" | "none" | "disabled";

interface LicenseStore {
  status: LicenseStatus;
  trialEnd: string | null;
  starting: boolean;
  check: () => Promise<LicenseStatus>;
  startTrial: () => Promise<void>;
}

async function postLicense(op: string): Promise<{ status?: LicenseStatus; trialEnd?: string | null }> {
  const r = await fetch("/api/license", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op }),
  });
  return r.json().catch(() => ({}));
}

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  status: "unknown",
  trialEnd: null,
  starting: false,

  check: async () => {
    try {
      const data = await postLicense("check");
      const status = (data.status as LicenseStatus) ?? "disabled";
      set({ status, trialEnd: data.trialEnd ?? null });
      return status;
    } catch {
      // Fail open: a transient backend hiccup must not lock the user out.
      set({ status: "disabled" });
      return "disabled";
    }
  },

  startTrial: async () => {
    set({ starting: true });
    try {
      await postLicense("start");
      await get().check();
    } finally {
      set({ starting: false });
    }
  },
}));
