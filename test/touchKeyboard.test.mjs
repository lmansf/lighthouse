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
  // Rust constants — the tier that answers on iPhones/iPads.
  assert.match(llmRs, /const ON_DEVICE_CTX_BLOCK_MAX_CHARS: usize = 3_500;/);
  assert.match(llmRs, /const ON_DEVICE_CTX_TOTAL_MAX_CHARS: usize = 5_000;/);
  assert.match(llmRs, /const ON_DEVICE_HISTORY_MAX_CHARS: usize = 2_000;/);
  // The clamps take the tier as an argument (pure, testable) and the ONE
  // production call site reads the process-global backend flag.
  assert.match(llmRs, /fn clamp_local_contexts\(contexts: &\[Ctx\], on_device: bool\)/);
  assert.match(llmRs, /fn clamp_local_history\(history: &\[ChatTurn\], on_device: bool\)/);
  assert.match(
    llmRs,
    /let on_device = crate::local_model::on_device_backend\(\);\s*\n\s*let contexts = clamp_local_contexts\(contexts, on_device\);\s*\n\s*let history = clamp_local_history\(history, on_device\);/,
    "stream_local resolves the tier once and threads it through both clamps",
  );
  // Doc-focus budgets follow the tier too.
  assert.match(
    llmRs,
    /_ => local_ctx_total_max\(crate::local_model::on_device_backend\(\)\),/,
    "full-doc budget follows the active local tier",
  );
});

test("TS twin mirrors the on-device doc budgets (PARITY with llm.rs)", () => {
  assert.match(llmTs, /import \{ onDeviceBackend \} from "\.\/localModel";/);
  assert.match(
    llmTs,
    /return onDeviceBackend\(\) \? 5_000 : 11_000;/,
    "fullDocCharBudget mirrors ON_DEVICE_CTX_TOTAL_MAX_CHARS / LOCAL_CTX_TOTAL_MAX_CHARS",
  );
  assert.match(
    llmTs,
    /return onDeviceBackend\(\) \? 3_000 : 5_500;/,
    "docSegmentCharBudget mirrors the Rust segment arms",
  );
  // Cross-engine number lock: the TS on-device numbers must equal the Rust
  // ones, so a future retune can't move one engine without the other.
  const rsTotal = llmRs.match(/ON_DEVICE_CTX_TOTAL_MAX_CHARS: usize = (\d[\d_]*)/)?.[1];
  const rsSegment = llmRs.match(/if crate::local_model::on_device_backend\(\) \{\s*\n\s*(\d[\d_]*)\s*\n\s*\} else \{\s*\n\s*5_500/)?.[1];
  assert.equal(rsTotal, "5_000", "Rust on-device total is the number TS mirrors");
  assert.equal(rsSegment, "3_000", "Rust on-device segment is the number TS mirrors");
});
