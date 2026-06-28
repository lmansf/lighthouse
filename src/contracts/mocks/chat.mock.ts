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
  ): AsyncIterable<ChatChunk> {
    const references = await ragService.search(question, includedFileIds);
    const followUp = history.some((t) => t.role === "user");
    const answer = includedFileIds.length
      ? `${followUp ? "Following up: " : ""}Based on the ${includedFileIds.length} included source(s), here is what I found regarding "${question}". This is a mock answer streamed in realtime to demonstrate the chat seam.`
      : `Nothing is currently included in the RAG index, so I can't ground an answer. Highlight some files in the explorer and ask again.`;

    const words = answer.split(" ");
    for (let i = 0; i < words.length; i++) {
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
