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
      if (s) cached = s as OnboardingState;
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
  async selectModel(providerId: string, modelId: string, apiKey: string): Promise<void> {
    await post("selectModel", { providerId, modelId, apiKey });
  }
  async completeOnboarding(): Promise<void> {
    await post("completeOnboarding");
  }
  async signOut(): Promise<void> {
    await post("signOut");
  }
}

export const authService: AuthService = new RealAuthService();
