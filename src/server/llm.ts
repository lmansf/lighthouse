/**
 * Answer generation. Grounds every answer in the retrieved vault context.
 *
 * - Anthropic Claude (when a key + the Anthropic provider are configured):
 *   real streamed tokens via the Messages API over `fetch` (no SDK dependency).
 * - Otherwise: a fully-local extractive fallback that streams the most relevant
 *   passages, so the app is useful with zero configuration and zero network.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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
): AsyncGenerator<string> {
  if (contexts.length === 0) {
    yield "Nothing relevant is included in the RAG index yet. Add or include files in the explorer, then ask again.";
    return;
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
): AsyncGenerator<string> {
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
        "You are RAG Vault's assistant. Answer only from the provided context and cite sources as [n]. Be concise.",
      messages: [{ role: "user", content: buildPrompt(question, contexts) }],
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
