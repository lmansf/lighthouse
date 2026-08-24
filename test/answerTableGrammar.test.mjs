/**
 * Survivor-killing grammar pins for parseMarkdownTable.
 *
 * answerTable.test.mjs beside it covers the stat detector and the happy-path
 * parse. The harness scored the module 71.4% with the survivors clustered in
 * two places: `isAlignRow`'s emptiness guard, and the scanning loop's three
 * bounds (`i + 1 < lines.length`, the `i + 2` data start, and the run-end
 * test). Those decide whether a table is FOUND at all, and where its rows
 * stop — a mutant there either loses the table the engine returned or runs
 * past it into prose, and the answer card renders the difference.
 *
 * Run: `node --test test/answerTableGrammar.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { parseMarkdownTable } = await import("../src/lib/answerTable.ts");

const TABLE = ["| Region | Amount |", "| --- | --- |", "| NE | 10 |", "| NW | 20 |"].join("\n");

// --- the happy shape, so the bounds below have a baseline -------------------

test("a plain table parses to its header and every data row", () => {
  const t = parseMarkdownTable(TABLE);
  // tableCells strips the outer pipes, so there are no empty edge cells.
  assert.deepEqual(t.header, ["Region", "Amount"]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], ["NE", "10"]);
  assert.deepEqual(t.rows[1], ["NW", "20"]);
});

// --- the alignment row IS the thing that makes it a table -------------------

test("a pipe block with NO alignment row is not a table", () => {
  const md = ["| Region | Amount |", "| NE | 10 |"].join("\n");
  assert.equal(parseMarkdownTable(md), null);
});

test("every alignment variant is accepted: ---, :---, ---:, :---:", () => {
  for (const align of ["| --- | --- |", "| :--- | ---: |", "| :---: | :---: |", "| ---- | --- |"]) {
    const md = ["| a | b |", align, "| 1 | 2 |"].join("\n");
    assert.ok(parseMarkdownTable(md), `rejected a valid alignment row: ${align}`);
  }
});

test("two dashes is NOT an alignment row — the grammar wants three", () => {
  const md = ["| a | b |", "| -- | -- |", "| 1 | 2 |"].join("\n");
  assert.equal(parseMarkdownTable(md), null);
});

test("a row of empty cells is not an alignment row", () => {
  // `cells.length > 0 && cells.every(...)`: `every` is vacuously true on an
  // empty list, so without the length guard an empty line would qualify and
  // any two consecutive lines could open a table.
  const md = ["| a | b |", "", "| 1 | 2 |"].join("\n");
  assert.equal(parseMarkdownTable(md), null);
});

test("a mixed row where only SOME cells are dashes is not an alignment row", () => {
  const md = ["| a | b |", "| --- | nope |", "| 1 | 2 |"].join("\n");
  assert.equal(parseMarkdownTable(md), null);
});

// --- where the scan starts and stops ----------------------------------------

test("a table at the very start of the markdown is found", () => {
  // The loop starts at i = 0; an off-by-one start would skip it.
  assert.ok(parseMarkdownTable(TABLE), "index 0 is scanned");
});

test("a table after prose is found, and the prose is not part of it", () => {
  const md = ["Here are the results.", "", TABLE].join("\n");
  const t = parseMarkdownTable(md);
  assert.deepEqual(t.header, ["Region", "Amount"]);
  assert.equal(t.rows.length, 2);
});

test("data rows stop at the first non-pipe line, never running into prose", () => {
  const md = [TABLE, "", "That is the summary.", "| not | part |"].join("\n");
  const t = parseMarkdownTable(md);
  assert.equal(t.rows.length, 2, "the blank line ended the run");
  assert.ok(!JSON.stringify(t.rows).includes("part"), "the later pipe row is a different block");
});

test("the row run starts AFTER the alignment row, never including it", () => {
  const t = parseMarkdownTable(TABLE);
  const flat = JSON.stringify(t.rows);
  assert.ok(!flat.includes("---"), "the alignment row is not a data row");
});

test("a header with an alignment row but no data rows parses as an empty-row table", () => {
  const md = ["| a | b |", "| --- | --- |"].join("\n");
  const t = parseMarkdownTable(md);
  assert.deepEqual(t.header, ["a", "b"]);
  assert.deepEqual(t.rows, [], "a header-only table is still a table");
});

test("a lone pipe line at the very end cannot open a table past the buffer", () => {
  // `i + 1 < lines.length` guards the lookahead; loosening it would read
  // undefined for the alignment row.
  assert.equal(parseMarkdownTable("| a | b |"), null);
  assert.doesNotThrow(() => parseMarkdownTable("| a | b |"));
});

test("the FIRST table wins when the markdown holds two", () => {
  const second = ["| X | Y |", "| --- | --- |", "| 9 | 9 |"].join("\n");
  const t = parseMarkdownTable([TABLE, "", second].join("\n"));
  assert.ok(JSON.stringify(t.header).includes("Region"), "the first table, not the second");
});

test("no table at all is null, and empty input does not throw", () => {
  assert.equal(parseMarkdownTable("just prose, no pipes"), null);
  assert.equal(parseMarkdownTable(""), null);
});

test("leading whitespace before the pipe still opens a table", () => {
  const md = ["   | a | b |", "   | --- | --- |", "   | 1 | 2 |"].join("\n");
  const t = parseMarkdownTable(md);
  assert.ok(t, "the grammar trims before testing for the pipe");
  assert.equal(t.rows.length, 1);
});
