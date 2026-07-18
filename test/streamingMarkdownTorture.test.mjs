// Markdown torture suite (§22.5) — src/lib/streamingMarkdown.ts.
// A CI floor for the progressive renderer: one fixture per torture class
// (ragged tables, escaped/bare pipes, loose lists, inline runs spanning chunk
// boundaries, constructs glued after tables, mixed fence markers, fence bodies
// with fence-looking lines, mixed indentation). For EVERY fixture we walk
// EVERY prefix and assert the two load-bearing invariants:
//   (a) the safe prefix is a literal prefix of the input with no construct
//       left open (no raw-markup flash, no torn table);
//   (b) the complete input passes through byte-identical (nothing is withheld
//       once every construct is terminated).
// Fixtures are complete, well-formed markdown: rows close with a pipe, fences
// close with a matching marker, inline runs balance — the shapes the engines
// emit, and the precondition under which (b) is provable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { safeMarkdownPrefix, splitMarkdownBlocks } = await import("../src/lib/streamingMarkdown.ts");

// --- Helpers (independent oracles — deliberately NOT imported from the impl) --

function lastLine(s) {
  const parts = s.split("\n");
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim()) return parts[i];
  return "";
}
function even(s, pat) {
  return ((s.match(pat) || []).length) % 2 === 0;
}

/** Marker-aware fence oracle mirroring CommonMark's close rule (same marker
 *  char, a run at least as long, nothing after it but whitespace). Returns
 *  the line index of a still-open fence opener, or -1 when all fences close. */
function openFenceAt(text) {
  let open = null;
  let idx = -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const f = { ch: m[1][0], len: m[1].length, bare: m[2].trim() === "" };
    if (!open) {
      open = f;
      idx = i;
    } else if (f.ch === open.ch && f.len >= open.len && f.bare) {
      open = null;
      idx = -1;
    }
  }
  return open ? idx : -1;
}

/** Walk every prefix of `fixture`, asserting the safe prefix is a true prefix
 *  with no open construct (the streamingMarkdown.test.mjs property, extended
 *  with __ / ~~ / image checks and the marker-aware fence oracle). */
function assertEveryPrefixSafe(fixture, name) {
  for (let i = 1; i <= fixture.length; i++) {
    const input = fixture.slice(0, i);
    const sp = safeMarkdownPrefix(input);
    // (a) Only ever truncated, never rewritten.
    assert.ok(input.startsWith(sp), `${name}: not a prefix at i=${i}:\n${sp}`);
    // No unterminated code fence (marker-aware: ~~~ in a ``` body is content).
    assert.equal(openFenceAt(sp), -1, `${name}: open fence at i=${i}:\n${sp}`);
    const ll = lastLine(sp);
    // A fence delimiter line legitimately carries its marker run — the inline
    // balance checks are for prose lines only.
    const isFenceLine = /^\s*(`{3,}|~{3,})/.test(ll);
    if (!isFenceLine) {
      assert.ok(even(ll, /`/g), `${name}: open code at i=${i}: ${JSON.stringify(ll)}`);
      assert.ok(even(ll, /\*\*/g), `${name}: open ** bold at i=${i}: ${JSON.stringify(ll)}`);
      assert.ok(even(ll, /__/g), `${name}: open __ bold at i=${i}: ${JSON.stringify(ll)}`);
      assert.ok(even(ll, /~~/g), `${name}: open strikethrough at i=${i}: ${JSON.stringify(ll)}`);
      // No link or image left open (an unclosed `[` also covers `![`).
      assert.ok(!/\[[^\]]*$/.test(ll), `${name}: open link/image at i=${i}: ${JSON.stringify(ll)}`);
      assert.ok(!/\]\([^)]*$/.test(ll), `${name}: open link dest at i=${i}: ${JSON.stringify(ll)}`);
    }
    // No half-typed table row: a line that begins a row also closes it.
    if (/^\s*\|/.test(ll)) {
      assert.ok(/\|\s*$/.test(ll), `${name}: torn table row at i=${i}: ${JSON.stringify(ll)}`);
    }
  }
}

// --- Torture fixtures (one per class) ----------------------------------------

const RAGGED_TABLE = [
  "Regional totals, raggedly:",
  "",
  "| Region | Q1 | Q2 |",
  "| --- | --- | --- |",
  "| Northeast | 4120 |",
  "| West | 3980 | 4200 | 4400 |",
  "| South |",
  "",
  "Done.",
].join("\n");

const ESCAPED_PIPES = [
  "Escaped pipes stay inside their cells:",
  "",
  "| Flag | Meaning |",
  "| --- | --- |",
  "| a\\|b | pipe stays put |",
  "| c\\|d | see a\\|b above |",
  "",
  "Write it as a\\|b in prose.",
].join("\n");

const BARE_PIPE_PROSE = [
  "Pick A | B when unsure.",
  "",
  "The modes x | y | z all apply, and",
  "the fallback stays on.",
  "",
  "End of note.",
].join("\n");

const LOOSE_NESTED_LIST = [
  "Steps:",
  "",
  "1. First step",
  "",
  "   with a continuation paragraph",
  "",
  "2. Second step",
  "",
  "   - nested item",
  "",
  "   - second nested item",
  "",
  "3. Third step",
].join("\n");

const INLINE_RUNS = [
  "Inline stress:",
  "",
  "This is **bold** and __also bold__ and ~~struck~~ text with `code`.",
  "See [the docs](https://example.com) and ![a chart](chart.png) inline.",
  "Emphasis *lightly* and _softly_ closes cleanly.",
].join("\n");

const GLUED_AFTER_TABLE = [
  "Quarter recap:",
  "",
  "| Region | Total |",
  "| --- | --- |",
  "| NE | 4120 |",
  "| West | 3980 |",
  "## Summary",
  "Strong quarter overall.",
  "",
  "| Metric | Value |",
  "| --- | --- |",
  "| Growth | 12% |",
  "- verified against sales.csv",
].join("\n");

const MIXED_FENCE_MARKERS = [
  "Two fences, each holding the other marker:",
  "",
  "```text",
  "~~~",
  "literal tildes above",
  "```",
  "",
  "~~~text",
  "```",
  "```js",
  "const b = 2;",
  "~~~",
  "",
  "After both.",
].join("\n");

const FENCE_IN_FENCE = [
  "Nested fence demo:",
  "",
  "````md",
  "```js",
  "const a = 1;",
  "```",
  "````",
  "",
  "```",
  "```sql still inside (an info string never closes)",
  "done",
  "```",
  "",
  "Tail prose.",
].join("\n");

const MIXED_INDENTATION = [
  "Mixed indentation:",
  "",
  "- top item",
  "    - four-space nested",
  "      continuation under nested",
  "- second top",
  "\t- tab-indented nested",
  "  trailing lazy line",
].join("\n");

const TORTURES = [
  ["ragged GFM table (rows with differing cell counts)", RAGGED_TABLE],
  ["escaped pipes in cells and prose", ESCAPED_PIPES],
  ["prose containing bare pipes", BARE_PIPE_PROSE],
  ["nested list with blank lines (loose list)", LOOSE_NESTED_LIST],
  ["bold/links/strikethrough/images spanning chunk boundaries", INLINE_RUNS],
  ["heading and list glued after tables", GLUED_AFTER_TABLE],
  ["fences containing the other fence marker", MIXED_FENCE_MARKERS],
  ["fence bodies containing ```-led lines (length + info-string rules)", FENCE_IN_FENCE],
  ["mixed indentation", MIXED_INDENTATION],
];

// --- The floor: both invariants, for every fixture, at every prefix ----------

for (const [name, fixture] of TORTURES) {
  test(`torture: ${name} — every prefix is safe`, () => {
    assertEveryPrefixSafe(fixture, name);
  });
  test(`torture: ${name} — complete input passes through byte-identical`, () => {
    assert.equal(safeMarkdownPrefix(fixture), fixture);
  });
  test(`torture: ${name} — every block is a verbatim slice of the input`, () => {
    for (const b of splitMarkdownBlocks(fixture)) {
      assert.ok(fixture.includes(b), `${name}: block mangled:\n${b}`);
    }
  });
}

// --- Class-specific teeth ----------------------------------------------------

test("prose with a single bare pipe streams even as the final line", () => {
  const line = "Pick A | B when unsure.";
  assert.equal(safeMarkdownPrefix(line), line);
});

test("two-pipe prose is released once the next line rules out a delimiter row", () => {
  // While it is the last line it could still be a table header, so it is
  // withheld; the moment a non-delimiter line follows, it can never become a
  // table and must stream as prose.
  const held = safeMarkdownPrefix("The modes x | y | z all apply, and");
  assert.equal(held, "", "a possible header may be withheld while last");
  const released = "The modes x | y | z all apply, and\nthe fallback stays on.";
  assert.equal(safeMarkdownPrefix(released), released);
});

test("escaped \\| pipes never look like a table", () => {
  const line = "Write it as a\\|b in prose.";
  assert.equal(safeMarkdownPrefix(line), line);
});

test("a heading glued under a table ends the table instead of being dropped", () => {
  const glued = "| A | B |\n| --- | --- |\n| 1 | 2 |\n## Next section";
  assert.equal(safeMarkdownPrefix(glued), glued);
  // Mid-type, the heading streams as a heading, not a withheld half-row.
  const midType = "| A | B |\n| --- | --- |\n| 1 | 2 |\n## Nex";
  assert.ok(safeMarkdownPrefix(midType).includes("## Nex"), "glued heading withheld");
});

test("a mid-type delimiter row withholds the header too (no bare-pipe header flash)", () => {
  const sp = safeMarkdownPrefix("Totals:\n\n| Region | Total |\n| --- | --");
  assert.ok(!sp.includes("| Region"), `bare header leaked:\n${sp}`);
  assert.ok(sp.startsWith("Totals:"));
});

test("a ``` fence body containing ~~~ does not close (and vice versa)", () => {
  const backtick = "```text\n~~~\nstill code\n```";
  assert.equal(safeMarkdownPrefix(backtick), backtick);
  const tilde = "~~~text\n```\nstill code\n~~~";
  assert.equal(safeMarkdownPrefix(tilde), tilde);
  // While open, the whole fence is withheld — the ~~~ body line must not
  // release it early.
  assert.equal(safeMarkdownPrefix("```text\n~~~\nstill code"), "");
});

test("splitMarkdownBlocks keeps a mixed-marker fence whole", () => {
  const blocks = splitMarkdownBlocks(MIXED_FENCE_MARKERS);
  const backtick = blocks.find((b) => b.startsWith("```text"));
  assert.ok(backtick && backtick.endsWith("```"), `\`\`\` fence not whole: ${backtick}`);
  assert.ok(backtick.includes("\n~~~\n"), "the ~~~ body line fell out of the fence");
  const tilde = blocks.find((b) => b.startsWith("~~~text"));
  assert.ok(tilde && tilde.endsWith("~~~"), `~~~ fence not whole: ${tilde}`);
  assert.ok(tilde.includes("\n```js\n"), "the \`\`\`js body line fell out of the fence");
});

test("a longer opener is only closed by a run at least as long", () => {
  const outer = "````md\n```js\nconst a = 1;\n```\n````";
  assert.equal(safeMarkdownPrefix(outer), outer);
  // The inner ``` lines must not close the ```` fence.
  assert.equal(safeMarkdownPrefix("````md\n```js\nconst a = 1;\n```"), "");
});

test("splitMarkdownBlocks keeps a loose nested list in one block", () => {
  const blocks = splitMarkdownBlocks(LOOSE_NESTED_LIST);
  assert.equal(blocks.length, 2, `expected [intro, list], got:\n${JSON.stringify(blocks)}`);
  assert.equal(blocks[0], "Steps:");
  const list = blocks[1];
  assert.ok(list.startsWith("1. First step"), `list block torn:\n${list}`);
  assert.ok(list.includes("   with a continuation paragraph"), "continuation split off");
  assert.ok(list.includes("   - second nested item"), "nested item split off");
  assert.ok(list.endsWith("3. Third step"), "later sibling split off");
});

test("blank lines between non-list blocks still split (splitter stays a splitter)", () => {
  const blocks = splitMarkdownBlocks("A paragraph.\n\nAnother paragraph.\n\n- a list");
  assert.deepEqual(blocks, ["A paragraph.", "Another paragraph.", "- a list"]);
});

test("inline runs spanning chunk boundaries are withheld, then land verbatim", () => {
  const line = "This is **bold** and __also bold__ and ~~struck~~ text with `code`.";
  // Torn mid-run at a few representative boundaries: the open run is withheld.
  assert.equal(safeMarkdownPrefix("This is **bo"), "This is ");
  assert.equal(safeMarkdownPrefix("This is **bold** and __al"), "This is **bold** and ");
  assert.equal(
    safeMarkdownPrefix("This is **bold** and __also bold__ and ~~str"),
    "This is **bold** and __also bold__ and ",
  );
  assert.equal(safeMarkdownPrefix(line), line);
  // An image mid-type withholds its `!` along with the bracket run.
  assert.equal(safeMarkdownPrefix("See ![a ch"), "See ");
  assert.equal(safeMarkdownPrefix("See ![a chart](chart.pn"), "See ");
  const img = "See ![a chart](chart.png) inline.";
  assert.equal(safeMarkdownPrefix(img), img);
});
