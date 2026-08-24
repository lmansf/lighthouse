/**
 * Read-only file inspector — TS twin ("What the AI sees", openspec:
 * add-file-inspector). Mirrors native/crates/lighthouse-core/tests/
 * inspect_test.rs over the SAME fixture: the SHARED fields render (name,
 * extractPreview, chunkMode, testSearch), the test-search reuses the lexical
 * scorer scoped to the ONE file id, and — the parity contract — the
 * Rust-engine-only fields (fromOcr, chunkCount, columns, indexedAt, fresh) are
 * ABSENT, never faked.
 *
 * Since 0.15.0 the subject is a conversation's ATTACHMENT, so the `included`
 * and `localOnly` fields are gone with the inclusion gate that produced them.
 *
 * Run: `node --test test/inspect.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

/** A throwaway engine state root. */
function freshState() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-inspect-"));
  process.env.LIGHTHOUSE_APP_STATE_DIR = path.join(home, ".rag-vault");
  mkdirSync(process.env.LIGHTHOUSE_APP_STATE_DIR, { recursive: true });
  return home;
}

const CONV = "conv-inspect";

// Byte-identical to the Rust twin's fixture (inspect_test.rs::setup).
const SALES_CSV =
  "date,region,product,amount\n2025-01-02,NE,widgets,10\n2025-01-03,NW,gadgets,20\n2025-01-04,SE,widgets,30\n";
const OTHER_MD = "Quarterly widgets summary. BETA_ONLY_MARKER for the scoping assertion.";

/** The Rust-engine-only fields the twin must omit (never fake). */
const RUST_ONLY = ["fromOcr", "chunkCount", "columns", "indexedAt", "fresh"];

const workspace = await import("../src/server/workspace.ts");
const { inspect } = await import("../src/server/inspect.ts");

/** Attach the fixture and return the minted ids, keyed by name. */
function seed() {
  return {
    sales: workspace.attach(CONV, "sales.csv", Buffer.from(SALES_CSV)).id,
    other: workspace.attach(CONV, "other.md", Buffer.from(OTHER_MD)).id,
  };
}

test("the twin renders the shared fields and OMITS the Rust-only fields (never faked)", async () => {
  freshState();
  const ids = seed();

  const insp = await inspect(CONV, ids.sales);

  // Shared fields render.
  assert.equal(insp.name, "sales.csv");
  assert.equal(insp.chunkMode, "tabular");
  assert.ok(
    typeof insp.extractPreview === "string" && insp.extractPreview.includes("region"),
    "extractPreview is the extracted text",
  );

  // CSV/TSV get a parsed table preview (header + first rows) — a SHARED field.
  assert.ok(insp.previewTable, "a csv gets a parsed table preview");
  assert.deepEqual(insp.previewTable.header, ["date", "region", "product", "amount"]);
  assert.equal(insp.previewTable.rows.length, 3);
  assert.deepEqual(insp.previewTable.rows[0], ["2025-01-02", "NE", "widgets", "10"]);
  assert.equal(insp.previewTable.truncated, false, "the small fixture is not truncated");

  // Parity contract: the Rust-only fields are ABSENT, not present as fakes.
  for (const key of RUST_ONLY) {
    assert.ok(!(key in insp), `twin omits Rust-only field ${key}`);
  }
  assert.ok(!("testSearch" in insp), "no query ⇒ no test-search field");
});

test("test-search reuses the lexical scorer scoped to the one file id", async () => {
  freshState();
  const ids = seed();

  const insp = await inspect(CONV, ids.sales, "widgets");
  assert.ok(
    Array.isArray(insp.testSearch) && insp.testSearch.length > 0,
    "the matching file returns scored chunks",
  );
  assert.ok(
    insp.testSearch.every((h) => typeof h.score === "number"),
    "every hit carries a score",
  );
  assert.ok(
    insp.testSearch.some((h) => h.text.includes("widgets")),
    "the file's matching chunk is returned",
  );
  // Scoped: the OTHER included file also matches "widgets" but must never appear.
  assert.ok(
    insp.testSearch.every((h) => !h.text.includes("BETA_ONLY_MARKER")),
    "test-search must not surface any other file's chunks",
  );
  // Still omits the Rust-only fields with a query present.
  for (const key of RUST_ONLY) {
    assert.ok(!(key in insp), `twin omits Rust-only field ${key}`);
  }
});

test("a prose file reports prose chunking and no columns field", async () => {
  freshState();
  const id = workspace.attach(CONV, "other.md", Buffer.from(OTHER_MD)).id;

  const insp = await inspect(CONV, id);
  assert.equal(insp.chunkMode, "prose");
  assert.ok(!("columns" in insp), "prose file: no columns field at all on the twin");
});

test("an unknown or out-of-conversation id yields an empty inspection", async () => {
  freshState();
  const ids = seed();
  assert.deepEqual(await inspect(CONV, "att-000000000000"), {}, "unknown id ⇒ empty payload");
  assert.deepEqual(
    await inspect("conv-empty", ids.sales),
    {},
    "a conversation with no manifest inspects to nothing",
  );
  workspace.detach(CONV, ids.sales);
  assert.deepEqual(await inspect(CONV, ids.sales), {}, "a detached id no longer inspects");
});

// iOS field patch 3 §1: ocrAvailability is a SHARED field with a per-engine
// honest value. This engine has no OCR, so for a file OCR could apply to it
// reports the constant "unsupported" (never a fake of the Rust engine's live
// "ready"/"off"/"missing-models" verdict); for a non-OCR file it is absent.
// PARITY: inspect.rs fills the same field via ocr::availability(), gated on the
// same OCR-relevant extension set.
test("ocrAvailability is 'unsupported' for OCR-relevant files, absent otherwise", async () => {
  freshState();
  const ids = seed(); // sales.csv (not OCR-relevant) + other.md
  const pdfId = workspace.attach(
    CONV,
    "scan.pdf",
    Buffer.from("%PDF-1.4\n% not really a pdf\n"),
  ).id;

  const pdf = await inspect(CONV, pdfId);
  assert.equal(pdf.ocrAvailability, "unsupported", "the twin reports its honest OCR constant for a PDF");

  const csv = await inspect(CONV, ids.sales);
  assert.ok(!("ocrAvailability" in csv), "a non-OCR file carries no ocrAvailability");
});
