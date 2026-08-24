/**
 * Survivor-killing pins for the evidence pack's markdown renderer and
 * provenance section.
 *
 * evidencePack.test.mjs beside it proves the offline invariant — one
 * self-contained document, zero external references — which is the pack's
 * headline property. The harness still scored the module 64.4%, with the
 * survivors sitting in `answerMarkdownToHtml`'s block grammar and in the
 * provenance de-duplication.
 *
 * Both are worth pinning. An evidence pack is made to be forwarded and filed:
 * it is the artifact someone else reads instead of the app. A chart fence
 * leaking through as a code block, a table swallowing the prose beneath it, or
 * a provenance list naming the same file twice are all defects a reader sees
 * and cannot check against the original.
 *
 * Run: `node --test test/evidencePackMarkdown.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { answerMarkdownToHtml, composeReportHtml } = await import("../src/lib/evidencePack.ts");

// --- fences: the chart fence is DROPPED, others are kept as code ------------

test("a lighthouse-chart fence is dropped entirely, body and all", () => {
  // The chart travels separately as inline SVG; leaking its JSON into the
  // document would show a reader raw spec text.
  const html = answerMarkdownToHtml(
    ['before', '```lighthouse-chart', '{"kind":"bar","x":["a"]}', '```', 'after'].join("\n"),
  );
  assert.ok(html.includes("before") && html.includes("after"));
  assert.ok(!html.includes("lighthouse-chart"), "the fence marker is gone");
  assert.ok(!html.includes('"kind"'), "and so is its body");
});

test("any OTHER fence is kept as an escaped code block", () => {
  const html = answerMarkdownToHtml(["```sql", "SELECT 1 < 2", "```"].join("\n"));
  assert.ok(html.includes("<pre><code>"), "rendered as code");
  assert.ok(html.includes("SELECT 1 &lt; 2"), "and escaped");
});

test("a fence with no language is still a code block", () => {
  const html = answerMarkdownToHtml(["```", "plain", "```"].join("\n"));
  assert.ok(html.includes("<pre><code>plain</code></pre>"));
});

test("an UNCLOSED fence consumes to EOF without hanging or leaking", () => {
  // `while (i < lines.length && !closing)` then `i += 1` past the close (or
  // EOF). A mutant on either bound loops forever or re-reads the last line.
  const html = answerMarkdownToHtml(["```sql", "SELECT 1", "SELECT 2"].join("\n"));
  assert.ok(html.includes("SELECT 1") && html.includes("SELECT 2"));
  assert.ok(!html.includes("```"), "no stray fence marker survives");
});

test("an unclosed CHART fence swallows the rest rather than leaking spec text", () => {
  const html = answerMarkdownToHtml(["```lighthouse-chart", '{"kind":"bar"}'].join("\n"));
  assert.ok(!html.includes('"kind"'), "still dropped when never closed");
});

// --- tables -----------------------------------------------------------------

test("a table renders, and the prose after it is NOT swallowed", () => {
  const html = answerMarkdownToHtml(
    ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "Closing prose."].join("\n"),
  );
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("<td>1</td>"));
  assert.ok(html.includes("Closing prose."), "the run ended at the blank line");
});

test("pipe rows with no alignment row stay prose, not a table", () => {
  const html = answerMarkdownToHtml(["| a | b |", "| 1 | 2 |"].join("\n"));
  assert.ok(!html.includes("<table>"));
});

test("a trailing pipe row at EOF cannot open a table past the buffer", () => {
  // `i + 1 < lines.length` guards the alignment-row lookahead.
  assert.doesNotThrow(() => answerMarkdownToHtml("| a | b |"));
  assert.ok(!answerMarkdownToHtml("| a | b |").includes("<table>"));
});

test("table cells are escaped — markup in an answer cannot inject", () => {
  const html = answerMarkdownToHtml(
    ["| a | b |", "| --- | --- |", "| <script>x</script> | ok |"].join("\n"),
  );
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// --- headings ---------------------------------------------------------------

test("headings nest UNDER the document h1 and are capped at h4", () => {
  // `Math.min(level + 1, 4)`: the question owns h1, so markdown # becomes h2,
  // and deep headings clamp rather than emitting h7.
  assert.ok(answerMarkdownToHtml("# One").includes("<h2>One</h2>"));
  assert.ok(answerMarkdownToHtml("## Two").includes("<h3>Two</h3>"));
  assert.ok(answerMarkdownToHtml("### Three").includes("<h4>Three</h4>"));
  assert.ok(answerMarkdownToHtml("###### Six").includes("<h4>Six</h4>"), "clamped at 4");
});

test("a # with no space is not a heading", () => {
  const html = answerMarkdownToHtml("#NotAHeading");
  assert.ok(!/<h[1-6]>/.test(html));
  assert.ok(html.includes("#NotAHeading"));
});

// --- lists ------------------------------------------------------------------

test("a dash list and a star list both become one <ul> per run", () => {
  const dash = answerMarkdownToHtml(["- one", "- two"].join("\n"));
  assert.equal((dash.match(/<ul>/g) || []).length, 1, "one list, not two");
  assert.equal((dash.match(/<li>/g) || []).length, 2);
  assert.ok(answerMarkdownToHtml(["* a", "* b"].join("\n")).includes("<ul>"));
});

test("an ordered list accepts both `1.` and `1)` and stops at the first non-item", () => {
  const html = answerMarkdownToHtml(["1. one", "2) two", "", "prose after"].join("\n"));
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.ok(html.includes("prose after"), "the list run ended");
});

test("the list marker is stripped from the item text", () => {
  const html = answerMarkdownToHtml("- item text");
  assert.ok(html.includes("<li>item text</li>"), "no leading dash survives");
});

test("a numbered line without a separator is not a list", () => {
  const html = answerMarkdownToHtml("1 not a list item");
  assert.ok(!html.includes("<ol>"));
});

// --- composeReportHtml assembly ---------------------------------------------

test("charts are appended as figures, and blank chart strings are skipped", () => {
  // `if (svg && svg.trim())` — a mutant dropping it emits an empty <figure>,
  // which prints as a blank box in the filed document.
  const html = composeReportHtml({
    title: "T",
    markdown: "body",
    charts: ["<svg id='a'></svg>", "", "   ", "<svg id='b'></svg>"],
  });
  assert.equal((html.match(/<figure class="chart">/g) || []).length, 2, "only the real two");
});

test("the generated-at line appears only when a timestamp was supplied", () => {
  assert.ok(!composeReportHtml({ title: "T", markdown: "b" }).includes("Generated"));
  assert.ok(composeReportHtml({ title: "T", markdown: "b", generatedAt: 0 }).includes("Generated"));
});

test("generatedAt of 0 still renders — 0 is a timestamp, not 'absent'", () => {
  // `generatedAt !== undefined` rather than a truthiness test: the epoch is a
  // legitimate value and the fixtures use it.
  const html = composeReportHtml({ title: "T", markdown: "b", generatedAt: 0 });
  assert.ok(html.includes("Generated"), "0 is not treated as missing");
});
