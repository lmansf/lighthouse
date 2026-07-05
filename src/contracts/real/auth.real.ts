/** Real AuthService — local single-user profile via `/api/profile`.
 *
 * The contract's `getState()` is synchronous, so we keep a client-side cache
 * that every mutating call refreshes from the server response. A background
 * fetch on load hydrates it for returning users. */
import type { AuthService } from "../services";
import type { OnboardingState, User } from "../types";

let cached: OnboardingState = {
  step: "sign-in",
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

if (typeof window !== "undefined") {
  fetch("/api/profile", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s) {
        cached = s as OnboardingState;
        notify(); // a returning user's persisted profile now reaches the store
      }
    })
    .catch(() => {});
}

class RealAuthService implements AuthService {
  getState(): OnboardingState {
    return { ...cached };
  }
  async signIn(email: string): Promise<User> {
    return (await post("signIn", { email })).user!;
  }
  async register(name: string, email: string): Promise<User> {
    return (await post("register", { name, email })).user!;
  }
  async finishRegistration(): Promise<void> {
    await post("finishRegistration");
  }
  async selectModel(providerId: string, modelId: string, apiKey: string): Promise<void> {
    await post("selectModel", { providerId, modelId, apiKey });
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
