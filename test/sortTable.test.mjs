// Sortable result tables (src/lib/sortTable.ts) — the pure comparison + row
// reordering behind the clickable column headers on chat result tables. These
// tests pin the numeric-vs-text rules, blanks-last behavior, and the stable,
// non-mutating contract the ChatPanel renderer relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { sortRows, compareCells, parseNumericCell } = await import("../src/lib/sortTable.ts");

const labels = (rows) => rows.map((r) => r[0]);

test("parseNumericCell strips currency, thousands separators and percents", () => {
  assert.equal(parseNumericCell("$1,200"), 1200);
  assert.equal(parseNumericCell("1200"), 1200);
  assert.equal(parseNumericCell("3.5%"), 3.5);
  assert.equal(parseNumericCell("1 234 567"), 1234567); // space-separated thousands
  assert.equal(parseNumericCell("-42"), -42);
  assert.equal(parseNumericCell("N/A"), null); // not a number → text comparison
  assert.equal(parseNumericCell(""), null);
});

test("compareCells compares parsed numbers, not their text", () => {
  assert.ok(compareCells("$1,200", "3.5%") > 0); // 1200 > 3.5
  assert.equal(compareCells("1200", "$1,200"), 0); // equal by value
  assert.ok(compareCells("2", "10") < 0); // numeric, not lexical ("2" > "10")
});

test("compareCells falls back to case-insensitive, numeric-aware text order", () => {
  assert.ok(compareCells("apple", "Banana") < 0); // case-insensitive: a before b
  assert.ok(compareCells("item2", "item10") < 0); // numeric-aware within text
  assert.ok(compareCells("100", "apple") < 0); // one numeric, one text → locale
});

test("numeric sort understands mixed $1,200 / 1200 / 3.5% formats", () => {
  const rows = [
    ["region", "amount"],
    ["A", "$1,200"],
    ["B", "1200"],
    ["C", "3.5%"],
  ];
  // asc by value: 3.5 (C) < 1200 (A) = 1200 (B); the equal pair keeps A before B.
  assert.deepEqual(labels(sortRows(rows, 1, "asc")), ["region", "C", "A", "B"]);
  // desc: 1200 (A, then B by stability), then 3.5 (C).
  assert.deepEqual(labels(sortRows(rows, 1, "desc")), ["region", "A", "B", "C"]);
});

test("lexical sort is case-insensitive and numeric-aware, asc and desc", () => {
  const rows = [["label"], ["Item10"], ["item2"], ["ITEM1"]];
  assert.deepEqual(labels(sortRows(rows, 0, "asc")), ["label", "ITEM1", "item2", "Item10"]);
  assert.deepEqual(labels(sortRows(rows, 0, "desc")), ["label", "Item10", "item2", "ITEM1"]);
});

test("blank, dash and null cells sort last in BOTH directions", () => {
  const rows = [
    ["k", "v"],
    ["a", "10"],
    ["b", ""],
    ["c", "5"],
    ["d", "—"],
    ["e", "null"],
  ];
  // asc: 5 (c), 10 (a), then the three empties b, d, e in original order.
  assert.deepEqual(labels(sortRows(rows, 1, "asc")), ["k", "c", "a", "b", "d", "e"]);
  // desc: 10 (a), 5 (c), empties STILL last, still in original order.
  assert.deepEqual(labels(sortRows(rows, 1, "desc")), ["k", "a", "c", "b", "d", "e"]);
});

test("the header row stays pinned at the top", () => {
  // "header" would sort among the data if it weren't fixed — assert it doesn't.
  const rows = [["header"], ["zebra"], ["apple"]];
  assert.equal(sortRows(rows, 0, "asc")[0][0], "header");
  assert.equal(sortRows(rows, 0, "desc")[0][0], "header");
  assert.deepEqual(labels(sortRows(rows, 0, "asc")), ["header", "apple", "zebra"]);
});

test("sortRows does not mutate its input", () => {
  const rows = [
    ["k", "v"],
    ["a", "2"],
    ["b", "1"],
  ];
  const snapshot = JSON.stringify(rows);
  const out = sortRows(rows, 1, "asc");
  assert.equal(JSON.stringify(rows), snapshot); // input untouched
  assert.notEqual(out, rows); // fresh outer array
  assert.notEqual(out[1], rows[1]); // fresh row copies
  assert.deepEqual(labels(out), ["k", "b", "a"]);
});

test("equal keys keep their original relative order (stable)", () => {
  const rows = [
    ["id", "grp"],
    ["1", "x"],
    ["2", "x"],
    ["3", "x"],
    ["4", "x"],
  ];
  assert.deepEqual(labels(sortRows(rows, 1, "asc")), ["id", "1", "2", "3", "4"]);
  assert.deepEqual(labels(sortRows(rows, 1, "desc")), ["id", "1", "2", "3", "4"]);
});

test("header-only and empty tables come back as safe, unmutated copies", () => {
  const headerOnly = [["a", "b"]];
  const out = sortRows(headerOnly, 0, "asc");
  assert.deepEqual(out, [["a", "b"]]);
  assert.notEqual(out, headerOnly); // new array, not the same reference
  assert.deepEqual(sortRows([], 0, "asc"), []);
});
