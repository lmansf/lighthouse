import type { ModelProvider } from "../types";
import type { PlatformKind } from "../services";

/**
 * Model providers offered in the picker (onboarding step 3 and Settings → AI
 * models). `apiKeyUrl` deep-links the user to the exact page where they
 * generate a key for that provider (or, for the local model, to setup docs —
 * it needs no key).
 *
 * INVARIANT: only providers the answer engines actually stream from may be
 * listed. Anthropic has its own Messages-API path; every other hosted entry
 * must exist in the OpenAI-compatible provider table (src/server/llm.ts
 * REMOTE_PROVIDERS ↔ native llm.rs OPENAI_COMPAT_PROVIDERS — a unit test pins
 * this). An earlier build listed providers it silently ignored, and every
 * answer fell back to keyword extraction while users believed a cloud model
 * was reading their files.
 *
 * Model ids are curated, current, stable ids per vendor — refresh them with
 * releases rather than listing everything the vendor serves.
 */
export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    // A private model that runs entirely on this machine — no key, no network,
    // nothing leaves your environment. Talks to a local OpenAI-compatible
    // inference server (llama.cpp's `llama-server`, Ollama, LM Studio, etc.).
    // Listed first so it is the default selection on first sign-in (private by
    // default); users can still switch to a hosted provider before they start.
    id: "local",
    label: "Local model (private)",
    models: ["lighthouse-local"],
    apiKeyUrl: "https://github.com/lmansf/lighthouse#local-model",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI GPT",
    models: ["gpt-5.1", "gpt-5", "gpt-5-mini"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    label: "Google Gemini",
    models: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    apiKeyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    label: "xAI Grok",
    models: ["grok-4", "grok-4-fast-reasoning", "grok-3-mini"],
    apiKeyUrl: "https://console.x.ai/",
  },
  {
    id: "mistral",
    label: "Mistral",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
    apiKeyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: ["deepseek-chat", "deepseek-reasoner"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
  },
];

/**
 * §3 (iOS field patch 1): the roster for a given form factor. The private
 * on-device model exists only on the desktop shell — phone-class hardware
 * can't run the ~4.2 GB weights — so on ios/android the local entry is GONE
 * (not disabled). The onboarding model slide, Settings → AI models, and the
 * chat header switcher all consume this one filter, which is what keeps
 * LocalModelInstallPanel and every Install CTA from ever mounting there. The
 * engine enforces the same verdict regardless (local_model.rs::
 * local_model_supported / localModel.ts::localModelSupported — downloads are
 * refused, status reports "unsupported").
 */
export function modelProvidersFor(platform: PlatformKind): ModelProvider[] {
  return platform === "desktop"
    ? MODEL_PROVIDERS
    : MODEL_PROVIDERS.filter((p) => p.id !== "local");
}

/**
 * §3: the two truths of the mobile empty-provider state, byte-identical
 * everywhere it appears (chat header switcher, Settings → AI models, the
 * onboarding model slide, and the first-run tour's models step): narrated
 * answers need a cloud key, and the private model lives in the desktop app.
 * Deterministic asks answer either way — this line is about narration only.
 */
export const MOBILE_NO_PROVIDER_TRUTHS =
  "Add a cloud API key to enable narrated answers — the private model runs on the desktop app.";
