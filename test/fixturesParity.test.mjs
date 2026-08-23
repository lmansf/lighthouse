/**
 * Tripwire: native/test-fixtures/ is a vendored byte-copy of test/fixtures/.
 *
 * The Rust suites read the vendored copy (workspace-relative), because tools
 * that copy only the cargo workspace — cargo-mutants above all — can't reach
 * the repo root. The TS suites read the root copy. This test keeps the two
 * literally identical, both directions, so neither side can drift.
 *
 * Run: `node --test test/fixturesParity.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(repo, "test", "fixtures");
const VENDORED = path.join(repo, "native", "test-fixtures");

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

test("native/test-fixtures is a byte-identical vendor of test/fixtures", () => {
  const a = walk(ROOT);
  const b = walk(VENDORED);
  assert.deepEqual(b, a, "same file set in both copies (add/remove in BOTH)");
  for (const rel of a) {
    const x = fs.readFileSync(path.join(ROOT, rel));
    const y = fs.readFileSync(path.join(VENDORED, rel));
    assert.ok(x.equals(y), `${rel}: vendored copy diverged — re-copy from test/fixtures`);
  }
});
