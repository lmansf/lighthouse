/**
 * Survivor-killing bound pins for the file inspector's PREVIEW TABLE.
 *
 * inspect.test.mjs beside it mirrors the Rust twin over a shared fixture and
 * proves the field contract — which fields render, which stay absent. What it
 * does not pin is `parsePreviewTable`'s arithmetic, and the mutation harness
 * said so: 46.5%, 23 survivors, nearly all of them inside that one function's
 * bounds and guards.
 *
 * These are not cosmetic. `previewTable` is a SHARED wire field: inspect.rs
 * parses the same delimited head the same way, and the panel renders whichever
 * engine answered. A row cap off by one, a header width read from the wrong
 * line, or a `truncated` flag that lies would make the two engines disagree
 * about the same file — the exact class of drift the twin rule exists to stop.
 *
 * Every fixture below is chosen so ONE mutant flips its assertion.
 *
 * Run: `node --test test/inspectBounds.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

function freshState(tag) {
  const home = mkdtempSync(path.join(tmpdir(), `lh-inspb-${tag}-`));
  process.env.LIGHTHOUSE_APP_STATE_DIR = path.join(home, ".rag-vault");
  mkdirSync(process.env.LIGHTHOUSE_APP_STATE_DIR, { recursive: true });
  return home;
}

const workspace = await import("../src/server/workspace.ts");
const { inspect } = await import("../src/server/inspect.ts");

/** Attach `body` as `name` in a fresh state and inspect it. */
async function inspectOf(tag, name, body, query) {
  freshState(tag);
  const id = workspace.attach("c", name, Buffer.from(body)).id;
  return inspect("c", id, query);
}

const csv = (rows) => rows.map((r) => r.join(",")).join("\n") + "\n";

// --- the row cap ------------------------------------------------------------

test("exactly 5 data rows are kept, and a 6th sets truncated instead of appearing", async () => {
  const five = csv([["h1", "h2"], ...Array.from({ length: 5 }, (_, i) => [`r${i + 1}`, `${i + 1}`])]);
  const t5 = (await inspectOf("rows5", "t.csv", five)).previewTable;
  assert.equal(t5.rows.length, 5, "five rows fit");
  assert.equal(t5.truncated, false, "and nothing was dropped");

  const six = csv([["h1", "h2"], ...Array.from({ length: 6 }, (_, i) => [`r${i + 1}`, `${i + 1}`])]);
  const t6 = (await inspectOf("rows6", "t.csv", six)).previewTable;
  assert.equal(t6.rows.length, 5, "the cap holds at five");
  assert.equal(t6.truncated, true, "and the sixth is reported, not silently dropped");
  assert.equal(t6.rows[4][0], "r5", "the kept rows are the FIRST five, in order");
});

// --- the column cap ---------------------------------------------------------

test("exactly 8 columns are kept, and a 9th sets truncated", async () => {
  const head8 = Array.from({ length: 8 }, (_, i) => `c${i + 1}`);
  const t8 = (await inspectOf("cols8", "t.csv", csv([head8, head8.map((_, i) => `v${i}`)])))
    .previewTable;
  assert.equal(t8.header.length, 8);
  assert.equal(t8.truncated, false);

  const head9 = Array.from({ length: 9 }, (_, i) => `c${i + 1}`);
  const t9 = (await inspectOf("cols9", "t.csv", csv([head9, head9.map((_, i) => `v${i}`)])))
    .previewTable;
  assert.equal(t9.header.length, 8, "the 9th column is cut");
  assert.equal(t9.truncated, true, "and the cut is declared");
});

// --- the header-width guard -------------------------------------------------

test("a single-column file yields NO preview table (a list is not a table)", async () => {
  const one = await inspectOf("onecol", "t.csv", "just_one_header\nvalue\nvalue2\n");
  assert.equal(one.previewTable, undefined, "header.length < 2 is not a table");
});

test("a two-column file DOES yield one — the boundary is 1-vs-2, not 2-vs-3", async () => {
  const two = (await inspectOf("twocol", "t.csv", csv([["a", "b"], ["1", "2"]]))).previewTable;
  assert.equal(two.header.length, 2);
  assert.deepEqual(two.rows, [["1", "2"]]);
});

test("a header with no data rows at all yields no table", async () => {
  const headerOnly = await inspectOf("hdronly", "t.csv", "a,b,c\n");
  assert.equal(headerOnly.previewTable, undefined, "rows.length === 0 ⇒ undefined");
});

// --- row alignment ----------------------------------------------------------

test("short rows are padded to the header's width, long rows are cut to it", async () => {
  const body = "a,b,c\n1\n1,2,3,4\n";
  const t = (await inspectOf("align", "t.csv", body)).previewTable;
  assert.equal(t.header.length, 3);
  assert.deepEqual(t.rows[0], ["1", "", ""], "padded with empties, not dropped");
  assert.deepEqual(t.rows[1], ["1", "2", "3"], "cut to the header width");
});

test("cells are trimmed and blank lines never become rows", async () => {
  const body = "a , b\n 1 , 2 \n\n\n 3 , 4 \n";
  const t = (await inspectOf("trim", "t.csv", body)).previewTable;
  assert.deepEqual(t.header, ["a", "b"]);
  assert.deepEqual(t.rows, [["1", "2"], ["3", "4"]], "two rows, not four");
});

test("CRLF files parse identically to LF ones", async () => {
  const t = (await inspectOf("crlf", "t.csv", "a,b\r\n1,2\r\n3,4\r\n")).previewTable;
  assert.deepEqual(t.header, ["a", "b"], "no stray \\r on the last header cell");
  assert.deepEqual(t.rows, [["1", "2"], ["3", "4"]]);
});

// --- the delimiter is chosen by extension ------------------------------------

test("a .tsv splits on tabs and a .csv on commas — not the other way round", async () => {
  const tsv = (await inspectOf("tsv", "t.tsv", "a\tb\n1\t2\n")).previewTable;
  assert.deepEqual(tsv.header, ["a", "b"]);
  const asCsv = (await inspectOf("tsvascsv", "t.csv", "a\tb\n1\t2\n")).previewTable;
  assert.equal(asCsv, undefined, "tab-delimited read as CSV is one column ⇒ no table");
});

test("a non-delimited tabular file gets the text preview but no parsed table", async () => {
  const x = await inspectOf("xlsx", "book.xlsx", "not really a workbook");
  assert.equal(x.previewTable, undefined);
  assert.equal(x.chunkMode, "tabular", "still chunked by rows");
});

// --- the source-truncation flag ---------------------------------------------

test("a file under the 2000-char bound is not flagged truncated", async () => {
  const small = csv([["a", "b"], ["1", "2"]]);
  assert.ok(small.length < 2000);
  const t = (await inspectOf("small", "t.csv", small)).previewTable;
  assert.equal(t.truncated, false);
});

test("a file past the bound is flagged, and its partial last line is dropped", async () => {
  // Rows are 20 chars, so the 2000-char slice lands mid-row: the partial one
  // must not surface as a row of its own.
  const rows = Array.from({ length: 400 }, (_, i) => [`row${String(i).padStart(6, "0")}`, "xxxxxxxx"]);
  const big = csv([["header1", "header2"], ...rows]);
  assert.ok(big.length > 2000);
  const t = (await inspectOf("big", "t.csv", big)).previewTable;
  assert.equal(t.truncated, true);
  assert.equal(t.rows.length, 5, "still capped at five");
  for (const r of t.rows) assert.equal(r.length, 2, "every surfaced row is whole");
});

// --- the preview text bound --------------------------------------------------

test("extractPreview is capped at 600 characters", async () => {
  const long = "z".repeat(5000);
  const out = await inspectOf("prev", "notes.md", long);
  assert.equal(out.extractPreview.length, 600, "exactly the PREVIEW_CHARS bound");
});

// --- test-search bounds ------------------------------------------------------

test("test-search hits are capped at 240 characters each", async () => {
  const body = `# Notes\n\n${"revenue ".repeat(400)}\n`;
  const out = await inspectOf("hitcap", "notes.md", body, "revenue");
  assert.ok(out.testSearch.length > 0, "the query matched something");
  for (const h of out.testSearch) {
    assert.ok(h.text.length <= 240, `hit was ${h.text.length} chars`);
  }
});

test("test-search runs only for a non-blank query", async () => {
  freshState("q");
  const id = workspace.attach("c", "notes.md", Buffer.from("# Notes\nrevenue rose.\n")).id;
  assert.equal((await inspect("c", id)).testSearch, undefined, "absent query ⇒ no search");
  assert.equal((await inspect("c", id, "   ")).testSearch, undefined, "blank query ⇒ no search");
  assert.ok((await inspect("c", id, "revenue")).testSearch.length > 0, "a real query searches");
});
