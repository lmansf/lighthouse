/**
 * Inline HTML in answers: the ANSWER_HTML_SCHEMA guarantees, proved on the
 * REAL pipeline MarkdownView runs (remark-parse + remark-gfm → remark-rehype
 * with raw passthrough → rehype-raw → rehype-sanitize with our schema) — not
 * on a mock. Two families of pins:
 *
 *  1. Nothing dangerous survives: no scripts, no event handlers, no
 *     javascript: URLs, and — stricter than GitHub's default — NO
 *     remote-loading elements (`img`/`picture`/`source`): a rendered answer
 *     must never cause a network request (egress-ledger story; a model or a
 *     prompt-injected document could otherwise exfiltrate via image URLs).
 *  2. Everything the app depends on still renders: the chart/stat/SQL fence
 *     classNames (`language-*` on <code>), citation links (`#lh-cite-n`),
 *     GFM table alignment, and the safe formatting tags the SYSTEM_PROMPT now
 *     advertises (<sub>/<sup>/<br>/<details>/<mark>/<kbd>).
 *
 * Run: `node --test test/answerHtml.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

register("./_ts-extensionless-hook.mjs", import.meta.url);
const { ANSWER_HTML_SCHEMA } = await import("../src/lib/answerHtml.ts");

/** Render markdown exactly the way MarkdownView does (minus React). */
async function render(md) {
  const out = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, ANSWER_HTML_SCHEMA)
    .use(rehypeStringify)
    .process(md);
  return String(out);
}

test("scripts, handlers, and dangerous URLs are stripped", async () => {
  const html = await render(
    [
      '<script>alert("pwn")</script>',
      '<b onclick="steal()">bold</b>',
      '<a href="javascript:alert(1)">x</a>',
      "<iframe src=\"https://evil.example\"></iframe>",
      "<style>body{display:none}</style>",
      '<form action="https://evil.example"><input type="text" name="k"></form>',
    ].join("\n\n"),
  );
  assert.ok(!/<script/i.test(html), "script element survived");
  assert.ok(!/alert\("pwn"\)/.test(html), "script BODY leaked as text");
  assert.ok(!/onclick/i.test(html), "event handler survived");
  assert.ok(!/javascript:/i.test(html), "javascript: URL survived");
  assert.ok(!/<iframe/i.test(html), "iframe survived");
  assert.ok(!/display:none/.test(html), "style BODY leaked as text");
  assert.ok(!/<form|type="text"/i.test(html), "form/free-text input survived");
  assert.ok(/<b>bold<\/b>/.test(html), "the benign <b> around the handler still renders");
});

test("no remote-loading elements — an answer never causes a network request", async () => {
  const html = await render(
    [
      '<img src="https://evil.example/pixel.png">',
      "![alt](https://evil.example/md-image.png)",
      '<picture><source srcset="https://evil.example/p.avif"><img src="https://evil.example/p.png"></picture>',
      '<video src="https://evil.example/v.mp4"></video>',
      '<audio src="https://evil.example/a.mp3"></audio>',
    ].join("\n\n"),
  );
  assert.ok(!/<(img|picture|source|video|audio)\b/i.test(html), "a loading element survived");
  assert.ok(!/evil\.example/.test(html.replace(/&#x[0-9a-f]+;/gi, "")), "a remote URL survived in an attribute");
});

test("the app's own constructs survive sanitization", async () => {
  const html = await render(
    [
      "| region | total |",
      "|:-------|------:|",
      "| west   |   4.2 |",
      "",
      "```lighthouse-chart",
      "{}",
      "```",
      "",
      "```lighthouse-stat",
      "{}",
      "```",
      "",
      "```sql",
      "SELECT 1",
      "```",
      "",
      "Grounded fact [3](#lh-cite-3).",
    ].join("\n"),
  );
  assert.ok(/<code class="language-lighthouse-chart">/.test(html), "chart fence className stripped");
  assert.ok(/<code class="language-lighthouse-stat">/.test(html), "stat fence className stripped");
  assert.ok(/<code class="language-sql">/.test(html), "sql fence className stripped");
  assert.ok(/<a href="#lh-cite-3">3<\/a>/.test(html), "citation link stripped");
  assert.ok(/<th align="left">/.test(html) && /<td align="right">/.test(html), "GFM table alignment stripped");
});

test("the formatting tags the SYSTEM_PROMPT advertises all render", async () => {
  const html = await render(
    [
      "Revenue grew 3<sup>rd</sup> quarter, H<sub>2</sub>O usage fell.",
      "",
      "| item | note |",
      "| --- | --- |",
      "| a | line one<br>line two |",
      "",
      "<details><summary>Appendix</summary>Long detail here.</details>",
      "",
      "The key figure is <mark>$4.2M</mark>. Press <kbd>Enter</kbd>. <u>Underlined</u>, <small>fine print</small>, <abbr title=\"Annual Recurring Revenue\">ARR</abbr>.",
    ].join("\n"),
  );
  for (const tag of ["sup", "sub", "br", "details", "summary", "mark", "kbd", "u", "small"]) {
    assert.ok(new RegExp(`<${tag}[ >]`).test(html) || html.includes(`<${tag}>`), `<${tag}> did not render`);
  }
  assert.ok(/<abbr title="Annual Recurring Revenue">/.test(html), "<abbr title> did not render");
});

test("ids are clobbered so answer HTML cannot shadow app anchors", async () => {
  const html = await render('<p id="lh-cite-anchor-3">shadow attempt</p>');
  assert.ok(!/id="lh-cite-anchor-3"/.test(html), "raw id survived unclobbered");
  assert.ok(/id="user-content-lh-cite-anchor-3"/.test(html), "id was dropped instead of clobbered");
});

test("plain HTML tables render (the report-style output models like to emit)", async () => {
  const html = await render(
    "<table><thead><tr><th>region</th><th>total</th></tr></thead><tbody><tr><td>west</td><td>4.2</td></tr></tbody></table>",
  );
  assert.ok(/<table>[\s\S]*<th>region<\/th>[\s\S]*<td>4\.2<\/td>[\s\S]*<\/table>/.test(html), "HTML table did not survive");
});
