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

export interface FeedbackInput {
  firstName: string;
  lastName: string;
  email: string;
  easeOfUse: number;
  overallValue: number;
  liked: string;
  changeOrAdd: string;
  doNotContact: boolean;
  notifyWhenAvailable?: boolean;
}

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
  purchasing: boolean;
  paidEnabled: boolean;
  pendingFeedback: boolean; // show the post-purchase feedback form once
  check: () => Promise<LicenseStatus>;
  loadConfig: () => Promise<void>;
  startTrial: () => Promise<void>;
  activate: (licenseKey: string) => Promise<boolean>;
  submitFeedback: (f: FeedbackInput) => Promise<boolean>;
  submitNotify: (email: string) => Promise<boolean>;
  subscribe: (email: string) => Promise<void>;
  cancelSubscribe: () => void;
  dismissFeedback: () => void;
}

interface LicensePayload {
  status?: LicenseStatus;
  licenseType?: LicenseType;
  trialEnd?: string | null;
  graceUntil?: string | null;
  remainingDays?: number | null;
  paidEnabled?: boolean;
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
  purchasing: false,
  paidEnabled: false,
  pendingFeedback: false,

  loadConfig: async () => {
    try {
      const data = await postLicense("config");
      set({ paidEnabled: Boolean(data.paidEnabled) });
    } catch {
      set({ paidEnabled: false }); // fail closed: no paid UI if we can't tell
    }
  },

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

  submitFeedback: async (f: FeedbackInput) => {
    try {
      const data = await postLicense("feedback", { feedback: f });
      return Boolean(data.ok);
    } catch {
      return false;
    }
  },

  submitNotify: async (email: string) => {
    try {
      const data = await postLicense("notify", { email });
      return Boolean(data.ok);
    } catch {
      return false;
    }
  },

  dismissFeedback: () => set({ pendingFeedback: false }),

  // Stop waiting on a checkout the user abandoned in the browser; the poll loop
  // sees purchasing=false and breaks, freeing the Subscribe/Renew controls.
  cancelSubscribe: () => set({ purchasing: false }),

  // Open Stripe checkout in the browser, then poll until the webhook upgrades
  // this install to paid — the vault unlocks itself, no key entry. The email
  // ties the license to a user (so a business can buy many under one card).
  subscribe: async (email: string) => {
    if (get().purchasing) return;
    set({ purchasing: true });
    try {
      const r = await fetch("/api/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "checkout", email }),
      });
      const { url } = (await r.json().catch(() => ({}))) as { url?: string };
      if (!url) {
        set({ purchasing: false });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      // Poll check() for up to ~10 minutes; stop as soon as we're paid & valid.
      for (let i = 0; i < 200; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const status = await get().check();
        if (get().licenseType === "paid" && (status === "valid" || status === "grace")) {
          // Purchase confirmed — queue the post-purchase feedback survey, shown
          // after Stripe's receipt and before the app reopens to chat.
          set({ pendingFeedback: true });
          break;
        }
        if (!get().purchasing) break; // cancelled elsewhere
      }
    } finally {
      set({ purchasing: false });
    }
  },
}));
