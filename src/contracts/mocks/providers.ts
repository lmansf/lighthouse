import type { ModelProvider } from "../types";

/**
 * Model providers offered during onboarding. `apiKeyUrl` deep-links the user
 * to the exact page where they generate a key for that provider (or, for the
 * local model, to setup docs — it needs no key).
 */
export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic Claude",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    // A private model that runs entirely on this machine — no key, no network,
    // nothing leaves your environment. Talks to a local OpenAI-compatible
    // inference server (llama.cpp's `llama-server`, Ollama, LM Studio, etc.).
    id: "local",
    label: "Local model (private)",
    models: ["lighthouse-local"],
    apiKeyUrl: "https://github.com/lmansf/lighthouse#local-model",
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "o3"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    label: "Google Gemini",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"],
    apiKeyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    models: ["mistral-large-latest", "mistral-small-latest"],
    apiKeyUrl: "https://console.mistral.ai/api-keys",
  },
];
