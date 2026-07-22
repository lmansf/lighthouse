/**
 * §32 §5: quote-digest RAG for the apple-fm tiers — quotes, not chunks.
 * KEEP IN SYNC with native/crates/lighthouse-core/src/quotes.rs (the same
 * cases are pinned in test/quotes.test.mjs and the cargo tests): block count,
 * order, and names are preserved (the `[n]` citation contract), only each
 * block's text shrinks to question-relevant sentences quoted VERBATIM with
 * "…" gap marks. The splitter is conservative — abbreviations, initials,
 * decimals, and list numbering never split; under two sentences rides whole.
 */

export interface QuoteCtx {
  name: string;
  text: string;
  score: number;
}

const ABBREVS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "cf", "al",
  "inc", "ltd", "co", "corp", "no", "dept", "est", "approx", "jan", "feb", "mar", "apr",
  "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "fig", "vol", "rev", "gen",
]);

/** Lowercased alphanumeric tokens ≥ 3 chars (PARITY: analytics.rs question_tokens). */
export function questionTokens(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (raw.length >= 3 && !out.includes(raw)) out.push(raw);
  }
  return out;
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

function suppressed(before: string, term: string): boolean {
  if (term !== ".") return false;
  let word = "";
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const c = before[i];
    if (/[a-z0-9.]/i.test(c)) word = c + word;
    else break;
  }
  const w = word.toLowerCase();
  if (w === "") return true;
  const alnum = w.replace(/\./g, "");
  if (alnum.length === 1 || w.includes(".")) return true;
  if (/^[0-9]+$/.test(w)) return true;
  return ABBREVS.has(w);
}

/** Conservative sentence split — under-splits on any doubt. */
export function splitSentences(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "." || c === "!" || c === "?") {
      let end = i + 1;
      while (end < chars.length && ['"', "'", ")", "”", "’"].includes(chars[end])) end += 1;
      const wsNext = end >= chars.length || /\s/.test(chars[end]);
      let j = end;
      while (j < chars.length && /\s/.test(chars[j])) j += 1;
      const startChar = chars[j];
      const startsNew =
        startChar === undefined ||
        isUpper(startChar) ||
        /[0-9]/.test(startChar) ||
        ['"', "“", "‘"].includes(startChar);
      const decimal = c === "." && /[0-9]/.test(chars[i + 1] ?? "");
      const before = chars.slice(start, i).join("");
      if (wsNext && startsNew && !decimal && !suppressed(before, c)) {
        const s = chars.slice(start, end).join("").trim();
        if (s !== "") out.push(s);
        start = j;
        i = j;
        continue;
      }
    }
    i += 1;
  }
  const tail = chars.slice(start).join("").trim();
  if (tail !== "") out.push(tail);
  return out;
}

function normalized(s: string): string {
  return s.split(/\s+/).join(" ").toLowerCase();
}

function sentenceScore(sentence: string, tokens: string[]): number {
  const s = sentence.toLowerCase();
  const hits = tokens.filter((t) => s.includes(t)).length;
  return hits / (1 + Array.from(sentence).length / 200);
}

function digestText(
  text: string,
  tokens: string[],
  budget: number,
  skip: Set<string>,
): string {
  if (Array.from(text).length <= budget) {
    for (const s of splitSentences(text)) skip.add(normalized(s));
    return text;
  }
  const sentences = splitSentences(text);
  if (sentences.length < 2) {
    return Array.from(text).slice(0, budget).join("") + "…";
  }
  const fresh = sentences
    .map((s, i) => [i, s] as const)
    .filter(([, s]) => !skip.has(normalized(s)));
  const scored = fresh.map(([i, s]) => [i, sentenceScore(s, tokens)] as const);
  const order: number[] = scored.some(([, sc]) => sc > 0)
    ? scored
        .filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([i]) => i)
    : fresh.map(([i]) => i);
  const keep: number[] = [];
  let used = 0;
  for (const i of order) {
    const n = Array.from(sentences[i]).length + 4;
    if (used + n > budget) continue;
    used += n;
    keep.push(i);
  }
  if (keep.length === 0) {
    return Array.from(text).slice(0, budget).join("") + "…";
  }
  keep.sort((a, b) => a - b);
  const parts: string[] = [];
  let prev: number | null = null;
  for (const i of keep) {
    skip.add(normalized(sentences[i]));
    if (prev !== null) {
      if (i !== prev + 1) parts.push("…");
    } else if (i !== 0) {
      parts.push("…");
    }
    parts.push(sentences[i]);
    prev = i;
  }
  if (prev !== null && prev + 1 < sentences.length) parts.push("…");
  return parts.join(" ");
}

/**
 * The retrieved blocks, digested for a shared-window tier — count, order,
 * names, and scores untouched; texts shrink to verbatim quotes inside the
 * §1 segment budgets.
 */
export function digestContexts(
  contexts: QuoteCtx[],
  question: string,
  blockBudget: number,
  totalBudget: number,
): QuoteCtx[] {
  if (contexts.length === 0) return contexts;
  const tokens = questionTokens(question);
  const share = Math.min(Math.max(Math.floor(totalBudget / contexts.length), 280), blockBudget);
  const skip = new Set<string>();
  return contexts.map((c) => ({
    name: c.name,
    text: digestText(c.text, tokens, share, skip),
    score: c.score,
  }));
}
