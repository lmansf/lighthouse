// Progressive streaming markdown (usability patch §2) — src/lib/streamingMarkdown.ts.
// The load-bearing guarantee: at NO prefix of a streaming answer does raw markup
// or a torn table render. We prove it by walking every prefix of a realistic
// fixture (headings, bold, a table, a chart fence, inline code) and asserting the
// safe prefix never ends mid-construct — and that once the answer is complete,
// nothing is withheld (so the final render is byte-identical to today).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { safeMarkdownPrefix, splitMarkdownBlocks } = await import("../src/lib/streamingMarkdown.ts");

const FIXTURE = [
  "## Revenue summary",
  "",
  "Revenue was **up 12%** this quarter, led by the Northeast.",
  "",
  "| Region | Total |",
  "| --- | --- |",
  "| Northeast | 4120 |",
  "| West | 3980 |",
  "",
  "```lighthouse-chart",
  '{"kind":"bar","x":["NE","W"],"series":[{"name":"Total","values":[4120,3980]}]}',
  "```",
  "",
  "See `sales.csv` for the source data.",
].join("\n");

function lastLine(s) {
  const parts = s.split("\n");
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim()) return parts[i];
  return "";
}
function even(s, pat) {
  return ((s.match(pat) || []).length) % 2 === 0;
}

test("no raw markup or torn table renders at ANY streaming prefix", () => {
  for (let i = 1; i <= FIXTURE.length; i++) {
    const sp = safeMarkdownPrefix(FIXTURE.slice(0, i));
    // The safe prefix is always a prefix of the input (we only ever truncate).
    assert.ok(FIXTURE.slice(0, i).startsWith(sp), `not a prefix at i=${i}:\n${sp}`);
    // No unterminated code fence.
    assert.ok(even(sp, /^[ \t]*(```|~~~)/gm), `open fence at i=${i}:\n${sp}`);
    const ll = lastLine(sp);
    // A fence delimiter (```) legitimately carries three backticks — the inline
    // balance checks are for prose lines only.
    const isFenceLine = /^\s*(```|~~~)/.test(ll);
    // No unterminated bold or inline code on the last visible prose line.
    if (!isFenceLine) {
      assert.ok(even(ll, /\*\*/g), `open bold at i=${i}: ${JSON.stringify(ll)}`);
      assert.ok(even(ll, /`/g), `open code at i=${i}: ${JSON.stringify(ll)}`);
    }
    // No half-typed table row: a line that begins a row also closes it.
    if (/^\s*\|/.test(ll)) {
      assert.ok(/\|\s*$/.test(ll), `torn table row at i=${i}: ${JSON.stringify(ll)}`);
    }
    // No link left open.
    assert.ok(!/\[[^\]]*$/.test(ll), `open link at i=${i}: ${JSON.stringify(ll)}`);
  }
});

test("a complete answer is passed through untouched (final is byte-identical)", () => {
  assert.equal(safeMarkdownPrefix(FIXTURE), FIXTURE);
});

test("an unterminated code fence is withheld until it closes", () => {
  const open = "Here is the query:\n\n```sql\nSELECT * FROM sale";
  const sp = safeMarkdownPrefix(open);
  assert.ok(!sp.includes("```"), `fence leaked:\n${sp}`);
  assert.ok(sp.startsWith("Here is the query:"));
  // Once it closes, it comes through.
  const closed = open + "s\n```";
  assert.ok(safeMarkdownPrefix(closed).includes("```sql"));
});

test("a header row with no delimiter yet is withheld", () => {
  const sp = safeMarkdownPrefix("Totals:\n\n| Region | Total |");
  assert.ok(!sp.includes("| Region"), `nascent table leaked:\n${sp}`);
  assert.ok(sp.startsWith("Totals:"));
});

test("a half-typed table row is dropped but complete rows stay", () => {
  const t = "| R | T |\n| --- | --- |\n| NE | 4120 |\n| West | 39";
  const sp = safeMarkdownPrefix(t);
  assert.ok(sp.includes("| NE | 4120 |"), `complete row lost:\n${sp}`);
  assert.ok(!sp.includes("| West | 39"), `partial row kept:\n${sp}`);
});

test("splitMarkdownBlocks keeps fenced code whole and splits on blank lines", () => {
  const blocks = splitMarkdownBlocks(FIXTURE);
  assert.equal(blocks[0], "## Revenue summary");
  // The chart fence is one block, delimiters included.
  const fence = blocks.find((b) => b.startsWith("```lighthouse-chart"));
  assert.ok(fence && fence.endsWith("```"), `fence not whole: ${fence}`);
  // The table is one block with all four lines.
  const table = blocks.find((b) => b.startsWith("| Region"));
  assert.equal(table.split("\n").length, 4);
});

test("ChatPanel renders the streaming turn progressively (block-memoized)", () => {
  const src = readFileSync(path.join(ROOT, "src/features/chat/ChatPanel.tsx"), "utf8");
  assert.match(src, /import \{ safeMarkdownPrefix, splitMarkdownBlocks \} from "@\/lib\/streamingMarkdown"/);
  // The live turn splits the SAFE prefix into blocks, each a memoized StreamBlock.
  assert.match(src, /splitMarkdownBlocks\(safeMarkdownPrefix\(clean\)\)/);
  assert.match(src, /const StreamBlock = memo\(/);
  assert.match(src, /<StreamBlock key=\{i\} content=\{b\} turnId=\{turnId\} onCite=\{onCite\}/);
  // The streaming branch drives StreamingAnswer with the citation handler.
  assert.match(src, /<StreamingAnswer\s+content=\{m\.content\}\s+turnId=\{m\.id\}\s+onCite=\{handleCitationClick\}/);
});

// --- Inline HTML holdback (html-in-answers): MarkdownView renders sanitized
// inline HTML now, so a tag still being typed must be withheld like any other
// unterminated construct — and prose that merely contains `<` must not be.
test("a half-typed HTML tag is withheld until its > arrives", () => {
  // The space before the withheld `<` stays — same convention as the other
  // inline holdbacks (only the unterminated run itself is withheld).
  assert.equal(safeMarkdownPrefix("The key figure is <ma"), "The key figure is ");
  assert.equal(safeMarkdownPrefix("Fold this: <details><summ"), "Fold this: <details>");
  assert.equal(safeMarkdownPrefix("End of run.</su"), "End of run.");
  assert.equal(
    safeMarkdownPrefix('cell one<br'),
    "cell one",
    "attribute-less closing-tag-in-progress is withheld",
  );
  assert.equal(
    safeMarkdownPrefix('<td colspan="2'),
    "",
    "a tag mid-attribute is withheld from its < on",
  );
});

test("a complete HTML tag streams through untouched", () => {
  const done = "3<sup>2</sup> and a break<br>here, <mark>$4.2M</mark>.";
  assert.equal(safeMarkdownPrefix(done), done);
});

test("prose comparisons with < are not mistaken for tags", () => {
  const prose = "Margins stayed 3 < 5 while 7 <= 9 held.";
  assert.equal(safeMarkdownPrefix(prose), prose);
});

test("the prefix property holds while an HTML-flavored answer streams", () => {
  const fixture = [
    "The result is 4.2M<sup>*</sup> this quarter.",
    "",
    "<details><summary>Appendix</summary>",
    "Detail line with <mark>the key figure</mark> inside.",
    "</details>",
  ].join("\n");
  for (let i = 0; i <= fixture.length; i++) {
    const whole = fixture.slice(0, i);
    const safe = safeMarkdownPrefix(whole);
    assert.ok(whole.startsWith(safe), `not a literal prefix at cut ${i}`);
    const tail = safe.split("\n").pop() ?? "";
    const lt = tail.lastIndexOf("<");
    if (lt >= 0) {
      assert.ok(
        !/^<\/?[a-zA-Z][^>]*$/.test(tail.slice(lt)),
        `prefix at cut ${i} ends in a half-typed tag: ${JSON.stringify(tail)}`,
      );
    }
  }
  assert.equal(safeMarkdownPrefix(fixture), fixture, "complete HTML answer must pass untouched");
});

// --- Mutation-hardening pins: boundary behavior the invariant walks above can't
// see (over-withholding is always "safe", so only exact-output assertions catch
// a guard drifting by one). Each test pins CURRENT behavior at a boundary.

test("an indented fence opener still closes on a flush closer (marker char and run length come from the run, not the raw line)", () => {
  // The opener's leading whitespace and info string must not leak into the
  // fence identity: ch is the run's first char, len the run's length.
  const fenced = "  ```js\ncode here\n```\ntail prose.";
  assert.equal(safeMarkdownPrefix(fenced), fenced);
});

test("prose glued under a complete table is withheld as a possible row; the rows themselves stream whole", () => {
  const rows = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  // A complete table ending in a pipe-closed row passes through byte-identical
  // (established-table branch: nothing dropped when the last row is closed).
  assert.equal(safeMarkdownPrefix(rows), rows);
  // Glued PROSE after the rows is ambiguous (a row-in-progress) — withheld;
  // only a construct marker (heading/list/fence) ends the table early.
  assert.equal(safeMarkdownPrefix(rows + "\nGlued prose here"), rows);
  // Prose glued ABOVE the table stays: only table lines are table-managed.
  const intro = "Intro:\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(safeMarkdownPrefix(intro), intro);
  const introGlued = "Intro:\n| A | B |\n| --- | --- |\n## Done";
  assert.equal(safeMarkdownPrefix(introGlued), introGlued);
});

test("a table whose FIRST row-ish line is the delimiter row still streams (delimIdx === 0 boundary)", () => {
  const headerless = "| --- | --- |\n| 1 | 2 |";
  assert.equal(safeMarkdownPrefix(headerless), headerless);
  // A delimiter-shaped list marker between rows is row-scanned from the line
  // AFTER the delimiter — the whole table passes through untouched.
  const listDelim = ["| A | B |", "- ", "| 1 | 2 |"].join("\n");
  assert.equal(safeMarkdownPrefix(listDelim), listDelim);
});

test("delimiter-row boundaries: complete releases the header, mid-type withholds back to the right line", () => {
  // A pipe-closed delimiter as the final line completes the header pair.
  const headerPair = "| A | B |\n| --- | --- |";
  assert.equal(safeMarkdownPrefix(headerPair), headerPair);
  // Mid-type delimiter: withhold header AND delimiter, keep what's above.
  assert.equal(
    safeMarkdownPrefix("Totals here:\n| Region | Total |\n| --- | --"),
    "Totals here:",
  );
  // Two row-ish lines above a mid-type delimiter: only the line directly
  // above the delimiter is treated as its header — earlier rows stream.
  assert.equal(safeMarkdownPrefix("| A | B |\n| C | D |\n| --- | --"), "| A | B |");
});

test("a just-started delimiter line (no dash yet) withholds the header line above it", () => {
  // The nascent-table path: a bare `|` or `:` as the last line is a plausible
  // delimiter prefix, so the header directly above is withheld with it.
  assert.equal(safeMarkdownPrefix("| A | B |\n|"), "");
  assert.equal(safeMarkdownPrefix("| A | B |\n:"), "");
  // Lines above the withheld header stay.
  assert.equal(safeMarkdownPrefix("Intro:\n| A | B |\n|"), "Intro:");
  // A lone nascent header (no delimiter started) is withheld the same way.
  assert.equal(safeMarkdownPrefix("Intro:\n| A | B |"), "Intro:");
});

test("a third inline opener on one line is trimmed (odd counts beyond one)", () => {
  // The inline balance checks are parity checks (% 2), not one-shot flags:
  // two closed runs plus a third opener must still trim at the third.
  assert.equal(safeMarkdownPrefix("see `a` then `b"), "see `a` then ");
  assert.equal(safeMarkdownPrefix("**a** and **b"), "**a** and ");
  assert.equal(safeMarkdownPrefix("__a__ and __b"), "__a__ and ");
  assert.equal(safeMarkdownPrefix("~~a~~ and ~~b"), "~~a~~ and ");
});

test("link/image holdback boundaries: line-leading brackets and the char before [", () => {
  // An open link at column 0 is withheld entirely (the >= 0 boundary).
  assert.equal(safeMarkdownPrefix("[link te"), "");
  // An image's `!` at column 0 goes with it — nothing strands.
  assert.equal(safeMarkdownPrefix("![alt te"), "");
  // A plain link keeps the character before `[` (only images eat one back).
  assert.equal(safeMarkdownPrefix("Read [the do"), "Read ");
  // A closed bracket pair with no destination is complete prose — untouched.
  assert.equal(safeMarkdownPrefix("a [tag] done"), "a [tag] done");
});

test("a double blank line passes through byte-identical (trailing block starting with a newline)", () => {
  // After "\n\n\n" the trailing block begins with "\n" — the last-line split
  // in trimUnbalancedInline must keep that newline in the head.
  assert.equal(safeMarkdownPrefix("alpha\n\n\nbeta"), "alpha\n\n\nbeta");
});

test("splitMarkdownBlocks: fence-aware blanks and list detection at the edges", () => {
  // A blank line INSIDE a fence body never splits the fence.
  const gapFence = "```js\nconst a = 1;\n\nconst b = 2;\n```";
  assert.deepEqual(splitMarkdownBlocks(gapFence), [gapFence]);
  // A list followed by non-list prose splits at the blank line (the lookahead
  // checks the NEXT non-blank line, not the previous one).
  assert.deepEqual(splitMarkdownBlocks("- item one\n- item two\n\nClosing prose."), [
    "- item one\n- item two",
    "Closing prose.",
  ]);
  // A "- x" line inside a fence body is code, not a list item: the blank after
  // the closed fence still splits before a following top-level list.
  assert.deepEqual(splitMarkdownBlocks("```\n- a\n```\n\n- outside"), [
    "```\n- a\n```",
    "- outside",
  ]);
  // Trailing blank lines flush the last block instead of being kept in it.
  assert.deepEqual(splitMarkdownBlocks("- a\n- b\n\n"), ["- a\n- b"]);
});
