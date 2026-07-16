import { create } from "zustand";
import type { AnalyticsMeta, ChatChunk, ChatMessage } from "@/contracts";
import { chatHistoryLocked } from "./managedLocks";

/**
 * Multi-conversation chat history — OFF by default, opt-in per device.
 *
 * By default nothing is written to disk: conversations live only in memory for
 * the current session (the recent-chats list still works, but everything clears
 * when the app closes). When the user turns on "save chats on this device"
 * (setPersistEnabled), conversations are mirrored to localStorage so they
 * survive a restart — deletable individually, and dropped automatically once
 * they've gone untouched for two weeks.
 *
 * "New chat" never destroys anything — it starts a fresh conversation while the
 * previous one stays in the list (with a one-click Undo back to it).
 *
 * `localStorage` is genuinely disk-backed in both the browser and the desktop
 * webview, so a single client-side store covers web and desktop with no
 * server/IPC parity to maintain — chat history is UI state, not vault state.
 */
const KEY = "lighthouse.chat.history.v1";
// Opt-in flag: "1" once the user has turned on saving chats to this device.
const PERSIST_KEY = "lighthouse.chat.persist";
// The current investigation pointer (openspec: add-investigations §4.1) — its
// OWN key, deliberately outside the history envelope: it's UI context (like
// the sidebar-collapsed flag), not a transcript, so it survives a reload even
// with "save chats on this device" off and is never wiped with history.
const INVESTIGATION_KEY = "lighthouse.chat.investigation";
// The pre-history session-only key, migrated once (only when saving is on) so an
// in-progress transcript isn't dropped when a user upgrades into this version.
const LEGACY_KEY = "lighthouse.chat.transcript.v1";
// Saved chats untouched for this long are pruned automatically (on load + save).
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
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
   * turn renders an inline banner with Retry instead of an answer.
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
  /**
   * Analytics provenance from the final chunk (exact SQL + files read) —
   * powers refinement chips and Edit SQL on this turn. Desktop engine only.
   */
  analytics?: AnalyticsMeta;
  /**
   * Engine-emitted provenance stamp from the final chunk: where the answer was
   * computed ("device" or the cloud provider id) and how much was sent. Never
   * derived from model text — rendered verbatim as the "Answered on this
   * device / via <vendor>" footer under the answer.
   */
  meta?: ChatChunk["meta"];
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
  /**
   * The investigation this conversation belongs to (openspec:
   * add-investigations): stamped at creation from the then-current context and
   * never re-stamped afterwards. Absent = the global context — every
   * conversation from before investigations existed stays there.
   */
  investigationId?: string;
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

function emptyConversation(investigationId?: string | null): Conversation {
  const now = Date.now();
  return {
    id: newId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
    // Stamped at birth (openspec: add-investigations): a conversation belongs
    // to the context it was started in, for its whole life.
    ...(investigationId ? { investigationId } : {}),
  };
}

/**
 * The conversation list for a context (openspec: add-investigations §4.1) —
 * the pure filter behind the history drawer. Membership is exact:
 *
 *  - inside an investigation, ONLY its own conversations show;
 *  - the global context (`null`) shows ONLY unassigned conversations — an
 *    investigation's chats live inside it, so the global view is deliberately
 *    NOT a mixed bucket of everything. Conversations from before
 *    investigations existed carry no id and therefore stay global.
 *
 * Exported for unit tests (test/chatStore.investigations.test.mjs).
 */
export function conversationsForContext(
  conversations: Conversation[],
  currentInvestigationId: string | null,
): Conversation[] {
  return conversations.filter((c) => (c.investigationId ?? null) === currentInvestigationId);
}

/** Read the persisted current-investigation pointer (null = global context). */
function loadCurrentInvestigation(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(INVESTIGATION_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist the pointer (its own key — see INVESTIGATION_KEY). */
function saveCurrentInvestigation(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) window.localStorage.removeItem(INVESTIGATION_KEY);
    else window.localStorage.setItem(INVESTIGATION_KEY, id);
  } catch {
    /* storage blocked — the in-session context still works */
  }
}

/** First user line, trimmed to a scannable list title. */
function deriveTitle(messages: TranscriptMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "New conversation";
  const t = firstUser.content.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

/**
 * Managed policy `chatHistory: "off"` (openspec: add-managed-policy): history
 * has no engine-side write path — this store IS the write path — so the lock
 * is enforced here, from the signal the rag store publishes when the policy
 * snapshot loads (see managedLocks.ts for why it's not a store import).
 * Existing saved chats stay readable (lock-not-wipe); only writes refuse.
 */
function historyLocked(): boolean {
  return chatHistoryLocked();
}

/** Whether the user has opted into saving chats on this device (default off). */
function persistEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (historyLocked()) return false;
  try {
    return window.localStorage.getItem(PERSIST_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Drop conversations untouched for over two weeks — but never the active one, so
 * a chat you're in the middle of never vanishes out from under you. `now` is
 * injectable so the two-week cutoff is unit-testable without waiting a fortnight.
 */
export function pruneByAge(
  conversations: Conversation[],
  currentId: string,
  now: number = Date.now(),
): Conversation[] {
  const cutoff = now - TWO_WEEKS_MS;
  return conversations.filter((c) => c.id === currentId || c.updatedAt >= cutoff);
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
  // Saving off (or SSR): start fresh, in memory only — nothing is read from disk.
  if (typeof window === "undefined" || !persistEnabled()) {
    // Honor "off = nothing of mine is stored": drop any transcript left on disk
    // (e.g. from an earlier version that saved by default) so never-opted-in —
    // and opted-back-out — genuinely leaves nothing behind, and a later opt-in
    // starts clean instead of resurrecting or clobbering stale history. Guarded
    // by the persistEnabled() check above, whose "1" read can only be readably
    // false when the user hasn't opted in, so a real saved history is never hit.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
    const c = emptyConversation();
    return { conversations: [c], currentId: c.id };
  }
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      const all = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      if (all.length) {
        const currentId =
          parsed.currentId && all.some((c) => c.id === parsed.currentId)
            ? parsed.currentId
            : all[0].id;
        // Auto-expire anything untouched for over two weeks (keeps the active one).
        return { conversations: pruneByAge(all, currentId), currentId };
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
  // In-memory only unless the user has opted into saving chats on this device.
  if (typeof window === "undefined" || !persistEnabled()) return;
  // Expire >2wk-untouched chats, drop empty non-current ones (an abandoned "New
  // chat"), and cap the total count, newest-first.
  let keep = pruneByAge(conversations, currentId)
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
  /** Whether chats are being saved to this device (opt-in; default off). */
  persistEnabled: boolean;
  /**
   * The current investigation context (openspec: add-investigations §4.1);
   * null = the global context. New conversations are stamped with it, the
   * history drawer filters by it (see conversationsForContext), and asks carry
   * it on the wire. Persisted under its own localStorage key — never inside
   * the history envelope.
   */
  currentInvestigationId: string | null;

  /** Replace the active transcript (value or updater, mirrors React's setState). */
  setMessages: (next: MessagesUpdater) => void;
  /**
   * Turn saving chats on this device on or off. On → immediately writes the
   * current in-memory conversations to disk; off → clears everything already on
   * disk (they've opted out of storage) but keeps this session in memory.
   */
  setPersistEnabled: (on: boolean) => void;
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
  /**
   * Switch the investigation context (null = global). When the active
   * conversation doesn't belong to the new context, this behaves like "New
   * chat" within it — a fresh conversation stamped with the new id — so
   * transcripts are never mixed across contexts; an empty scratch
   * conversation is adopted in place instead of minting another.
   */
  setCurrentInvestigation: (id: string | null) => void;
  /** Give a conversation a custom title (stops the auto-title following Q1). */
  renameConversation: (id: string, title: string) => void;
  /** Delete a conversation; deleting the active one falls back to the newest. */
  deleteConversation: (id: string) => void;
}

export const useChatStore = create<ChatStore>((set) => {
  const init = bootstrap();
  const current = init.conversations.find((c) => c.id === init.currentId) ?? init.conversations[0];
  // Reconcile the restored investigation pointer with the restored active
  // conversation (openspec: add-investigations): context follows a real
  // conversation (same rule as openConversation), while a fresh/empty scratch
  // conversation is stamped INTO the restored context so the first ask after a
  // reload still lands in the investigation.
  let currentInvestigationId = loadCurrentInvestigation();
  if (current.messages.length > 0) {
    currentInvestigationId = current.investigationId ?? null;
    saveCurrentInvestigation(currentInvestigationId);
  } else if (currentInvestigationId) {
    current.investigationId = currentInvestigationId;
  }
  return {
    conversations: init.conversations,
    currentId: current.id,
    messages: current.messages,
    lastLeftId: null,
    persistEnabled: persistEnabled(),
    currentInvestigationId,

    setMessages: (next) =>
      set((s) => ({
        messages:
          typeof next === "function"
            ? (next as (p: TranscriptMessage[]) => TranscriptMessage[])(s.messages)
            : next,
      })),

    setPersistEnabled: (on) =>
      set((s) => {
        // Managed policy: turning saving ON is refused while locked (the
        // toggle renders disabled too — this guards non-UI callers).
        if (on && historyLocked()) return s;
        try {
          // Set the flag first so save()'s persistEnabled() check sees the new value.
          window.localStorage.setItem(PERSIST_KEY, on ? "1" : "0");
        } catch {
          /* storage blocked — the in-session toggle still works */
        }
        if (on) {
          // Start saving: flush the current in-memory conversations to disk.
          save(s.conversations, s.currentId);
        } else {
          // Stop saving and clear what's already on disk — they opted out.
          try {
            window.localStorage.removeItem(KEY);
          } catch {
            /* ignore */
          }
        }
        return { persistEnabled: on };
      }),

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
            // A reconstructed conversation belongs to the context it was
            // being held in (openspec: add-investigations).
            ...(s.currentInvestigationId ? { investigationId: s.currentInvestigationId } : {}),
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
        // "New chat" stays within the current investigation (openspec:
        // add-investigations): the fresh conversation is stamped with it.
        const fresh = emptyConversation(s.currentInvestigationId);
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
        // Context follows the conversation (same rule as openConversation) —
        // in practice Undo lands in the same context New chat left.
        const investigationId = target.investigationId ?? null;
        saveCurrentInvestigation(investigationId);
        return {
          conversations,
          currentId: target.id,
          messages: target.messages,
          lastLeftId: null,
          currentInvestigationId: investigationId,
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
        // Opening a conversation from another investigation ALSO switches the
        // context to match (openspec: add-investigations): the transcript and
        // its scope/policy surfaces must never disagree.
        const investigationId = target.investigationId ?? null;
        saveCurrentInvestigation(investigationId);
        return {
          conversations,
          currentId: id,
          messages: target.messages,
          lastLeftId: null,
          currentInvestigationId: investigationId,
        };
      }),

    setCurrentInvestigation: (id) =>
      set((s) => {
        const next = id ?? null;
        if (next === s.currentInvestigationId) return {};
        saveCurrentInvestigation(next);
        const current = s.conversations.find((c) => c.id === s.currentId);
        // An empty scratch conversation has no transcript to mix: adopt it
        // into the new context in place instead of minting another empty one.
        if (!current || current.messages.length === 0) {
          const conversations = s.conversations.map((c) =>
            c.id === s.currentId
              ? { ...c, investigationId: next ?? undefined }
              : c,
          );
          save(conversations, s.currentId);
          return { conversations, currentInvestigationId: next };
        }
        // The active conversation already belongs to the new context (e.g. a
        // pointer restored out of sync) — just move the pointer.
        if ((current.investigationId ?? null) === next) {
          return { currentInvestigationId: next };
        }
        // The active conversation belongs elsewhere: behave like "New chat"
        // within the new context — a fresh stamped conversation, the old one
        // kept in history (fold the live transcript back in first, like
        // openConversation). lastLeftId is cleared, not set: an Undo strip
        // that silently jumped contexts would be more confusing than helpful.
        const fresh = emptyConversation(next);
        const conversations = [
          fresh,
          ...s.conversations.map((c) => (c.id === s.currentId ? { ...c, messages: s.messages } : c)),
        ];
        save(conversations, fresh.id);
        return {
          conversations,
          currentId: fresh.id,
          messages: fresh.messages,
          lastLeftId: null,
          currentInvestigationId: next,
        };
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
        // Deleting the active conversation: fall back to the newest remaining
        // IN THE CURRENT CONTEXT (deleting an investigation's last chat must
        // not teleport the user into another context's transcript), or a fresh
        // empty one stamped with the context when none is left there.
        const newest = conversationsForContext(remaining, s.currentInvestigationId)
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const next = newest ?? emptyConversation(s.currentInvestigationId);
        const conversations = newest ? remaining : [...remaining, next];
        save(conversations, next.id);
        return { conversations, currentId: next.id, messages: next.messages, lastLeftId: null };
      }),
  };
});
