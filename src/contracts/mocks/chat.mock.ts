import type { ChatService } from "../services";
import type { ChatChunk, ChatTurn } from "../types";
import { ragService } from "./rag.mock";

/**
 * Mock ChatService. Streams a canned answer word-by-word to mimic realtime
 * token streaming, then emits references resolved from the conversation's
 * attachments via the RagService. Swap for a real model call behind this
 * surface.
 */
class MockChatService implements ChatService {
  async *ask(
    question: string,
    history: ChatTurn[] = [],
    attachmentFileIds: string[] = [],
    signal?: AbortSignal,
    opts?: { conversationId?: string },
  ): AsyncIterable<ChatChunk> {
    // Mirror the real service: the conversation's attachments are the corpus,
    // and a non-empty `attachmentFileIds` narrows to a subset of them.
    const conversationId = opts?.conversationId ?? "";
    const references = await ragService.search(conversationId, question, attachmentFileIds);
    const files = await ragService.listAttachments(conversationId);
    const followUp = history.some((t) => t.role === "user");
    const answer = files.length
      ? `${followUp ? "Following up: " : ""}Based on the ${files.length} file(s) attached to this chat, here is what I found regarding "${question}". This is a mock answer streamed in realtime to demonstrate the chat seam.`
      : `Nothing is attached to this chat yet, so I can't ground an answer. Attach a file and ask again.`;

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
