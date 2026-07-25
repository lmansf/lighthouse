// The Reports composer's "build from a hidden spreadsheet" decision logic
// (§49, make-visible-and-keep). Pure, so it is unit-tested here directly —
// which table (if any) a report runs over after a hidden sheet is made visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { isSheetName, resolveSheetTable, SHEET_EXTS } = await import("../src/lib/reportTargets.ts");

test("isSheetName matches the engine's tabular extensions, case-insensitively", () => {
  for (const e of SHEET_EXTS) {
    assert.equal(isSheetName(`Q3 Sales${e}`), true, e);
    assert.equal(isSheetName(`Q3 Sales${e.toUpperCase()}`), true, `${e} upper`);
  }
  assert.equal(isSheetName("notes.docx"), false);
  assert.equal(isSheetName("report.pdf"), false);
  assert.equal(isSheetName("plain.txt"), false);
  assert.equal(isSheetName("no-extension"), false);
});

test("an investigable table for the sheet resolves to that table", () => {
  const map = [{ name: "q3_sales", investigable: true }];
  const r = resolveSheetTable("Q3 Sales.xlsx", map, []);
  assert.deepEqual(r, { table: "q3_sales" });
});

test("a profiled-but-unanalyzable sheet resolves to none (no empty report)", () => {
  const map = [{ name: "contacts", investigable: false }];
  const r = resolveSheetTable("contacts.csv", map, []);
  assert.deepEqual(r, { none: true });
});

test("a union/dedup rename falls back to the freshly-added investigable table", () => {
  // The sheet's own name (sales_2024 → sales_2024) isn't present, but making it
  // visible added an investigable table that wasn't there before.
  const before = ["orders"];
  const map = [
    { name: "orders", investigable: true }, // pre-existing
    { name: "sales", investigable: true }, // the union family the sheet joined
  ];
  const r = resolveSheetTable("sales-2024.csv", map, before);
  assert.deepEqual(r, { table: "sales" });
});

test("no new investigable table, but tables exist ⇒ none (honest note, not passthrough)", () => {
  const before = ["orders"];
  const map = [{ name: "orders", investigable: true }];
  const r = resolveSheetTable("mystery.xlsx", map, before);
  assert.deepEqual(r, { none: true });
});

test("an empty map (the web dev twin) resolves to unknown ⇒ let investigate throw", () => {
  const r = resolveSheetTable("anything.xlsx", [], []);
  assert.deepEqual(r, { unknown: true });
});

test("exact-name match wins over the fresh-table fallback", () => {
  // Both the sheet's own table and another new investigable table are present;
  // the exact match is preferred so we analyze the RIGHT sheet.
  const map = [
    { name: "budget", investigable: true }, // exact for budget.xlsx
    { name: "other", investigable: true },
  ];
  const r = resolveSheetTable("budget.xlsx", map, []);
  assert.deepEqual(r, { table: "budget" });
});
