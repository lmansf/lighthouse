/**
 * §33 §4: source files must be NUL-free. Three files carried a RAW 0x00 byte
 * inside template-literal separator strings (`\x00` typed as the actual byte),
 * which made ripgrep classify them as binary and silently stop searching —
 * sessions then falsely concluded anchors/handlers were missing. The bytes are
 * now the 4-char escape sequence (identical semantics); this tripwire keeps
 * every future source file greppable.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("no source file under src/ contains a raw NUL byte", () => {
  for (const file of walk(path.join(ROOT, "src"))) {
    const buf = readFileSync(file);
    assert.equal(
      buf.indexOf(0),
      -1,
      `${path.relative(ROOT, file)} contains a raw 0x00 byte — write the \\x00 escape instead (ripgrep treats the file as binary otherwise)`,
    );
  }
});

test("the mention/chips/egress separator keys kept their NUL semantics (as escapes)", () => {
  const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
  assert.match(read("src/features/chat/ChatPanel.tsx"), /\$\{mention\.start\}\\x00\$\{mention\.query\}/);
  assert.match(read("src/features/chat/useValidatedChips.ts"), /includedFileIds\.join\("\\x00"\)/);
  assert.match(read("src/features/egress/EgressShield.tsx"), /\$\{d\.host\}\\x00\$\{d\.purpose\}/);
});
