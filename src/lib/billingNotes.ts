/**
 * Billing-clarity notes (0.12.1 §4) — static, per-vendor copy shown wherever a
 * cloud provider is selected or a key is entered: the model picker, the
 * onboarding provider step, and the AI-models dialog. Plain inline text, never
 * a modal, always visible at selection/entry.
 *
 * Why per-vendor strings rather than one templated line: the whole point is to
 * name the RIGHT products, so a user doesn't assume their chat subscription
 * (ChatGPT Plus, Claude Pro, …) pays for API-key usage — it does not. The
 * subscription names are curated per vendor and refreshed with releases, the
 * same discipline as the model ids in contracts/mocks/providers.ts.
 *
 * This module is pure and telemetry-free: no network, no logging, no counters.
 * It returns copy; nothing here observes or reports what the user picked.
 */

/** Per-vendor billing copy. `key` names the vendor's dev-billing + the chat
 *  subscription that does NOT cover it; `signin` is shown when the sign-in auth
 *  method is active for that vendor (0.12.1 §3). */
interface BillingCopy {
  key: string;
  signin?: string;
}

const BILLING: Record<string, BillingCopy> = {
  anthropic: {
    key: "API keys bill per use to your Anthropic Console account. A Claude Pro or Max subscription does NOT cover API-key usage.",
  },
  openai: {
    key: "API keys bill per use to your OpenAI developer account. A ChatGPT Plus, Pro, or Team subscription does NOT cover API-key usage.",
    signin: "Usage draws on your ChatGPT account and its plan limits, per OpenAI's terms.",
  },
  google: {
    key: "API keys bill per use to your Google AI Studio / Cloud project. A Google AI Pro or Ultra subscription does NOT cover API-key usage.",
  },
  xai: {
    key: "API keys bill per use to your xAI Console account. A SuperGrok subscription does NOT cover API-key usage.",
  },
  mistral: {
    key: "API keys bill per use to your Mistral Console account. A Le Chat subscription does NOT cover API-key usage.",
  },
  deepseek: {
    key: "API keys bill per use to your DeepSeek open-platform account. A chat subscription does NOT cover API-key usage.",
  },
};

/**
 * The API-key billing note for a provider, or null when there is nothing to
 * bill (the private on-device model) or the provider is unknown. Callers render
 * it as quiet inline hint text beside the key field.
 */
export function apiKeyBillingNote(providerId: string | null | undefined): string | null {
  if (!providerId || providerId === "local") return null;
  return BILLING[providerId]?.key ?? null;
}

/**
 * The sign-in billing note for a provider (0.12.1 §3 auth method), or null when
 * that vendor offers no sign-in copy or is the local model. Shown only while the
 * sign-in method is active.
 */
export function signinBillingNote(providerId: string | null | undefined): string | null {
  if (!providerId || providerId === "local") return null;
  return BILLING[providerId]?.signin ?? null;
}
