/**
 * Ask type-ahead (time-savers): local autocomplete over past asks.
 *
 * A pure, deterministic ranker: given the draft in the ask box and plain
 * arrays of PAST user asks (recent-chats store) and PINNED questions, surface
 * the handful worth one keystroke to finish. It never calls a model and never
 * touches the network — it only ranks text the user already typed (or pinned),
 * so a repeated ask is a fill away (and, paired with the answer cache, often
 * an instant answer).
 *
 * Client-only by construction, like recall.ts: conversations live in the
 * front-end store (localStorage, opt-in — add-chat-history), so there is no
 * Rust twin. The input shape is decoupled from the store so this is
 * unit-testable without React (test/askTypeahead.test.mjs) — history-off
 * gating is the CALLER's job (the store then only holds this session's asks).
 *
 * Ranking, in dominance order:
 *   1. Match tier — a case-insensitive PREFIX match always outranks a
 *      subsequence match, however recent/frequent the latter.
 *   2. Match quality — for subsequences, how tightly the draft's characters
 *      cluster in the candidate (a substring scores 1; scattered letters less).
 *   3. Recency (7-day half-life) + frequency (repeats up to ~8×) — history
 *      signals; pins carry neither and get a fixed mid-range baseline instead.
 * Identical texts (case/whitespace-insensitive) dedupe into one suggestion,
 * merging recency (newest wins) and frequency (occurrences sum); a text that
 * is BOTH pinned and in history keeps the "pin" label with history's signals.
 * Ties break by text so equal inputs always produce identical output.
 */

/** One past ask. Messages carry no per-turn clock, so callers pass the owning
 *  conversation's `updatedAt` as `ts` — coarse, but consistent and honest. */
export interface AskHistoryItem {
  /** The ask, verbatim (returned verbatim too — matching normalizes a copy). */
  text: string;
  /** Epoch ms of when it was (last) asked. */
  ts: number;
  /** How many times this exact ask was sent (default 1). */
  count?: number;
}

export interface AskSources {
  /** Past user asks — all saved chats, or just this session's when history is off. */
  history: readonly AskHistoryItem[];
  /** Pinned questions' texts (curated, engine-side; no timestamps). */
  pins?: readonly string[];
}

/** One suggestion row: what to fill, where it came from, and its rank score. */
export interface AskSuggestion {
  text: string;
  source: "history" | "pin";
  score: number;
}

export interface AskSuggestOptions {
  /** Max suggestions to return (default ASK_SUGGESTION_LIMIT). */
  limit?: number;
  /** Injectable clock for deterministic recency (tests); default Date.now(). */
  now?: number;
}

/** Default row cap — the popover stays a glance, not a list to read. */
export const ASK_SUGGESTION_LIMIT = 6;

/** Recency half-life: a week-old ask carries half the recency of a fresh one
 *  (two half-lives spans the recent-chats store's two-week retention). */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

// Weights. TIER_PREFIX dominates by construction: the largest possible
// non-tier score (W_QUALITY + W_RECENCY + W_FREQUENCY = 160) can never reach
// it, so "prefix beats subsequence" holds regardless of the other signals.
const TIER_PREFIX = 1000;
const W_QUALITY = 100;
const W_RECENCY = 40;
const W_FREQUENCY = 20;
/** Pins have no ts/count; rank them as a mid-range history item would. */
const PIN_BASELINE = 20;

/** Whitespace-collapsed, lowercased matching key (display text stays verbatim). */
function matchKey(s: string): string {
  return s.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Greedy in-order scan: the width of the candidate window containing the
 * draft's characters in order, or null when the draft isn't a subsequence.
 * A contiguous match (substring) has span === draft.length.
 */
function subsequenceSpan(draft: string, candidate: string): number | null {
  let from = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < draft.length; i += 1) {
    const at = candidate.indexOf(draft[i], from);
    if (at < 0) return null;
    if (first < 0) first = at;
    last = at;
    from = at + 1;
  }
  return first < 0 ? null : last - first + 1;
}

/** 1 for a just-asked item, halving every RECENCY_HALF_LIFE_MS. */
function recencyScore(now: number, ts: number): number {
  return Math.pow(0.5, Math.max(0, now - ts) / RECENCY_HALF_LIFE_MS);
}

/** 0 for a one-off, saturating at 1 once asked 8 times. */
function frequencyScore(count: number): number {
  return Math.min(1, (count - 1) / 7);
}

/**
 * Rank past asks and pinned questions against the draft. Empty (or blank)
 * draft → [] — the popover only opens once there is input. Returns at most
 * `limit` rows, best first; deterministic for identical inputs (inject `now`).
 */
export function askSuggestions(
  draft: string,
  sources: AskSources,
  opts: AskSuggestOptions = {},
): AskSuggestion[] {
  const q = matchKey(draft.trim());
  if (!q) return [];
  const limit = opts.limit ?? ASK_SUGGESTION_LIMIT;
  const now = opts.now ?? Date.now();

  // Aggregate by matching key: identical asks merge (newest ts wins and keeps
  // its casing for display; counts sum), and a pinned twin keeps "pin".
  interface Entry {
    text: string;
    ts: number;
    count: number;
    pinned: boolean;
  }
  const byKey = new Map<string, Entry>();
  for (const h of sources.history) {
    const text = h.text.trim();
    if (!text) continue;
    const count = Math.max(1, Math.floor(h.count ?? 1));
    const key = matchKey(text);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { text, ts: h.ts, count, pinned: false });
    } else {
      prev.count += count;
      if (h.ts >= prev.ts) {
        prev.ts = h.ts;
        prev.text = text;
      }
    }
  }
  for (const p of sources.pins ?? []) {
    const text = p.trim();
    if (!text) continue;
    const key = matchKey(text);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { text, ts: 0, count: 0, pinned: true });
    else prev.pinned = true;
  }

  const out: AskSuggestion[] = [];
  for (const [key, e] of byKey) {
    let tier = 0;
    let quality: number;
    if (key.startsWith(q)) {
      tier = 1;
      quality = 1;
    } else {
      const span = subsequenceSpan(q, key);
      if (span === null) continue;
      quality = q.length / span;
    }
    // count === 0 means pin-only: no history signals, use the fixed baseline.
    const signal =
      e.count > 0
        ? recencyScore(now, e.ts) * W_RECENCY + frequencyScore(e.count) * W_FREQUENCY
        : PIN_BASELINE;
    out.push({
      text: e.text,
      source: e.pinned ? "pin" : "history",
      score: tier * TIER_PREFIX + quality * W_QUALITY + signal,
    });
  }

  out.sort(
    (a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  );
  return out.slice(0, Math.max(0, limit));
}

/** §22.1 ghost autocomplete: extra completion-only sources beside history and
 *  pins — engine suggested asks and certified questions. They feed the GHOST
 *  only, never the dropdown (whose rows stay history/pin labeled). */
export interface GhostSources extends AskSources {
  extras?: readonly string[];
}

/** Below this many typed characters no ghost renders — a one-letter prefix
 *  completes to near-random asks and reads as flicker, not help. */
export const GHOST_MIN_CHARS = 3;

/**
 * §22.1: the single best INLINE continuation of `draft`, or null. Strictly a
 * caseless literal prefix match — the ghost splices verbatim after the caret,
 * so token normalization (which reorders/strips) can't apply here. Candidates
 * rank by the same recency half-life + frequency saturation as the dropdown;
 * pins and extras count as curated (recency-neutral). The returned string is
 * the SUFFIX to render greyed after the caret (source casing preserved).
 * Deterministic for identical inputs (inject `now`).
 */
export function ghostCompletion(
  draft: string,
  sources: GhostSources,
  opts: AskSuggestOptions = {},
): string | null {
  if (draft.trim().length < GHOST_MIN_CHARS) return null;
  const q = draft.toLowerCase();
  const now = opts.now ?? Date.now();
  type Candidate = { suffix: string; score: number; text: string };
  const better = (cur: Candidate | null, text: string, score: number): Candidate | null => {
    if (text.length <= draft.length) return cur; // nothing left to complete
    if (!text.toLowerCase().startsWith(q)) return cur;
    const suffix = text.slice(draft.length);
    if (!cur || score > cur.score || (score === cur.score && text < cur.text)) {
      return { suffix, score, text };
    }
    return cur;
  };
  let best: Candidate | null = null;
  for (const h of sources.history) {
    best = better(best, h.text.trim(), 1 + recencyScore(h.ts, now) + frequencyScore(h.count ?? 1));
  }
  // Curated sources: no timestamps — a flat score below a fresh history hit
  // but above a stale one, so "what you asked recently" wins ties naturally.
  for (const p of sources.pins ?? []) best = better(best, p.trim(), 1.5);
  for (const e of sources.extras ?? []) best = better(best, e.trim(), 1.4);
  return best ? best.suffix : null;
}

/**
 * The most recent past ask — the ArrowUp-on-empty-box shell-style recall.
 * Newest `ts` wins; ties go to the LATER array entry (so an in-order transcript
 * with uniform timestamps recalls its actual last ask). Pins never recall —
 * they're curated questions, not something the user "just asked". Null when
 * there is no history.
 */
export function lastAsk(sources: AskSources): string | null {
  let best: { text: string; ts: number } | null = null;
  for (const h of sources.history) {
    const text = h.text.trim();
    if (!text) continue;
    if (!best || h.ts >= best.ts) best = { text, ts: h.ts };
  }
  return best ? best.text : null;
}
