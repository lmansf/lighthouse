/**
 * Cross-conversation recall (openspec: add-conversation-recall).
 *
 * A pure, deterministic ranker: given the current draft question and the user's
 * stored conversations, surface the most relevant PRIOR exchanges from their
 * OTHER chats. It never calls a model and never touches the network — it only
 * ranks what the user already said, by lexical overlap, so the "why did this
 * match?" is always explainable (shared words).
 *
 * Client-only by construction: conversations live in the front-end store
 * (localStorage, opt-in — add-chat-history); there is no engine-side
 * conversation store, so there is no Rust twin (like theme persistence). The
 * input shape is decoupled from the store so this is unit-testable without React
 * (test/recall.test.mjs).
 */

export interface RecallMessage {
  role: string; // "user" | "assistant" | …
  content: string;
}

export interface RecallConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: RecallMessage[];
}

/** One recalled exchange: a past question, its answer, and why it surfaced. */
export interface RecallHit {
  conversationId: string;
  conversationTitle: string;
  question: string;
  answer: string;
  updatedAt: number;
  score: number;
}

export interface RecallOptions {
  /** The conversation being composed — excluded from its own recall. */
  currentId?: string;
  /** Max hits to return (default 3). */
  limit?: number;
}

/** A draft with fewer meaningful tokens than this isn't a recall signal. */
export const MIN_QUERY_TOKENS = 2;
/** An exchange must share at least this many query tokens to surface. */
export const MIN_SCORE = 2;
const DEFAULT_LIMIT = 3;

// Small, boring stop-word set — enough to keep "the/of/what" from dominating
// overlap without trying to be a real NLP stemmer.
const STOP = new Set([
  "the", "and", "for", "are", "was", "were", "what", "which", "with", "that",
  "this", "from", "have", "has", "had", "how", "why", "when", "who", "does",
  "did", "can", "could", "would", "should", "about", "into", "over", "per",
  "you", "your", "our", "their", "its", "all", "any", "get", "got", "show",
  "give", "tell", "list", "find", "please",
]);

/** Lowercased word tokens of length ≥3, minus stop-words. */
export function recallTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP.has(raw)) out.add(raw);
  }
  return out;
}

/** Pair each user message with the next assistant reply. */
function exchanges(messages: RecallMessage[]): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  let pendingUser: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      pendingUser = m.content;
    } else if (m.role === "assistant" && pendingUser !== null) {
      out.push({ question: pendingUser, answer: m.content });
      pendingUser = null;
    }
  }
  return out;
}

/**
 * Rank prior exchanges by overlap with the draft. Returns at most `limit` hits,
 * one (the best) per conversation, each scoring ≥ MIN_SCORE — sorted by score
 * then recency. Empty when the draft is too thin or nothing matches, so callers
 * can render the affordance iff the result is non-empty.
 */
export function recallRelated(
  query: string,
  conversations: RecallConversation[],
  opts: RecallOptions = {},
): RecallHit[] {
  const q = recallTokens(query);
  if (q.size < MIN_QUERY_TOKENS) return [];
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const perConversation: RecallHit[] = [];
  for (const c of conversations) {
    if (c.id === opts.currentId) continue;
    let best: RecallHit | null = null;
    for (const ex of exchanges(c.messages)) {
      // Match against question AND answer vocabulary — the answer often carries
      // the terms a terse question omitted.
      const terms = recallTokens(`${ex.question} ${ex.answer}`);
      let score = 0;
      for (const t of q) if (terms.has(t)) score += 1;
      if (score >= MIN_SCORE && (best === null || score > best.score)) {
        best = {
          conversationId: c.id,
          conversationTitle: c.title,
          question: ex.question,
          answer: ex.answer,
          updatedAt: c.updatedAt,
          score,
        };
      }
    }
    if (best) perConversation.push(best);
  }

  perConversation.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return perConversation.slice(0, limit);
}
