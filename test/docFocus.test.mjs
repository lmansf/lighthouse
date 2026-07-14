/**
 * Unit tests for the single-document focus helpers (src/server/synth.ts):
 * dominance detection over the initial hits, ordered segment partitioning,
 * and even segment sampling for the honesty note. The Rust twins
 * (lighthouse-core/src/synth.rs) mirror these cases — keep the fixtures
 * aligned so both engines behave identically.
 *
 * Run: `node --test test/docFocus.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { dominantDoc, partitionSegments, sampleSegments } = await import("../src/server/synth.ts");

const r = (fileId, name, score) => ({ fileId, name, snippet: "", score });

test("dominance requires four of five hits from one referenced file", () => {
  const refs = [r("a", "sop.docx", 0.9), r("b", "other.md", 0.5)];
  // 4/5 from one file → dominant.
  assert.deepEqual(
    dominantDoc(["sop.docx", "sop.docx", "sop.docx", "sop.docx", "other.md"], refs),
    ["a", "sop.docx"],
  );
  // 3/5 → not dominant.
  assert.equal(
    dominantDoc(["sop.docx", "sop.docx", "sop.docx", "other.md", "other.md"], refs),
    null,
  );
  // Too few hits overall → never dominant.
  assert.equal(dominantDoc(["sop.docx", "sop.docx", "sop.docx"], refs), null);
  // A display name shared by TWO referenced files is ambiguous.
  const dup = [r("a", "sop.docx", 0.9), r("z", "sop.docx", 0.8)];
  assert.equal(
    dominantDoc(["sop.docx", "sop.docx", "sop.docx", "sop.docx", "sop.docx"], dup),
    null,
  );
});

test("segments partition in order within budget", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(99)}`);
  // 100-char chunks, 350 budget → 3 per segment (300 + 2×2 sep = 304).
  const segs = partitionSegments(chunks, 350);
  assert.equal(segs.length, 4, `${segs.map((s) => s.length)}`);
  assert.ok(segs.every((s) => s.length <= 350));
  // Order preserved: first segment starts with chunk 0, last ends with 9.
  assert.ok(segs[0].startsWith("0"));
  assert.ok(segs[3].includes("9"));
  // A single over-budget chunk still lands in its own segment.
  assert.equal(partitionSegments(["y".repeat(500)], 350).length, 1);
  // Empty in, empty out.
  assert.deepEqual(partitionSegments([], 350), []);
});

test("sampling keeps ends and reports total", () => {
  const segs = Array.from({ length: 23 }, (_, i) => String(i));
  const [kept, total] = sampleSegments(segs, 8);
  assert.equal(total, 23);
  assert.equal(kept.length, 8);
  assert.equal(kept[0], "0");
  assert.equal(kept[kept.length - 1], "22");
  // Strictly increasing (no duplicates).
  const idxs = kept.map(Number);
  assert.ok(idxs.every((v, i) => i === 0 || idxs[i - 1] < v), `${idxs}`);
  // Fits already → untouched.
  const [all, allTotal] = sampleSegments(segs, 23);
  assert.deepEqual([all.length, allTotal], [23, 23]);
});
