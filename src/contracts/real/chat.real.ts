/** Real ChatService — streams grounded answers from the local `/api/chat` route
 *  (newline-delimited ChatChunk JSON). */
import type { ChatService } from "../services";
import type { ChatChunk } from "../types";

class RealChatService implements ChatService {
  async *ask(question: string, includedFileIds: string[]): AsyncIterable<ChatChunk> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, includedFileIds }),
    });
    if (!res.ok || !res.body) {
      yield { delta: `Chat failed (${res.status}).`, done: true };
      return;
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
