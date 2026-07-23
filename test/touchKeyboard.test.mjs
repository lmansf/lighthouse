/**
 * iPhone/iPad keyboard layout truth (0.13.9 field screenshot IMG_1669).
 *
 * Tauri's iOS WKWebView RESIZES for the on-screen keyboard instead of
 * overlaying it the way Safari does, so the visualViewport inset math reads 0
 * with the keyboard up: the compact tab bar floated mid-screen under the
 * keyboard's accessory bar, iOS's focus reveal-scroll wedged the fixed shell
 * under the status bar, and the bare <textarea> painted WebKit's UA chrome as
 * a second box inside the composer shell. On the same report, the on-device
 * private model (Apple Foundation Models, 4096-token window shared between
 * prompt and answer) was fed the desktop 6144-token packing, leaving it a few
 * hundred tokens to answer in.
 *
 * These are DOM-wiring and engine-constant guarantees; like the sibling
 * touchZoom tests they are pinned structurally against the sources.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const shell = read("src/shell/AppShell.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const llmRs = read("native/crates/lighthouse-core/src/llm.rs");
const llmTs = read("src/server/llm.ts");
const budgetRs = read("native/crates/lighthouse-core/src/budget.rs");
const budgetTs = read("src/server/budget.ts");

test("keyboard detection survives resize-mode WKWebViews: editable focus hides the tab bar", () => {
  // The overlay-mode inset math stays (it pads the main column on webviews
  // that DON'T resize), but the bar-hiding signal must not depend on it.
  assert.match(
    shell,
    /const tabBarHidden = keyboardInset > 0 \|\| editableFocused \|\| sheetOpen;/,
    "tab bar hides on editable focus, not only on a non-zero inset",
  );
  assert.match(shell, /document\.addEventListener\("focusin", onFocusIn\);/, "focusin tracked");
  assert.match(shell, /document\.addEventListener\("focusout", onFocusOut\);/, "focusout tracked");
  assert.match(
    shell,
    /document\.removeEventListener\("focusin", onFocusIn\);[\s\S]{0,80}document\.removeEventListener\("focusout", onFocusOut\);/,
    "listeners are cleaned up",
  );
  // Buttons/checkboxes take focus too but never summon a keyboard — they must
  // not count as editable, or tapping them would hide the bar for nothing.
  assert.match(
    shell,
    /\["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"\]\.includes\(/,
    "non-text input types are excluded from the editable check",
  );
  // Field-to-field hops settle after the focus move (no bar flicker).
  assert.match(
    shell,
    /requestAnimationFrame\(\(\) => setEditableFocused\(editable\(document\.activeElement\)\)\)/,
    "focusout re-reads the active element after the move settles",
  );
});

test("the iOS reveal-scroll wedge is pushed back: the compact shell owns (0,0)", () => {
  // iOS scrolls the WKScrollView to reveal a focused field and leaves the
  // offset behind; the fixed shell then renders shifted under the status bar.
  // The shell never scrolls the document on compact, so any offset is the
  // wedge and gets zeroed.
  assert.match(
    shell,
    /if \(window\.scrollY !== 0 \|\| window\.scrollX !== 0\) window\.scrollTo\(0, 0\);/,
    "non-zero document scroll is reset to the origin",
  );
  assert.match(
    shell,
    /window\.addEventListener\("scroll", unwedge, \{ passive: true \}\);/,
    "the wedge counter listens for document scroll (passively)",
  );
  assert.match(
    shell,
    /window\.visualViewport\?\.addEventListener\("resize", unwedge\);/,
    "keyboard show/hide (viewport resize) also re-checks the wedge",
  );
  // Both new effects are compact-only: desktop keeps zero listeners.
  const compactGates = shell.match(/if \(!layout\.compact \|\| typeof (document|window) === "undefined"\) return;/g) ?? [];
  assert.ok(
    compactGates.length >= 2,
    `editable-focus and unwedge effects gate on layout.compact (found ${compactGates.length})`,
  );
});

test("the composer textarea slot paints nothing of its own — on every platform", () => {
  // iOS WKWebView gives a bare <textarea> UA chrome (white fill, hairline
  // border) unless appearance is stripped; the composer shell is the ONE box.
  const slot = chat.slice(chat.indexOf("composerField:"), chat.indexOf("ghostWrap:"));
  assert.match(slot, /WebkitAppearance: "none"/, "WebKit UA chrome stripped");
  assert.match(slot, /appearance: "none"/, "standard appearance stripped");
  assert.match(slot, /backgroundColor: "transparent"/, "slot has no fill of its own");
  assert.match(
    slot,
    /borderTopStyle: "none",\s*\n\s*borderRightStyle: "none",\s*\n\s*borderBottomStyle: "none",\s*\n\s*borderLeftStyle: "none"/,
    "slot has no border of its own",
  );
  assert.match(slot, /outlineStyle: "none"/, "slot has no outline of its own");
});

test("on-device tier: the engine packs for Apple FM's 4096-token shared window", () => {
  // §32 §1: the numbers moved into the tiered budgeter — the apple-fm arms
  // carry the 0.13.10 on-device packing (behavioral pin in budget.test.mjs
  // and the cargo tests; this is the source pin tying it to the iOS report).
  assert.match(
    budgetRs,
    /Tier::AppleFm4096 \| Tier::AppleFm8192 => SegmentBudgets \{\s*\n\s*ctx_block_max: 3_500,\s*\n\s*ctx_total_max: 5_000,\s*\n\s*history_max: 2_000,/,
    "apple-fm segment budgets pack for the shared window",
  );
  // The clamps take the tier as an argument (pure, testable) and the ONE
  // production call site resolves it from the backend flag (+ force rig).
  assert.match(llmRs, /fn clamp_local_contexts\(contexts: &\[Ctx\], tier: Tier\)/);
  assert.match(llmRs, /fn clamp_local_history\(history: &\[ChatTurn\], tier: Tier\)/);
  assert.match(
    llmRs,
    /let tier = local_tier\(\);\s*\n\s*let contexts = clamp_local_contexts\(contexts, tier\);\s*\n\s*let history = clamp_local_history\(history, tier\);/,
    "stream_local resolves the tier once and threads it through both clamps",
  );
  // Doc-focus budgets follow the tier too.
  assert.match(
    llmRs,
    /_ => budget::segment_budgets\(local_tier\(\)\)\.ctx_total_max,/,
    "full-doc budget follows the active local tier",
  );
});

test("TS twin mirrors the on-device doc budgets (PARITY with llm.rs)", () => {
  assert.match(llmTs, /from "\.\/budget";/, "llm.ts reads the shared tier tables");
  assert.match(
    llmTs,
    /return segmentBudgets\(localTier\(\)\)\.ctxTotalMax;/,
    "fullDocCharBudget follows the active local tier's total",
  );
  assert.match(
    llmTs,
    /return docSegmentBudget\(localTier\(\)\);/,
    "docSegmentCharBudget follows the active local tier's segment arm",
  );
  // Cross-engine number lock: the TS apple-fm numbers must equal the Rust
  // ones, so a future retune can't move one engine without the other.
  assert.match(
    budgetTs,
    /case "apple-fm-4096":\s*\n\s*case "apple-fm-8192":\s*\n\s*return \{ ctxBlockMax: 3_500, ctxTotalMax: 5_000, historyMax: 2_000 \};/,
    "TS apple-fm segment budgets equal the Rust arm",
  );
  // §42: the mobile llama tier shares the on-device doc-segment arm, so the
  // apple arms now read `AppleFm4096 | AppleFm8192 | LlamaMobile6144 => 3_000`
  // (Rust) / three stacked cases (TS). The pin still locks the NUMBER across
  // engines; the regex just tolerates the added arm before the llama-6144 case.
  const rsSegment = budgetRs.match(
    /Tier::AppleFm4096 \| Tier::AppleFm8192 \| Tier::LlamaMobile6144 => (\d[\d_]*),\s*\n\s*Tier::Llama6144 => 5_500,/,
  )?.[1];
  const tsSegment = budgetTs.match(
    /case "apple-fm-8192":\s*\n\s*case "llama-mobile-6144":\s*\n\s*return (\d[\d_]*);\s*\n\s*case "llama-6144":\s*\n\s*return 5_500;/,
  )?.[1];
  assert.equal(rsSegment, "3_000", "Rust on-device doc segment is the number TS mirrors");
  assert.equal(tsSegment, "3_000", "TS on-device doc segment equals the Rust arm");
});
