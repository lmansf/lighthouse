import { create } from "zustand";
import type { ChatMessage } from "@/contracts";

/**
 * Session-scoped chat transcript.
 *
 * The conversation used to live in ChatPanel's local state, so it vanished the
 * moment the panel unmounted (switching away from chat) or the window reloaded.
 * Lifting it here keeps the transcript for the whole session: it survives
 * navigation in-memory, and is mirrored to `sessionStorage` so a reload restores
 * it too. It is intentionally NOT written to disk - "cached for a session" means
 * it clears when the app fully closes (and "New chat" clears it immediately).
 */
const KEY = "lighthouse.chat.transcript.v1";

function load(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

function save(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(messages));
  } catch {
    /* sessionStorage may be unavailable/full; the in-memory copy still holds */
  }
}

type MessagesUpdater = ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]);

interface ChatStore {
  messages: ChatMessage[];
  /** Replace the transcript (value or updater, mirrors React's setState). */
  setMessages: (next: MessagesUpdater) => void;
  /**
   * Persist the current transcript to sessionStorage. Called once a turn settles
   * rather than on every streamed token, so streaming stays cheap.
   */
  persist: () => void;
  /** Clear the transcript (New chat). */
  clear: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: load(),
  setMessages: (next) =>
    set((s) => ({
      messages:
        typeof next === "function" ? (next as (p: ChatMessage[]) => ChatMessage[])(s.messages) : next,
    })),
  persist: () => save(get().messages),
  clear: () => {
    save([]);
    set({ messages: [] });
  },
}));
