// Progressive streaming markdown (usability patch §2).
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
// Pure and DOM-free so it's unit-tested in node (test/streamingMarkdown.test.mjs).

/** The largest prefix of `text` that renders as markdown with no trailing raw
 *  syntax. Whitespace-trimmed at the cut. */
export function safeMarkdownPrefix(text: string): string {
  if (!text) return "";
  let out = text;

  // 1) Withhold an unterminated fenced code block: everything from the last
  //    UNCLOSED ``` (or ~~~) fence onward is held back, so a bare "```sql" line
  //    (or a chart fence mid-open) never shows as raw text.
  const lines = out.split("\n");
  let inFence = false;
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      if (inFence) inFence = false;
      else {
        inFence = true;
        openIdx = i;
      }
    }
  }
  if (inFence && openIdx >= 0) {
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

/** Hold back an incomplete table or an unterminated inline run in the final
 *  block. */
function sanitizeTrailingBlock(block: string): string {
  // A trailing CLOSED code fence (open ones were already withheld above) is
  // complete — never inline-trim it, or the closing ``` reads as an odd
  // backtick run and gets clipped.
  if (/^\s*(```|~~~)/.test(block)) return block;
  const lines = block.split("\n");
  // A GFM table row: a line that contains a pipe and isn't obviously prose.
  const firstTable = lines.findIndex((l) => /\|/.test(l) && /^\s*\|?.*\|?\s*$/.test(l) && l.trim().includes("|"));
  if (firstTable >= 0) {
    const tableLines = lines.slice(firstTable);
    const hasDelim = tableLines.some((l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l));
    if (!hasDelim) {
      // Header typed but no `|---|` delimiter yet → not a table; withhold it so
      // no bare pipe row renders. Keep any prose that preceded it.
      return trimUnbalancedInline(lines.slice(0, firstTable).join("\n"));
    }
    // Delimiter present → keep complete rows, drop a trailing half-typed row
    // (one that doesn't yet close with a pipe).
    let end = tableLines.length;
    if (end > 0 && !/\|\s*$/.test(tableLines[end - 1])) end -= 1;
    return [...lines.slice(0, firstTable), ...tableLines.slice(0, end)].join("\n");
  }
  return trimUnbalancedInline(block);
}

/** Trim a trailing unterminated inline construct from the block's last line. */
function trimUnbalancedInline(block: string): string {
  const nl = block.lastIndexOf("\n");
  const head = nl >= 0 ? block.slice(0, nl + 1) : "";
  let line = nl >= 0 ? block.slice(nl + 1) : block;

  // Inline code binds tightest: an odd number of backticks means one is open.
  if (((line.match(/`/g) || []).length) % 2 === 1) {
    line = line.slice(0, line.lastIndexOf("`"));
  }
  // Bold: an odd number of `**` means one is open.
  if (((line.match(/\*\*/g) || []).length) % 2 === 1) {
    line = line.slice(0, line.lastIndexOf("**"));
  }
  // Link being typed: `[text` with no `]`, or `](dest` with no `)`.
  const open = line.lastIndexOf("[");
  if (open >= 0) {
    const rest = line.slice(open);
    const complete = /\]\([^)]*\)/.test(rest) || /\]\[[^\]]*\]/.test(rest) || /\]/.test(rest);
    if (!complete || /\]\([^)]*$/.test(line)) line = line.slice(0, open);
  }
  // A just-opened emphasis at the very end (`word *` / `word _`): a single
  // marker sitting against whitespace. A balanced `**…**` closer sits against
  // its word (or another `*`), so this never strips one.
  line = line.replace(/(^|\s)[*_]$/, "$1");

  return head + line;
}

/** Split settled markdown into top-level blocks, keeping fenced code blocks
 *  whole so each block parses independently. Blank lines separate blocks. */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^[ \t]*$/.test(line)) {
      if (cur.length) {
        blocks.push(cur.join("\n"));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}
