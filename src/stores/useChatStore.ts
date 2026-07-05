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

/**
 * A transcript entry: the shared ChatMessage plus UI-only turn state. The extras
 * live here (not in the cross-feature contract types) because only the chat
 * panel renders them - the model never sees them, and `history` sent back to the
 * service is built from role/content alone.
 */
export interface TranscriptMessage extends ChatMessage {
  /**
   * Plain-language reason this turn failed (network / HTTP error). A failed
   * turn renders an inline banner with Retry instead of an answer, and is never
   * read aloud.
   */
  error?: string;
  /** True when the user pressed Stop mid-stream; the partial answer is kept. */
  stopped?: boolean;
  /**
   * Whether any files were visible to AI (included or attached) when this
   * question was asked - drives the "no matching passages" honesty note when an
   * answer comes back with zero references despite available files.
   */
  hadSources?: boolean;
}

function load(): TranscriptMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as TranscriptMessage[]) : [];
  } catch {
    return [];
  }
}

function save(messages: TranscriptMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(messages));
  } catch {
    /* sessionStorage may be unavailable/full; the in-memory copy still holds */
  }
}

type MessagesUpdater = TranscriptMessage[] | ((prev: TranscriptMessage[]) => TranscriptMessage[]);

interface ChatStore {
  messages: TranscriptMessage[];
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
        typeof next === "function"
          ? (next as (p: TranscriptMessage[]) => TranscriptMessage[])(s.messages)
          : next,
    })),
  persist: () => save(get().messages),
  clear: () => {
    save([]);
    set({ messages: [] });
  },
}));
