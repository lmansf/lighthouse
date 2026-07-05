import type { ChatService } from "../services";
import type { ChatChunk, ChatTurn } from "../types";
import { ragService } from "./rag.mock";

/**
 * Mock ChatService. Streams a canned answer word-by-word to mimic realtime
 * token streaming, then emits references resolved from the included file set
 * via the RagService. Swap for a real model call behind this surface.
 */
class MockChatService implements ChatService {
  async *ask(
    question: string,
    includedFileIds: string[],
    history: ChatTurn[] = [],
    attachmentFileIds: string[] = [],
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    // Mirror the real service: explicit attachments scope retrieval to just
    // those files, otherwise the globally included set is searched.
    const scope = attachmentFileIds.length ? attachmentFileIds : includedFileIds;
    const references = await ragService.search(question, scope);
    const followUp = history.some((t) => t.role === "user");
    const answer = includedFileIds.length
      ? `${followUp ? "Following up: " : ""}Based on the ${includedFileIds.length} file(s) visible to AI, here is what I found regarding "${question}". This is a mock answer streamed in realtime to demonstrate the chat seam.`
      : `None of your files are visible to AI yet, so I can't ground an answer. Include some files in the explorer and ask again.`;

    const words = answer.split(" ");
    for (let i = 0; i < words.length; i++) {
      // Honor Stop: surface the abort the same way a cancelled fetch would, so
      // the chat UI's partial-answer handling is exercised in mock mode too.
      if (signal?.aborted) throw new DOMException("The user stopped this answer.", "AbortError");
      await delay(28);
      yield {
        delta: (i === 0 ? "" : " ") + words[i],
        done: false,
      };
    }
    yield { delta: "", references, done: true };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const chatService: ChatService = new MockChatService();
