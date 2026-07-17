/**
 * Exportable reports (openspec: add-usability-field-patch §4). composeReportHtml
 * renders any report-shaped document to ONE self-contained HTML string. The
 * offline invariant — nothing leaves the machine, so the file loads with no
 * network — is the whole point, so it's asserted for real: the output must
 * carry zero external references (reusing the evidence-pack shell that already
 * guarantees this). Pure + DOM-free (runs straight under node).
 *
 * Run: `node --test test/reportExport.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { composeReportHtml } = await import("../src/lib/evidencePack.ts");

test("the report HTML is fully self-contained — zero external references", () => {
  const html = composeReportHtml({
    title: "Q3 revenue report",
    markdown: "## Summary\n\nRevenue rose **12%**.\n\n| Month | Rev |\n|---|---|\n| Jul | 100 |\n",
    charts: ['<svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>'],
    generatedAt: 0,
  });
  assert.ok(html.startsWith("<!doctype html>"), "a complete HTML document");
  assert.ok(html.includes("Q3 revenue report"));
  assert.ok(html.includes("<svg"), "chart baked in as inline SVG");
  // No external resource of ANY kind: no absolute URLs, no protocol-relative
  // src/href, no CSS @import, no remote url().
  assert.equal(/https?:\/\//i.test(html), false, "no absolute URLs");
  assert.equal(/(?:src|href)\s*=\s*["']\/\//i.test(html), false, "no protocol-relative refs");
  assert.equal(/@import/i.test(html), false, "no CSS @import");
  assert.equal(/url\(\s*["']?\s*https?:/i.test(html), false, "no remote url()");
});

test("markdown renders to HTML and the title stamps the document", () => {
  const html = composeReportHtml({ title: "My Report", markdown: "# Heading\n\nbody text" });
  assert.ok(html.includes("<title>My Report</title>"));
  assert.ok(/<h[123]/.test(html), "markdown headings become HTML headings");
  assert.ok(html.includes("body text"));
});

test("an empty report is still a valid minimal document, never an error", () => {
  const html = composeReportHtml({ title: "", markdown: "" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.trimEnd().endsWith("</html>"));
});

test("the title is HTML-escaped (no markup injection through it)", () => {
  const html = composeReportHtml({ title: "<script>x</script>", markdown: "" });
  assert.equal(html.includes("<script>x</script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

// --- The three export actions (structural — they wrap the vault-write path) --

test("reportExport wires HTML / Markdown / print to the allowlist write", () => {
  const src = read("src/lib/reportExport.ts");
  // (a) HTML → self-contained doc, written to the Results folder.
  assert.match(src, /composeReportHtml\(input\)/);
  assert.match(src, /subdir:\s*"Lighthouse Results",\s*\n?\s*ext:\s*"html"/);
  // (c) Markdown → a .md note.
  assert.match(src, /subdir:\s*"Lighthouse Notes",\s*\n?\s*ext:\s*"md"/);
  // (b) PDF → the system print / Save-as-PDF flow.
  assert.match(src, /export function printReport/);
  assert.match(src, /\.print\(\)/);
  // Nothing egresses — it only reaches the vault write + the OS print dialog.
  assert.equal(/fetch\(|https?:\/\//.test(src), false);
});
