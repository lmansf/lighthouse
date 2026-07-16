/** Real ChatService — streams grounded answers from the local `/api/chat` route
 *  (newline-delimited ChatChunk JSON). */
import type { AskOptions, ChatService } from "../services";
import type { ChatChunk, ChatTurn } from "../types";

class RealChatService implements ChatService {
  async *ask(
    question: string,
    includedFileIds: string[],
    history: ChatTurn[] = [],
    attachmentFileIds: string[] = [],
    signal?: AbortSignal,
    opts?: AskOptions,
  ): AsyncIterable<ChatChunk> {
    // `signal` cancels both the request and (once streaming) the body reader —
    // aborting rejects the pending read with an AbortError, which propagates out
    // of this generator so the chat UI can keep the partial answer.
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        includedFileIds,
        history,
        attachmentFileIds,
        // Answer-cache controls (openspec: add-answer-cache) — explicit
        // booleans so the wire never carries undefined.
        bypassCache: opts?.bypassCache === true,
        persistAllowed: opts?.persistAllowed === true,
        // The investigation this ask runs inside (openspec:
        // add-investigations). Optional: JSON.stringify drops the key when
        // absent, so a global-context ask stays byte-identical to today's.
        investigationId: opts?.investigationId,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      // Throw (rather than yielding a fake answer) so the chat UI renders its
      // plain-language failure banner with a Retry affordance. The message is
      // phrased to slot into "Couldn't get an answer — {reason}."
      throw new Error(`the model service returned an error (HTTP ${res.status})`);
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
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          yield JSON.parse(l) as ChatChunk;
        } catch {
          /* skip partial frame */
        }
      }
    }
    if (buf.trim()) {
      try {
        yield JSON.parse(buf) as ChatChunk;
      } catch {
        /* ignore trailing */
      }
    }
  }
}

export const chatService: ChatService = new RealChatService();
