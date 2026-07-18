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
