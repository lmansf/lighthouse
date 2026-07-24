/**
 * §35 §4: progressive disclosure. The remark transform folds ONLY what the
 * spec names: an h2/h3-delimited section past ~1,200 chars, keeping its
 * heading + first two blocks and parking the rest in one
 * `lh-collapsed-section` wrapper — never the lead, never a short section,
 * never when disabled (the streaming/desktop default). The transform is pure
 * mdast surgery, so these fixtures parse real markdown with the same
 * remark-parse react-markdown uses and run the plugin directly; the
 * interactive swap in ChatPanel is source-pinned (chartIt style).
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

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { remarkCollapseSections, COLLAPSE_THRESHOLD_CHARS, COLLAPSE_VISIBLE_BLOCKS, COLLAPSED_SECTION_CLASS } =
  await import("../src/lib/collapseSections.ts");

const parse = (md) => unified().use(remarkParse).parse(md);
const run = (md, options) => {
  const tree = parse(md);
  remarkCollapseSections(options)(tree);
  return tree;
};

/** A ~400-char paragraph, distinct per index. */
const para = (i) => `Block ${i}. ${"Detail sentence follows here. ".repeat(13)}`;

const LONG_SECTION = ["## Findings", para(1), para(2), para(3), para(4)].join("\n\n");
const LEAD = "The lead answer line.\n\nA second lead block.";

test("a long h2 section folds: heading + two blocks stay, the rest wraps once", () => {
  const tree = run(`${LEAD}\n\n${LONG_SECTION}`, { enabled: true });
  const types = tree.children.map((n) => n.type);
  // lead para ×2, heading, two visible paras, ONE wrapper.
  assert.deepEqual(types, [
    "paragraph",
    "paragraph",
    "heading",
    "paragraph",
    "paragraph",
    "lhCollapsedSection",
  ]);
  const wrapper = tree.children[5];
  assert.equal(wrapper.children.length, 2, "blocks three and four are the hidden tail");
  assert.equal(wrapper.data.hName, "div");
  assert.deepEqual(wrapper.data.hProperties.className, [COLLAPSED_SECTION_CLASS]);
});

test("disabled (or default) is a byte-level no-op — the streaming/desktop path", () => {
  const md = `${LEAD}\n\n${LONG_SECTION}`;
  assert.deepEqual(run(md, { enabled: false }), parse(md));
  assert.deepEqual(run(md), parse(md));
});

test("the lead never folds, even when it is the long part", () => {
  const longLead = Array.from({ length: 6 }, (_, i) => para(i)).join("\n\n");
  const tree = run(longLead, { enabled: true });
  assert.ok(
    tree.children.every((n) => n.type === "paragraph"),
    "an unsectioned answer is all lead — untouched",
  );
  // Lead ahead of a folding section is also untouched: the first two children
  // stay paragraphs even though the section after them folds.
  const tree2 = run(`${longLead}\n\n${LONG_SECTION}`, { enabled: true });
  assert.equal(tree2.children.filter((n) => n.type === "lhCollapsedSection").length, 1);
  assert.equal(tree2.children[0].type, "paragraph");
});

test("a section under the threshold, or with nothing beyond the visible blocks, is left alone", () => {
  const short = run("## Short\n\nOne small block.\n\nAnother small block.\n\nThird.", {
    enabled: true,
  });
  assert.ok(short.children.every((n) => n.type !== "lhCollapsedSection"));
  const twoBlocks = run(`## Two\n\n${para(1)}\n\n${para(2)}`, { enabled: true });
  assert.ok(twoBlocks.children.every((n) => n.type !== "lhCollapsedSection"));
});

test("h4 headings do not delimit sections; h3 does", () => {
  const h4 = run(["#### Deep", para(1), para(2), para(3), para(4)].join("\n\n"), {
    enabled: true,
  });
  assert.ok(h4.children.every((n) => n.type !== "lhCollapsedSection"));
  const h3 = run(["### Sub", para(1), para(2), para(3), para(4)].join("\n\n"), {
    enabled: true,
  });
  assert.equal(h3.children.filter((n) => n.type === "lhCollapsedSection").length, 1);
});

test("only the over-threshold sections of a multi-section answer fold", () => {
  const md = [
    "Lead.",
    "## Short one",
    "Tiny.",
    "## Long one",
    para(1),
    para(2),
    para(3),
    para(4),
    "## Another long",
    para(5),
    para(6),
    para(7),
  ].join("\n\n");
  const tree = run(md, { enabled: true });
  const wrappers = tree.children.filter((n) => n.type === "lhCollapsedSection");
  assert.equal(wrappers.length, 2, "both long sections fold, the short one doesn't");
  assert.equal(wrappers[0].children.length, 2);
  assert.equal(wrappers[1].children.length, 1);
  // The short section's single block is still a plain sibling.
  const shortIdx = tree.children.findIndex(
    (n) => n.type === "heading" && n.children[0].value === "Short one",
  );
  assert.equal(tree.children[shortIdx + 1].type, "paragraph");
});

test("§44 §3: the engine provenance footer is never parked behind Show more", () => {
  // In the real pipeline remarkAnswerCard folds "*Query used:*" into an
  // `lhQueryDetails` node (and leaves "Computed from:" as a raw line) BEFORE
  // this transform runs. A long section that ends with those deterministic
  // footers still folds its PROSE tail, but the proof of a verified number is
  // shown by default — the footers stay visible siblings, never collapsed.
  const nodeText = (n) =>
    typeof n.value === "string" ? n.value : (n.children ?? []).map(nodeText).join("");
  const tree = parse(["Lead.", "## Findings", para(1), para(2), para(3), para(4)].join("\n\n"));
  tree.children.push({
    type: "lhQueryDetails",
    data: { hName: "details", hProperties: { className: ["lh-query-used"] } },
    children: [{ type: "paragraph", children: [{ type: "text", value: "Query used:" }] }],
  });
  tree.children.push({
    type: "paragraph",
    children: [{ type: "emphasis", children: [{ type: "text", value: "Computed from: sleep.csv" }] }],
  });
  remarkCollapseSections({ enabled: true })(tree);
  const wrappers = tree.children.filter((n) => n.type === "lhCollapsedSection");
  assert.equal(wrappers.length, 1, "the long section still folds its prose tail");
  const wrappedTypes = wrappers[0].children.map((n) => n.type);
  assert.ok(!wrappedTypes.includes("lhQueryDetails"), "the Query-used disclosure is NOT parked");
  const topTypes = tree.children.map((n) => n.type);
  assert.ok(topTypes.includes("lhQueryDetails"), "Query-used is a visible sibling by default");
  assert.match(nodeText(tree.children[tree.children.length - 1]), /Computed from:/, "Computed-from stays visible");
});

test("the tuning constants stay what the spec named", () => {
  assert.equal(COLLAPSE_THRESHOLD_CHARS, 1200);
  assert.equal(COLLAPSE_VISIBLE_BLOCKS, 2);
});

// --- Renderer wiring (source pins) ------------------------------------------

test("ChatPanel swaps ONLY the collapsed div and gates the plugin on compact + settled", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(
    chat,
    /if \(className\?\.split\(" "\)\.includes\(COLLAPSED_SECTION_CLASS\)\) \{\s*\n\s*return <CollapsedSection>\{children\}<\/CollapsedSection>;/,
    "the div override watches the class and passes other divs through",
  );
  assert.match(
    chat,
    /\[remarkCollapseSections, \{ enabled: collapseSections \}\],\s*\n\s*\]\}/,
    "the plugin runs LAST in the remark chain, behind the enabled gate",
  );
  // Both settled mounts gate on the compact layout; the streaming block never
  // passes the prop (its AnswerMarkdown call carries no collapseSections).
  assert.equal(
    (chat.match(/collapseSections=\{compactLayout\}/g) ?? []).length,
    2,
    "transcript + sql-result mounts collapse on compact only",
  );
  const streamBlock = chat.slice(chat.indexOf("const StreamBlock"), chat.indexOf("const StreamingAnswer"));
  assert.ok(
    !streamBlock.includes("collapseSections"),
    "the streaming path never collapses (default false)",
  );
  assert.match(chat, /collapseSections = false,/, "the prop fails closed");
});

test("the fold control is a quiet 44px button and the reveal obeys reduced motion", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  const btn = chat.slice(chat.indexOf("showMoreBtn: {"), chat.indexOf("collapsedReveal: {"));
  assert.match(btn, /minHeight: "44px",/, "44pt touch target");
  assert.match(chat, /aria-expanded=\{false\}/, "the control announces its state");
  assert.match(chat, />\s*\n\s*Show more\s*\n\s*<\/button>/, "the label is the quiet two words");
  const reveal = chat.slice(chat.indexOf("collapsedReveal: {"), chat.indexOf("citeChip: {"));
  assert.match(
    reveal,
    /"@media \(prefers-reduced-motion: reduce\)": \{ animationName: "none" \}/,
    "no animation under reduced motion",
  );
  // Per-message, not persisted: plain useState, no storage key.
  const comp = chat.slice(chat.indexOf("function CollapsedSection"), chat.indexOf("const AnswerMarkdown"));
  assert.match(comp, /const \[open, setOpen\] = useState\(false\);/);
  assert.ok(!/localStorage|sessionStorage/.test(comp), "expand state is never persisted");
});
