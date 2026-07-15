/** Real AuthService — local single-user profile via `/api/profile`.
 *
 * The contract's `getState()` is synchronous, so we keep a client-side cache
 * that every mutating call refreshes from the server response. A background
 * fetch on load hydrates it for returning users. */
import type { AuthService } from "../services";
import type { OnboardingState } from "../types";

let cached: OnboardingState = {
  step: "vault",
  user: null,
  providerId: null,
  modelId: null,
  hasApiKey: false,
};

/** Subscribers notified when `cached` changes out-of-band (background hydrate). */
const listeners = new Set<() => void>();
export function subscribeAuth(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void {
  for (const cb of listeners) cb();
}

async function post(op: string, extra: Record<string, unknown> = {}): Promise<OnboardingState> {
  const r = await fetch("/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...extra }),
  });
  if (!r.ok) throw new Error(`POST /api/profile ${r.status}`);
  cached = (await r.json()) as OnboardingState;
  return cached;
}

/**
 * Hydrate the cached profile from the server. In the desktop shell the IPC
 * transport patches `window.fetch` during the first React render, which can
 * land AFTER this module first runs — so an early hit reaches a dead app://
 * URL and 404s (or throws). Without a retry, a RETURNING user's persisted
 * "done" profile never loads and they're stranded on the sign-in screen every
 * launch. Retry briefly, but only inside the shell (on the web the real
 * `/api/profile` answers on the first try, so a non-ok there is genuine).
 */
function hydrateFromServer(attempt = 0): void {
  fetch("/api/profile", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`profile ${r.status}`);
      return r.json();
    })
    .then((s) => {
      if (s) {
        cached = s as OnboardingState;
        notify(); // a returning user's persisted profile now reaches the store
      }
    })
    .catch(() => {
      const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (inShell && attempt < 10) {
        setTimeout(() => hydrateFromServer(attempt + 1), 150);
      }
    });
}

if (typeof window !== "undefined") {
  hydrateFromServer();
}

class RealAuthService implements AuthService {
  getState(): OnboardingState {
    return { ...cached };
  }
  async finishVault(): Promise<void> {
    await post("finishVault");
  }
  async finishMode(): Promise<void> {
    await post("finishMode");
  }
  async selectModel(providerId: string, modelId: string, apiKey: string): Promise<void> {
    await post("selectModel", { providerId, modelId, apiKey });
  }
  async validateKey(
    providerId: string,
    apiKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // Not routed through post(): the reply is {ok, error?}, not an
    // OnboardingState, and must not clobber the cached profile.
    const r = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "validateKey", providerId, apiKey }),
    });
    if (!r.ok) throw new Error(`POST /api/profile ${r.status}`);
    return (await r.json()) as { ok: boolean; error?: string };
  }
  async setDefaultInclusion(value: "include" | "exclude"): Promise<void> {
    await post("setDefaultInclusion", { value });
  }
  async completeOnboarding(): Promise<void> {
    await post("completeOnboarding");
  }
  async signOut(): Promise<void> {
    await post("signOut");
  }
}

export const authService: AuthService = new RealAuthService();
