/**
 * §35 §3: the stat-run detector. A <ul> whose EVERY item is `**Label:** value`
 * (three or more of them, plain text both sides) renders as a two-column
 * key-value grid; anything else stays ordinary bullets. The detector is pure
 * and reads the rendered hast, so these fixtures run REAL markdown through
 * the same remark→rehype pipeline react-markdown uses and assert on the
 * decision — matching AND non-matching shapes, per the spec's "fallback on
 * any doubt" rule. The ChatPanel wiring is source-pinned (chartIt style).
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { detectStatRun } = await import("../src/lib/statRun.ts");

/** First <ul>/<ol> element of the markdown, as react-markdown-shaped hast. */
function listNode(md) {
  const hast = unified().use(remarkParse).use(remarkRehype).runSync(
    unified().use(remarkParse).parse(md),
  );
  const found = hast.children.find(
    (n) => n.tagName === "ul" || n.tagName === "ol",
  );
  assert.ok(found, "fixture markdown produced a list");
  return found;
}

// --- Matching shapes ---------------------------------------------------------

test("a plain three-item run detects, with colons stripped from labels", () => {
  const run = detectStatRun(
    listNode("- **Revenue:** $4.2M\n- **Margin:** 38%\n- **Headcount:** 214\n"),
  );
  assert.deepEqual(run, [
    { label: "Revenue", value: "$4.2M" },
    { label: "Margin", value: "38%" },
    { label: "Headcount", value: "214" },
  ]);
});

test("the colon-outside-the-bold spelling detects identically", () => {
  const run = detectStatRun(
    listNode("- **Revenue**: $4.2M\n- **Margin**: 38%\n- **Headcount**: 214\n"),
  );
  assert.deepEqual(
    run.map((r) => r.label),
    ["Revenue", "Margin", "Headcount"],
  );
  assert.equal(run[0].value, "$4.2M");
});

test("a loose list (blank lines between items) detects like the tight one", () => {
  const run = detectStatRun(
    listNode("- **Total:** 91\n\n- **Open:** 14\n\n- **Closed:** 77\n"),
  );
  assert.equal(run.length, 3);
  assert.deepEqual(run[1], { label: "Open", value: "14" });
});

test("labels and values keep interior punctuation and unicode", () => {
  const run = detectStatRun(
    listNode(
      "- **Q3 revenue (EMEA):** €1.2M — up 8%\n- **Q3 revenue (US):** $2.9M\n- **FX impact:** −$120k\n",
    ),
  );
  assert.equal(run[0].label, "Q3 revenue (EMEA)");
  assert.equal(run[0].value, "€1.2M — up 8%");
});

// --- Non-matching shapes (every one stays bullets) ---------------------------

test("fewer than three items stays bullets — one and two alike", () => {
  assert.equal(detectStatRun(listNode("- **Total:** 91\n")), null);
  assert.equal(detectStatRun(listNode("- **Total:** 91\n- **Open:** 14\n")), null);
});

test("a mixed list (one plain item among stats) stays bullets", () => {
  assert.equal(
    detectStatRun(
      listNode("- **Revenue:** $4.2M\n- **Margin:** 38%\n- and one narrative point\n"),
    ),
    null,
  );
});

test("a link inside a label is doubt — bullets", () => {
  assert.equal(
    detectStatRun(
      listNode(
        "- **[Revenue](https://example.com):** $4.2M\n- **Margin:** 38%\n- **Headcount:** 214\n",
      ),
    ),
    null,
  );
});

test("a link (or citation) in a value is doubt — bullets, so the link survives", () => {
  assert.equal(
    detectStatRun(
      listNode(
        "- **Revenue:** $4.2M [source](https://example.com)\n- **Margin:** 38%\n- **Headcount:** 214\n",
      ),
    ),
    null,
  );
});

test("an item with no colon, or an empty value, is doubt — bullets", () => {
  assert.equal(
    detectStatRun(listNode("- **Revenue** $4.2M\n- **Margin:** 38%\n- **Headcount:** 214\n")),
    null,
  );
  assert.equal(
    detectStatRun(listNode("- **Revenue:**\n- **Margin:** 38%\n- **Headcount:** 214\n")),
    null,
  );
});

test("a nested list inside an item is doubt — bullets", () => {
  assert.equal(
    detectStatRun(
      listNode(
        "- **Revenue:** $4.2M\n  - **Q1:** $1M\n- **Margin:** 38%\n- **Headcount:** 214\n",
      ),
    ),
    null,
  );
});

test("an ordered list never detects (the override only ever sees <ul>)", () => {
  assert.equal(
    detectStatRun(listNode("1. **Revenue:** $4.2M\n2. **Margin:** 38%\n3. **Headcount:** 214\n")),
    null,
  );
});

// --- Renderer wiring (source pins — the JSX can't load in node) --------------

test("ChatPanel's ul override consults the detector and falls back to a real <ul>", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /ul: \(\{ node, children, \.\.\.props \}\) => \{\s*\n\s*const run = detectStatRun\(node\);/);
  assert.match(chat, /return <ul \{\.\.\.props\}>\{children\}<\/ul>;/, "doubt renders the ordinary list");
  assert.match(chat, /<dl className=\{styles\.statRun\}>/, "a detected run renders the semantic <dl> grid");
  assert.match(chat, /<dt key=\{`label-\$\{i\}`\} className=\{styles\.statRunLabel\}>/);
  assert.match(chat, /<dd key=\{`value-\$\{i\}`\} className=\{styles\.statRunValue\}>/);
});

test("the grid is two-column with semibold token-sized labels and hairline separators", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(chat, /statRun: \{\s*\n\s*display: "grid",\s*\n\s*gridTemplateColumns: "minmax\(96px, max-content\) 1fr",/);
  const label = chat.slice(chat.indexOf("statRunLabel: {"), chat.indexOf("statRunValue: {"));
  assert.match(label, /fontWeight: tokens\.fontWeightSemibold,/);
  assert.match(label, /fontSize: CONTENT_TYPE\.statLabel,/);
  assert.match(label, /borderBottomColor: tokens\.colorNeutralStroke2,/, "hairline is the token stroke");
  assert.match(label, /"&:last-of-type": \{ borderBottomStyle: "none" \}/, "no rule after the last row");
  assert.match(read("src/shell/theme.ts"), /statLabel: rem\(14\.5\),/, "the 14-15px label size is a content token");
});
