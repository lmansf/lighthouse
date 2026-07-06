import { create } from "zustand";
import type { ChatMessage } from "@/contracts";

/**
 * Persistent, multi-conversation chat history.
 *
 * The transcript used to be session-only (mirrored to `sessionStorage`, wiped
 * on "New chat" and gone the moment the app fully closed). This store keeps
 * conversations on disk instead: they survive a full app restart, a "recent
 * chats" list lets users reopen / rename / delete past conversations, and
 * "New chat" no longer destroys anything — it starts a fresh conversation while
 * the previous one stays in the list (with a one-click Undo back to it).
 *
 * `localStorage` is genuinely disk-backed in both the browser and the desktop
 * webview, so a single client-side store covers web and desktop with no
 * server/IPC parity to maintain — chat history is UI state, not vault state.
 */
const KEY = "lighthouse.chat.history.v1";
// The pre-history session-only key, migrated once so an in-progress transcript
// isn't dropped when a user upgrades into this version.
const LEGACY_KEY = "lighthouse.chat.transcript.v1";
// Safety cap so a long-lived install can't grow history past localStorage's
// quota; the oldest conversations are shed first (see save()).
const MAX_CONVERSATIONS = 200;

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

/** One saved conversation: its turns plus list metadata (title, timestamps). */
export interface Conversation {
  id: string;
  title: string;
  /** True once the user has renamed it, so the title stops auto-following Q1. */
  titleCustom?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
}

interface Persisted {
  conversations: Conversation[];
  currentId: string;
}

let seq = 0;
function newId(): string {
  // Time-prefixed + monotonic counter: unique across a session and roughly
  // sortable, without needing crypto.
  seq += 1;
  return `c${Date.now().toString(36)}${seq.toString(36)}`;
}

function emptyConversation(): Conversation {
  const now = Date.now();
  return { id: newId(), title: "New conversation", createdAt: now, updatedAt: now, messages: [] };
}

/** First user line, trimmed to a scannable list title. */
function deriveTitle(messages: TranscriptMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "New conversation";
  const t = firstUser.content.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

/** Seed history from any pre-history session transcript (one-time migration). */
function migrateLegacy(): Conversation[] {
  try {
    const raw = window.sessionStorage.getItem(LEGACY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed) && parsed.length) {
      const messages = parsed as TranscriptMessage[];
      const now = Date.now();
      return [
        { id: newId(), title: deriveTitle(messages), createdAt: now, updatedAt: now, messages },
      ];
    }
  } catch {
    /* ignore a malformed legacy blob */
  }
  return [];
}

function bootstrap(): Persisted {
  if (typeof window === "undefined") {
    const c = emptyConversation();
    return { conversations: [c], currentId: c.id };
  }
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      if (conversations.length) {
        const currentId =
          parsed.currentId && conversations.some((c) => c.id === parsed.currentId)
            ? parsed.currentId
            : conversations[0].id;
        return { conversations, currentId };
      }
    }
    const migrated = migrateLegacy();
    if (migrated.length) return { conversations: migrated, currentId: migrated[0].id };
  } catch {
    /* fall through to a fresh conversation */
  }
  const c = emptyConversation();
  return { conversations: [c], currentId: c.id };
}

function save(conversations: Conversation[], currentId: string): void {
  if (typeof window === "undefined") return;
  // Drop empty, non-current conversations (an abandoned "New chat") and cap the
  // total count, newest-first.
  let keep = conversations
    .filter((c) => c.id === currentId || c.messages.length > 0)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  for (;;) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ conversations: keep, currentId }));
      return;
    } catch {
      // Quota exceeded (or storage unavailable): shed the oldest conversation
      // that isn't the current one and retry; give up once only current remains.
      let removed = false;
      for (let i = keep.length - 1; i >= 0; i -= 1) {
        if (keep[i].id !== currentId) {
          keep.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) return;
    }
  }
}

type MessagesUpdater = TranscriptMessage[] | ((prev: TranscriptMessage[]) => TranscriptMessage[]);

interface ChatStore {
  /** All saved conversations (order is not guaranteed; sort by updatedAt to display). */
  conversations: Conversation[];
  /** The active conversation's id. */
  currentId: string;
  /** The active conversation's live transcript (streamed into during a turn). */
  messages: TranscriptMessage[];
  /** The conversation the most recent "New chat" left behind, for one-click Undo. */
  lastLeftId: string | null;

  /** Replace the active transcript (value or updater, mirrors React's setState). */
  setMessages: (next: MessagesUpdater) => void;
  /**
   * Fold the live transcript into its conversation and write to disk. Called
   * once a turn settles rather than on every streamed token, so streaming stays
   * cheap.
   */
  persist: () => void;
  /**
   * Start a fresh conversation, keeping the current one in history. A no-op when
   * the current conversation is already empty (nothing to archive).
   */
  newConversation: () => void;
  /** Reopen the conversation left behind by the most recent New chat (Undo). */
  undoNewConversation: () => void;
  /** Switch the active conversation to an existing one. */
  openConversation: (id: string) => void;
  /** Give a conversation a custom title (stops the auto-title following Q1). */
  renameConversation: (id: string, title: string) => void;
  /** Delete a conversation; deleting the active one falls back to the newest. */
  deleteConversation: (id: string) => void;
}

export const useChatStore = create<ChatStore>((set) => {
  const init = bootstrap();
  const current = init.conversations.find((c) => c.id === init.currentId) ?? init.conversations[0];
  return {
    conversations: init.conversations,
    currentId: current.id,
    messages: current.messages,
    lastLeftId: null,

    setMessages: (next) =>
      set((s) => ({
        messages:
          typeof next === "function"
            ? (next as (p: TranscriptMessage[]) => TranscriptMessage[])(s.messages)
            : next,
      })),

    persist: () =>
      set((s) => {
        const now = Date.now();
        let found = false;
        const conversations = s.conversations.map((c) => {
          if (c.id !== s.currentId) return c;
          found = true;
          return {
            ...c,
            messages: s.messages,
            updatedAt: now,
            title: c.titleCustom ? c.title : deriveTitle(s.messages),
          };
        });
        if (!found) {
          conversations.push({
            id: s.currentId,
            title: deriveTitle(s.messages),
            createdAt: now,
            updatedAt: now,
            messages: s.messages,
          });
        }
        save(conversations, s.currentId);
        return { conversations };
      }),

    newConversation: () =>
      set((s) => {
        const current = s.conversations.find((c) => c.id === s.currentId);
        // Nothing to archive if the current conversation is empty — just stay.
        if (!current || current.messages.length === 0) return {};
        const fresh = emptyConversation();
        const conversations = [fresh, ...s.conversations];
        save(conversations, fresh.id);
        return {
          conversations,
          currentId: fresh.id,
          messages: fresh.messages,
          lastLeftId: s.currentId,
        };
      }),

    undoNewConversation: () =>
      set((s) => {
        if (!s.lastLeftId) return {};
        const target = s.conversations.find((c) => c.id === s.lastLeftId);
        if (!target) return {};
        // Drop the empty scratch conversation the New chat created.
        const conversations = s.conversations.filter(
          (c) => !(c.id === s.currentId && c.messages.length === 0),
        );
        save(conversations, target.id);
        return {
          conversations,
          currentId: target.id,
          messages: target.messages,
          lastLeftId: null,
        };
      }),

    openConversation: (id) =>
      set((s) => {
        if (id === s.currentId) return {};
        const target = s.conversations.find((c) => c.id === id);
        if (!target) return {};
        const conversations = s.conversations
          // Fold the live transcript back into the current conversation…
          .map((c) => (c.id === s.currentId ? { ...c, messages: s.messages } : c))
          // …then shed the current one if it was an empty scratch conversation.
          .filter((c) => !(c.id === s.currentId && s.messages.length === 0));
        save(conversations, id);
        return { conversations, currentId: id, messages: target.messages, lastLeftId: null };
      }),

    renameConversation: (id, title) =>
      set((s) => {
        const clean = title.trim().slice(0, 120) || "Untitled";
        const conversations = s.conversations.map((c) =>
          c.id === id ? { ...c, title: clean, titleCustom: true } : c,
        );
        save(conversations, s.currentId);
        return { conversations };
      }),

    deleteConversation: (id) =>
      set((s) => {
        const remaining = s.conversations.filter((c) => c.id !== id);
        if (id !== s.currentId) {
          save(remaining, s.currentId);
          return { conversations: remaining };
        }
        // Deleting the active conversation: fall back to the newest remaining,
        // or a fresh empty one when nothing is left.
        const newest = remaining.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const next = newest ?? emptyConversation();
        const conversations = newest ? remaining : [next];
        save(conversations, next.id);
        return { conversations, currentId: next.id, messages: next.messages, lastLeftId: null };
      }),
  };
});
