/**
 * @-mention parsing for the chat composer (openspec: add-usability-field-patch
 * §2). A pure, DOM-free helper: given the composer's text and caret offset, it
 * finds the `@…` token the caret is currently in (if any) so the composer can
 * open an inline file picker ranked by the SAME matcher quick-open uses
 * (`quickOpenMatches`). Accepting a row strips this span and attaches the file.
 *
 * Trigger rule (deliberately conservative, so prose and emails don't fire):
 *   - the `@` must sit at the very start of the text OR right after whitespace
 *     (so `you@example.com` never opens the picker), and
 *   - the run from `@` to the caret must contain no whitespace (a space ends the
 *     mention). The run after `@` is the query — empty right after typing `@`.
 *
 * DOM-free and dependency-free by construction (test/mentionQuery.test.mjs runs
 * it straight under node).
 */

/** The active `@…` token under the caret: its query text and its [start,end)
 *  span in the source (start is the `@`, end is the caret). */
export interface MentionSpan {
  query: string;
  start: number;
  end: number;
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * The `@`-mention token the caret is inside, or null when the caret isn't in
 * one. `caret` is clamped to [0, text.length]; a query longer than
 * `maxQueryLen` (a stray `@` in a long line) yields null so the whole tail of a
 * sentence never becomes a search.
 */
export function activeMention(text: string, caret: number, maxQueryLen = 100): MentionSpan | null {
  const end = Math.max(0, Math.min(caret, text.length));
  // Walk back from the caret to the token's `@`, bailing on any whitespace.
  let i = end - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") break;
    if (isSpace(ch)) return null;
    i -= 1;
  }
  if (i < 0 || text[i] !== "@") return null;
  // The `@` must begin a token: start-of-text or just after whitespace, never
  // mid-word (an email local-part, a handle already typed).
  const before = i > 0 ? text[i - 1] : "";
  if (before !== "" && !isSpace(before)) return null;
  const query = text.slice(i + 1, end);
  if (query.length > maxQueryLen) return null;
  return { query, start: i, end };
}

/** Replace an active mention span with `replacement` (default: strip it), and
 *  report the caret offset that should follow. Used on accept to drop the
 *  `@fragment` from the question once the file becomes an attachment. */
export function replaceMention(
  text: string,
  span: MentionSpan,
  replacement = "",
): { text: string; caret: number } {
  const next = text.slice(0, span.start) + replacement + text.slice(span.end);
  return { text: next, caret: span.start + replacement.length };
}
