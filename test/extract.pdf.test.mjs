/**
 * Regression test for PDF text extraction (issue #25).
 *
 * PDFs were silently contributing no searchable text. This guards the exact
 * unpdf call shape that src/server/extract.ts#extractPdf depends on against a
 * small committed text-based PDF, so an unpdf API change (or a broken install)
 * fails here loudly instead of silently degrading every PDF to filename-only.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "fixtures", "sample.pdf");

test("extractPdf recovers the text layer from a text-based PDF", async () => {
  // Mirrors extractPdf() in src/server/extract.ts.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const buf = fs.readFileSync(SAMPLE);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const out = Array.isArray(text) ? text.join("\n") : text;

  assert.equal(typeof out, "string");
  assert.ok(out.trim().length > 0, "expected non-empty extracted text");
  assert.match(out, /Lighthouse keeps your files private/);
});
