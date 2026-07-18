// Progressive streaming markdown (usability patch §2, hardened §22.5).
//
// While an answer streams, we used to show the whole accumulated text as PLAIN
// pre-wrapped text (raw `**`, `|`, ```` ``` ```` all visible) and parse markdown
// exactly once, on settle — because re-parsing the WHOLE growing answer on
// every chunk was O(N²) (the ChatPanel note). This module makes streaming
// progressive WITHOUT bringing that cost back:
//
//   1. `safeMarkdownPrefix(text)` returns the largest prefix of the answer that
//      is safe to render as markdown — it holds back a trailing INCOMPLETE
//      construct (an unterminated code fence, a half-typed table row, an
//      unclosed **bold**/`code`/[link]) until its terminator arrives, so raw
//      markup never flashes.
//   2. `splitMarkdownBlocks(prefix)` cuts that prefix into top-level blocks
//      (paragraph / heading / table / fenced code), keeping fences whole.
//
// The renderer memoizes each block, so a settled block parses ONCE and only the
// final growing block re-parses per frame — O(N), not O(N²). On settle the
// whole answer renders through the normal AnswerMarkdown path, so the final
// output is byte-identical to before.
//
// Two invariants hold at every prefix (proved in test/streamingMarkdown.test.mjs
// and test/streamingMarkdownTorture.test.mjs):
//   (a) the safe prefix is always a literal prefix of the input — we only ever
//       truncate, never rewrite;
//   (b) a complete, well-formed answer passes through byte-identical (nothing
//       is withheld once every construct is terminated).
// Inputs that END in genuine ambiguity (an unclosed fence, a lone `**`, a
// final line that still looks like a nascent table header) stay withheld even
// when "complete" — the model cannot know the stream is over, so it errs on
// never flashing raw markup. Engine-generated answers terminate their
// constructs, so (b) holds for them.
//
// Pure and DOM-free so it's unit-tested in node (test/streamingMarkdown.test.mjs).

/** A fence delimiter line, decomposed. CommonMark closes a fence only with the
 *  SAME marker char as the opener, a run at least as long, and nothing after
 *  the run but whitespace (`bare`) — so a ``` fence body can contain ~~~ lines
 *  (and info-stringed ```js lines) without closing (§22.5: mixed-marker fences
 *  used to mis-toggle here). */
function parseFenceLine(line: string): { ch: string; len: number; bare: boolean } | null {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  return { ch: m[1][0], len: m[1].length, bare: m[2].trim().length === 0 };
}

/** True when fence line `f` closes a fence opened by `open`. */
function closesFence(
  open: { ch: string; len: number },
  f: { ch: string; len: number; bare: boolean },
): boolean {
  return f.ch === open.ch && f.len >= open.len && f.bare;
}

/** The largest prefix of `text` that renders as markdown with no trailing raw
 *  syntax. Whitespace-trimmed at the cut. */
export function safeMarkdownPrefix(text: string): string {
  if (!text) return "";
  let out = text;

  // 1) Withhold an unterminated fenced code block: everything from the last
  //    UNCLOSED fence opener onward is held back, so a bare "```sql" line
  //    (or a chart fence mid-open) never shows as raw text. Marker-aware: a
  //    ```-opened fence is only closed by a bare ``` run at least as long —
  //    never by a ~~~ line in its body (and vice versa).
  const lines = out.split("\n");
  let openFence: { ch: string; len: number } | null = null;
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const f = parseFenceLine(lines[i]);
    if (!f) continue;
    if (!openFence) {
      openFence = f;
      openIdx = i;
    } else if (closesFence(openFence, f)) {
      openFence = null;
      openIdx = -1;
    }
  }
  if (openFence && openIdx >= 0) {
    out = lines.slice(0, openIdx).join("\n");
  }
  out = out.replace(/[ \t]+$/g, "");
  if (!out) return "";

  // 2) Isolate the trailing in-progress block (after the last blank line) and
  //    sanitize just that — earlier blocks are already complete.
  let sepEnd = -1;
  const re = /\n[ \t]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) sepEnd = re.lastIndex;
  const head = sepEnd >= 0 ? out.slice(0, sepEnd) : "";
  const trailing = sepEnd >= 0 ? out.slice(sepEnd) : out;

  return head + sanitizeTrailingBlock(trailing);
}

/** A line that could be a GFM table row: it leads with a pipe, or carries at
 *  least two UNESCAPED pipes. Everyday prose with a single `x | y` pipe — or
 *  escaped `\|` pipes — must keep streaming, never be withheld as a nascent
 *  table (§22.5: the old "anything containing a pipe" test withheld it). */
function isTableRowish(line: string): boolean {
  if (/^\s*\|/.test(line)) return true;
  return (line.match(/(?<!\\)\|/g) || []).length >= 2;
}

/** A completed `|---|` delimiter row. */
function isDelimiterRow(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
}

/** A line that is still a plausible PREFIX of a delimiter row being typed
 *  (`|`, `| --`, `| :--- | :`, or nothing yet) — delimiter characters only. */
function isPartialDelimiter(line: string): boolean {
  return /^[\s:|-]*$/.test(line);
}

/** A line that STARTS a new top-level construct (ATX heading — possibly still
 *  mid-type, list item marker, fence delimiter). After a table's delimiter row
 *  such a line can never be a row: it ends the table (§22.5: it used to be
 *  withheld — and dropped — as a "half-typed row"). */
function startsNewBlockConstruct(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}(\s|$)/.test(line) ||
    /^\s*(?:[-*+]|\d{1,9}[.)])(\s|$)/.test(line) ||
    parseFenceLine(line) !== null
  );
}

/** Hold back an incomplete table or an unterminated inline run in the final
 *  block. Only ever truncates (or splits and recurses on) `block` — the result
 *  is always a literal prefix of it. */
function sanitizeTrailingBlock(block: string): string {
  // A trailing CLOSED code fence (open ones were already withheld above) is
  // complete — never inline-trim it, or the closing ``` reads as an odd
  // backtick run and gets clipped.
  if (/^\s*(`{3,}|~{3,})/.test(block)) return block;
  const lines = block.split("\n");

  // An ESTABLISHED table: a row-ish line whose `|---|` delimiter has arrived.
  const firstTable = lines.findIndex(isTableRowish);
  if (firstTable >= 0) {
    const tableLines = lines.slice(firstTable);
    const delimIdx = tableLines.findIndex(isDelimiterRow);
    if (delimIdx >= 0) {
      // The delimiter row itself may still be mid-type ("| --- | --"): while
      // it is the last line and not yet pipe-closed, the table is still
      // nascent — releasing the header alone would render literal pipes.
      // (Engine tables always close rows with a pipe; a complete edgeless
      // "--- | ---" delimiter as the final line stays withheld — unavoidable
      // without seeing the future.)
      if (delimIdx === tableLines.length - 1 && !/\|\s*$/.test(tableLines[delimIdx])) {
        return trimUnbalancedInline(
          lines.slice(0, firstTable + Math.max(delimIdx - 1, 0)).join("\n"),
        );
      }
      // §22.5: a heading/list/fence glued right under the table (no blank
      // line) is NOT a half-typed row — it ends the table and streams as its
      // own trailing construct. (Glued PROSE after a table is still withheld
      // as a possible row-in-progress; that ambiguity is unresolvable until
      // a blank line or a construct marker arrives.)
      for (let i = delimIdx + 1; i < tableLines.length; i++) {
        if (!isTableRowish(tableLines[i]) && startsNewBlockConstruct(tableLines[i])) {
          const table = [...lines.slice(0, firstTable), ...tableLines.slice(0, i)];
          return table.join("\n") + "\n" + sanitizeTrailingBlock(tableLines.slice(i).join("\n"));
        }
      }
      // Delimiter present → keep complete rows, drop a trailing half-typed row
      // (one that doesn't yet close with a pipe).
      let end = tableLines.length;
      if (end > 0 && !/\|\s*$/.test(tableLines[end - 1])) end -= 1;
      return [...lines.slice(0, firstTable), ...tableLines.slice(0, end)].join("\n");
    }
  }

  // A NASCENT table: no delimiter yet, so only the trailing line(s) can still
  // become one. Withhold the last line while it looks like a header (its
  // delimiter may arrive next), plus the line above when the last line is a
  // delimiter row in progress. Everything earlier that carries pipes can no
  // longer grow a delimiter under it — it is prose and streams (remark renders
  // it literally, exactly as the settled answer will).
  const last = lines.length - 1;
  if (isPartialDelimiter(lines[last]) && last >= 1 && isTableRowish(lines[last - 1])) {
    return trimUnbalancedInline(lines.slice(0, last - 1).join("\n"));
  }
  if (isTableRowish(lines[last])) {
    return trimUnbalancedInline(lines.slice(0, last).join("\n"));
  }
  return trimUnbalancedInline(block);
}

/** Trim a trailing unterminated inline construct from the block's last line.
 *  Conservative and last-line-local: only the trailing unterminated run is
 *  withheld, and a line whose inline runs all balance passes through
 *  byte-identical — so a complete answer is never altered. */
function trimUnbalancedInline(block: string): string {
  const nl = block.lastIndexOf("\n");
  const head = nl >= 0 ? block.slice(0, nl + 1) : "";
  let line = nl >= 0 ? block.slice(nl + 1) : block;

  // A fence-marker line here is always the CLOSER of a complete fence (open
  // fences never survive step 1 of safeMarkdownPrefix) — trimming it would
  // tear the fence open again.
  if (parseFenceLine(line)) return block;

  // Cutting one unterminated run can strand an opener a previous check already
  // accepted (e.g. cutting the `**` out of "`a ** b`" leaves an odd backtick),
  // so re-run the checks until the line is stable. Each pass only shortens the
  // line, so this terminates; a balanced line exits the first pass untouched.
  let prev;
  do {
    prev = line;
    // Inline code binds tightest: an odd number of backticks means one is open.
    if ((line.match(/`/g) || []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf("`"));
    }
    // Strong emphasis: an odd number of `**` (or `__`) means one is open.
    if ((line.match(/\*\*/g) || []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf("**"));
    }
    if ((line.match(/__/g) || []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf("__"));
    }
    // Strikethrough: an odd number of `~~` means one is open.
    if ((line.match(/~~/g) || []).length % 2 === 1) {
      line = line.slice(0, line.lastIndexOf("~~"));
    }
    // Link or image being typed: `[text` with no `]`, or `](dest` with no `)`.
    const open = line.lastIndexOf("[");
    if (open >= 0) {
      const rest = line.slice(open);
      const complete = /\]\([^)]*\)/.test(rest) || /\]\[[^\]]*\]/.test(rest) || /\]/.test(rest);
      if (!complete || /\]\([^)]*$/.test(line)) {
        // An image's `!` belongs to the withheld run too — don't strand it.
        line = line.slice(0, open > 0 && line[open - 1] === "!" ? open - 1 : open);
      }
    }
  } while (line !== prev);
  // A just-opened emphasis/strike at the very end (`word *` / `word _` /
  // `word ~`): a single marker sitting against whitespace. A balanced closer
  // sits against its word (or another marker), so this never strips one.
  line = line.replace(/(^|\s)[*_~]$/, "$1");

  return head + line;
}

/** A list-item marker line (`- x`, `* x`, `+ x`, `1. x`, `2) x`) at any indent. */
function isListItemLine(line: string): boolean {
  return /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line);
}

/** Split settled markdown into top-level blocks, keeping fenced code blocks
 *  whole so each block parses independently. Blank lines separate blocks —
 *  EXCEPT inside a loose list (§22.5): parsed apart, ordered items would
 *  restart at 1 and nested items would lose their parent, so when the current
 *  block contains a list item and the next non-blank line is another list item
 *  or an indented continuation, the blank line is kept verbatim and the block
 *  continues (the block stays a contiguous slice of the input, so it renders
 *  exactly as the whole document would). Subtler shapes (lazy continuations
 *  under a loose item) still split — this is a block splitter, not a parser. */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let curHasList = false;
  // Marker-aware fence state (same rules as safeMarkdownPrefix): a ~~~ line in
  // a ``` fence body is content, not a toggle.
  let openFence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = parseFenceLine(line);
    if (f) {
      if (!openFence) openFence = f;
      else if (closesFence(openFence, f)) openFence = null;
    }
    if (!openFence && !f && /^[ \t]*$/.test(line)) {
      if (!cur.length) continue; // leading blank run — nothing to flush
      const j = nextNonBlank(lines, i + 1);
      if (j >= 0 && curHasList && (isListItemLine(lines[j]) || /^(?: {2,}|\t)\S/.test(lines[j]))) {
        cur.push(line); // loose list continues — keep the blank line in-block
        continue;
      }
      blocks.push(cur.join("\n"));
      cur = [];
      curHasList = false;
    } else {
      // Fence body lines don't count as list items (a "- x" line inside a code
      // block is code); delimiter lines themselves can never match anyway.
      const inFenceBody = openFence !== null && f === null;
      if (!inFenceBody && isListItemLine(line)) curHasList = true;
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

/** Index of the next non-blank line at or after `from`, or -1. */
function nextNonBlank(lines: string[], from: number): number {
  for (let j = from; j < lines.length; j++) {
    if (!/^[ \t]*$/.test(lines[j])) return j;
  }
  return -1;
}
