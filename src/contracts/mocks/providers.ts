import type { ModelProvider } from "../types";

/**
 * Model providers offered during onboarding. `apiKeyUrl` deep-links the user
 * to the exact page where they generate a key for that provider (or, for the
 * local model, to setup docs — it needs no key).
 *
 * Only providers the answer engine actually implements are listed. The server
 * (src/server/llm.ts) can stream from exactly two backends: the on-machine
 * local model and Anthropic's Messages API. Earlier builds also offered
 * OpenAI / Google / Mistral here, but those keys were accepted and then
 * silently ignored — every answer quietly fell back to keyword extraction —
 * which is worse than not offering them at all.
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
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
];
