/**
 * Parity tests for structure-aware chunking (src/server/vault.ts →
 * chunkTextsNamed). THE FIXTURES ARE MIRRORED byte-for-byte in
 * lighthouse-core/src/vault.rs (mod chunk_tests) — tabular extracts chunk by
 * rows with header lines prepended; prose keeps the 120-word windows. If the
 * chunking rules change, update both suites together.
 *
 * Run: `node --test test/chunker.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { chunkTextsNamed } = await import("../src/server/vault.ts");

test("PARITY: csv rows chunk with header prepended (1-30 / 26-55 / 51-70)", () => {
  let text = "region,amount\n";
  for (let i = 1; i <= 70; i += 1) text += `r${i},${i}\n`;
  const chunks = chunkTextsNamed("sales.csv", text);
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.startsWith("region,amount\n"), c.slice(0, 40));
  assert.ok(chunks[0].endsWith("r30,30"));
  assert.ok(chunks[1].includes("r26,26") && chunks[1].endsWith("r55,55"));
  assert.ok(chunks[2].includes("r51,51") && chunks[2].endsWith("r70,70"));
});

test("PARITY: workbook blocks carry sheet + header lines into every chunk", () => {
  let text = "Sheet1\nh1,h2\na,1\nb,2\nc,3\n\nSheet2\nh1,h2\n";
  for (let i = 1; i <= 40; i += 1) text += `x${i},${i}\n`;
  const chunks = chunkTextsNamed("book.xlsx", text);
  assert.equal(chunks.length, 3); // sheet1: 1 chunk · sheet2: rows 1-30, 26-40
  assert.ok(chunks[0].startsWith("Sheet1\nh1,h2\n"));
  assert.ok(chunks[1].startsWith("Sheet2\nh1,h2\n") && chunks[1].endsWith("x30,30"));
  assert.ok(chunks[2].startsWith("Sheet2\nh1,h2\n") && chunks[2].endsWith("x40,40"));
});

test("PARITY: prose keeps 120-word windows with 95-word step", () => {
  const text = Array.from({ length: 300 }, (_, i) => `w${i + 1}`).join(" ");
  const chunks = chunkTextsNamed("notes.md", text);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].startsWith("w1 ") && chunks[0].endsWith("w120"));
});

test("parquet extracts route through the tabular chunker", () => {
  let text = "col_a,col_b\n";
  for (let i = 1; i <= 35; i += 1) text += `p${i},${i}\n`;
  const chunks = chunkTextsNamed("data.parquet", text);
  assert.equal(chunks.length, 2); // 1-30, 26-35
  assert.ok(chunks[1].startsWith("col_a,col_b\n"));
});
