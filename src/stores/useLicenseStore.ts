import { create } from "zustand";

/**
 * License state. Checked once per launch (after onboarding). Nothing is ever
 * deleted: when the license isn't valid the app locks (vault greyed + sign-in
 * gate) until the user starts a new trial or activates a key.
 *
 * trial: "valid" | "expired" (locked) | "none"
 * paid:  "valid" | "grace" (lapsed, still usable + banner) | "locked"
 * "disabled" = not enforced (never blocks). "unknown" = not yet checked.
 */
export type LicenseStatus =
  | "unknown"
  | "valid"
  | "expired"
  | "grace"
  | "locked"
  | "none"
  | "disabled";

export type LicenseType = "trial" | "paid";

/** Statuses where the vault is greyed and the sign-in / start-trial gate shows. */
export function isLocked(s: LicenseStatus): boolean {
  return s === "expired" || s === "locked" || s === "none";
}

interface LicenseStore {
  status: LicenseStatus;
  licenseType: LicenseType | null;
  trialEnd: string | null;
  graceUntil: string | null;
  remainingDays: number | null;
  starting: boolean;
  activating: boolean;
  activateError: string | null;
  check: () => Promise<LicenseStatus>;
  startTrial: () => Promise<void>;
  activate: (licenseKey: string) => Promise<boolean>;
}

interface LicensePayload {
  status?: LicenseStatus;
  licenseType?: LicenseType;
  trialEnd?: string | null;
  graceUntil?: string | null;
  remainingDays?: number | null;
  ok?: boolean;
}

async function postLicense(op: string, extra: Record<string, unknown> = {}): Promise<LicensePayload> {
  const r = await fetch("/api/license", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...extra }),
  });
  return r.json().catch(() => ({}));
}

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  status: "unknown",
  licenseType: null,
  trialEnd: null,
  graceUntil: null,
  remainingDays: null,
  starting: false,
  activating: false,
  activateError: null,

  check: async () => {
    try {
      const data = await postLicense("check");
      const status = (data.status as LicenseStatus) ?? "disabled";
      set({
        status,
        licenseType: data.licenseType ?? null,
        trialEnd: data.trialEnd ?? null,
        graceUntil: data.graceUntil ?? null,
        remainingDays: data.remainingDays ?? null,
      });
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

  activate: async (licenseKey: string) => {
    set({ activating: true, activateError: null });
    try {
      const data = await postLicense("activate", { licenseKey });
      if (data.ok) {
        await get().check();
        return true;
      }
      set({ activateError: "That license key isn't valid or has expired." });
      return false;
    } catch {
      set({ activateError: "Couldn't reach the license service. Try again." });
      return false;
    } finally {
      set({ activating: false });
    }
  },
}));
