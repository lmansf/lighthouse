/**
 * Answer generation. Grounds every answer in the retrieved vault context.
 *
 * - Local model (when the "local" provider is selected): real streamed tokens
 *   from an on-machine OpenAI-compatible inference server (llama.cpp's
 *   `llama-server`, Ollama, LM Studio, …). Nothing leaves the machine.
 * - Anthropic Claude (when a key + the Anthropic provider are configured):
 *   real streamed tokens via the Messages API over `fetch` (no SDK dependency).
 * - Otherwise: a fully-local extractive fallback that streams the most relevant
 *   passages, so the app is useful with zero configuration and zero network.
 */
import type { ChatTurn } from "@/contracts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Where the bundled/local inference server listens. Override with
// LIGHTHOUSE_LOCAL_LLM_URL to point at an existing Ollama/LM Studio instance.
// The endpoint must be OpenAI chat-completions compatible.
const LOCAL_LLM_URL =
  process.env.LIGHTHOUSE_LOCAL_LLM_URL?.trim() || "http://127.0.0.1:8080/v1/chat/completions";
// Model name sent to the local server. llama.cpp's `llama-server` ignores it, but
// Ollama (and other BYO servers) require a real pulled model name or return 404 —
// set LIGHTHOUSE_LOCAL_LLM_MODEL to the pulled model (e.g. "llama3.2") in that case.
const LOCAL_LLM_MODEL = process.env.LIGHTHOUSE_LOCAL_LLM_MODEL?.trim() || "";
// How long to wait for the local server to start responding (headers) before
// giving up and falling back to extractive passages.
const LOCAL_CONNECT_TIMEOUT_MS = 45_000;
const LOCAL_SYSTEM_PROMPT =
  "You are Lighthouse's assistant. Answer only from the provided context and cite sources as [n]. Be concise. " +
  "Earlier turns in the conversation may reference the same documents; use them to interpret follow-up questions.";

export interface Ctx {
  name: string;
  text: string;
  score: number;
}

function buildPrompt(question: string, contexts: Ctx[]): string {
  const blocks = contexts
    .map((c, i) => `[${i + 1}] ${c.name}\n${c.text}`)
    .join("\n\n");
  return (
    `Use ONLY the context below to answer. If it is insufficient, say so plainly ` +
    `and do not invent facts. Cite sources as [n] inline.\n\n` +
    `# Context\n${blocks}\n\n# Question\n${question}`
  );
}

/** Stream an answer as incremental text deltas. */
export async function* streamAnswer(
  question: string,
  contexts: Ctx[],
  cfg: { providerId: string | null; modelId: string | null; apiKey: string | null },
  history: ChatTurn[] = [],
): AsyncGenerator<string> {
  if (contexts.length === 0) {
    yield "Nothing relevant is included in the RAG index yet. Add or include files in the explorer, then ask again.";
    return;
  }

  // A private, on-machine model — no key required.
  if (cfg.providerId === "local") {
    let emitted = false;
    try {
      const localModel = LOCAL_LLM_MODEL || cfg.modelId || "lighthouse-local";
      for await (const delta of streamLocal(question, contexts, localModel, history)) {
        emitted = true;
        yield delta;
      }
      return;
    } catch (err) {
      const note = `\n\n_(Local model unavailable — ${
        err instanceof Error ? err.message : "error"
      }${emitted ? "." : "; is the local model running? Falling back to passages."})_\n\n`;
      yield note;
      if (emitted) return;
      yield* extractive(question, contexts, false);
      return;
    }
  }

  const canClaude = cfg.providerId === "anthropic" && cfg.apiKey;
  if (canClaude) {
    let emitted = false;
    try {
      for await (const delta of streamClaude(
        question,
        contexts,
        cfg.apiKey!,
        cfg.modelId ?? "claude-haiku-4-5",
        history,
      )) {
        emitted = true;
        yield delta;
      }
      return;
    } catch (err) {
      const note = `\n\n_(Live model unavailable — ${
        err instanceof Error ? err.message : "error"
      }${emitted ? "." : "; falling back to local passages."})_\n\n`;
      yield note;
      if (emitted) return;
    }
  }
  yield* extractive(question, contexts, !canClaude);
}

async function* streamClaude(
  question: string,
  contexts: Ctx[],
  apiKey: string,
  model: string,
  history: ChatTurn[] = [],
): AsyncGenerator<string> {
  // Prior turns first (so the model has the thread), then the current question
  // with its freshly-retrieved context grounded in. Anthropic rejects
  // empty-content turns and requires the sequence to begin with a user turn.
  const priorTurns = history.filter(
    (t) => typeof t.content === "string" && t.content.trim() !== "",
  );
  while (priorTurns.length > 0 && priorTurns[0].role !== "user") priorTurns.shift();
  const messages = [
    ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: buildPrompt(question, contexts) },
  ];
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      system:
        "You are Lighthouse's assistant. Answer only from the provided context and cite sources as [n]. Be concise. " +
        "Earlier turns in the conversation may reference the same documents; use them to interpret follow-up questions.",
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          yield evt.delta.text as string;
        }
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    }
  }
}

/**
 * Stream from a local OpenAI-compatible chat-completions endpoint (llama.cpp's
 * `llama-server`, Ollama at /v1, LM Studio, …). Same SSE shape as OpenAI:
 * `data: {choices:[{delta:{content}}]}` lines terminated by `data: [DONE]`.
 */
async function* streamLocal(
  question: string,
  contexts: Ctx[],
  model: string,
  history: ChatTurn[] = [],
): AsyncGenerator<string> {
  const priorTurns = history.filter(
    (t) => typeof t.content === "string" && t.content.trim() !== "",
  );
  while (priorTurns.length > 0 && priorTurns[0].role !== "user") priorTurns.shift();
  // Bound only the connect/headers phase: a freshly auto-spawned llama-server can
  // accept the TCP connection while still loading the GGUF (tens of seconds), so
  // without this the request hangs instead of failing fast into the fallback. The
  // timer is cleared once headers arrive, so a long generation stream is never cut.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(LOCAL_LLM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "system", content: LOCAL_SYSTEM_PROMPT },
          ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
          { role: "user", content: buildPrompt(question, contexts) },
        ],
      }),
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`local model did not respond within ${LOCAL_CONNECT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok || !res.body) {
    throw new Error(`local model ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        const delta = evt.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    }
  }
}

/** Local, no-network answer: stream the top passages with citations. */
async function* extractive(question: string, contexts: Ctx[], noKey: boolean): AsyncGenerator<string> {
  const head = noKey
    ? `Based on the included files, the most relevant passages for "${question}":\n\n`
    : "";
  const body =
    contexts
      .slice(0, 3)
      .map((c, i) => `[${i + 1}] **${c.name}** — ${c.text.slice(0, 300).trim()}…`)
      .join("\n\n") +
    // Only nudge about a key when there genuinely isn't one — not when we fell
    // back after a transient model error despite a configured key.
    (noKey ? `\n\n_Configure an Anthropic key in onboarding for synthesized answers._` : "");

  for (const word of (head + body).split(/(\s+)/)) {
    yield word;
    await new Promise((r) => setTimeout(r, 6));
  }
}
