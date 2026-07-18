// Related-file chips + Synthesize (usability patch §3) — structural assertions
// against ChatPanel.tsx (JSX the node runner can't import) plus the cross-file
// synthesis engine hooks live in test/synth.cues.test.mjs. This pins the UI
// wiring: chips (not cards), middle-truncation, the "+N more" overflow, the
// Synthesize chip, and the one-shot scoped re-ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(ROOT, "src/features/chat/ChatPanel.tsx"), "utf8");

test("Related files render as compact chips, not cards", () => {
  assert.match(src, /className=\{styles\.refChipRow\}/);
  assert.match(src, /styles\.refChip,/);
  // Score shows as a percentage in the chip.
  assert.match(src, /· \{Math\.round\(r\.score \* 100\)\}%/);
  // Names are middle-truncated; the full name lives in the tooltip (title).
  assert.match(src, /middleTruncateName\(r\.name\)/);
  assert.match(src, /function middleTruncateName/);
});

test("overflow collapses behind a +N more toggle that a citation force-expands", () => {
  assert.match(src, /REF_CHIPS_COLLAPSED/);
  assert.match(src, /\+\{hidden\} more/);
  assert.match(src, /const forceExpand = expanded \|\| \(flashCite\?\.startsWith/);
});

test("a Synthesize chip re-asks scoped to the answer's files (>=2)", () => {
  assert.match(src, /onSynthesize && fileCount >= 2/);
  assert.match(src, /Synthesize\s*<\/button>/);
  // The handler re-asks the turn's question with a one-shot attachment scope.
  assert.match(src, /function synthesizeAcross/);
  assert.match(src, /attachmentsOverride: fileRefs\.map\(\(r\) => \(\{ id: r\.fileId \}\)\)/);
  // sendQuestion honours the one-shot override without disturbing the pills.
  assert.match(src, /opts\?\.attachmentsOverride \?\? attachments/);
  // Stable identity so the memoized <References> doesn't re-render per token.
  assert.match(src, /onSynthesize=\{onSynthesizeStable\}/);
});

test("click behaviors are preserved (preview primary, open-in-app secondary)", () => {
  assert.match(src, /onClick=\{\(\) => onPreview\(turnId, r\)\}/);
  assert.match(src, /className=\{`\$\{styles\.refChipOpen\} open-affordance`\}/);
});
