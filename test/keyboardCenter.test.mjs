/**
 * §45: keyboard-aware follow-up centering. The trigger is a PURE verdict fn —
 * center the transcript above the keyboard ONLY on a touch phone with the
 * keyboard up and no ask in flight — so it is a table these fixtures pin. The
 * ChatPanel wiring (drives the transcript bodyRef, never window; debounced to
 * the viewport settling; reuses the instant writeScrollTop) is source-pinned,
 * chartIt-style, since the effect can't run in node.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { keyboardCenterVerdict } = await import("../src/features/chat/keyboardCenter.ts");

// The one shape that centers: a compact, coarse phone, keyboard up, settled.
const CENTER = { compact: true, coarse: true, keyboardUp: true, streaming: false };

test("centers ONLY on a compact + coarse phone with the keyboard up and settled", () => {
  assert.equal(keyboardCenterVerdict(CENTER), true, "the phone follow-up case centers");
});

test("desktop / iPad-regular (not compact) never center — the desktop pin", () => {
  assert.equal(keyboardCenterVerdict({ ...CENTER, compact: false }), false);
});

test("a fine pointer never centers — no software keyboard to clear", () => {
  assert.equal(keyboardCenterVerdict({ ...CENTER, coarse: false }), false);
});

test("keyboard down never centers", () => {
  assert.equal(keyboardCenterVerdict({ ...CENTER, keyboardUp: false }), false);
});

test("DURING streaming the read-from-top hold owns scroll — no centering", () => {
  assert.equal(keyboardCenterVerdict({ ...CENTER, streaming: true }), false);
});

// --- ChatPanel wiring (source pins — the effect can't run in node) -----------

test("the centering effect is gated by the verdict on compact+coarse+keyboardUp+!streaming", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(
    chat,
    /keyboardCenterVerdict\(\{\s*\n\s*compact: compactLayout,\s*\n\s*coarse: coarsePointer,\s*\n\s*keyboardUp: shellUi\.keyboardUp,/,
    "the verdict reads the compact + coarse + keyboardUp inputs",
  );
  assert.match(chat, /streaming,\s*\n\s*\}\)\s*\n\s*\) \{\s*\n\s*return;/, "streaming gates the verdict");
});

test("the effect drives the transcript (bodyRef) with the instant writeScrollTop, never window", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  const start = chat.indexOf("§45: keyboard-aware follow-up centering");
  const end = chat.indexOf(
    "}, [compactLayout, coarsePointer, shellUi.keyboardUp, streaming, writeScrollTop]);",
  );
  assert.ok(start >= 0 && end > start, "the centering effect is present");
  const effect = chat.slice(start, end);
  assert.match(effect, /const el = bodyRef\.current;/, "targets the transcript container");
  assert.match(effect, /writeScrollTop\(el,/, "reuses the instant programmatic scroll (reduced-motion safe)");
  assert.ok(!/window\.scroll/.test(effect), "never scrolls window on compact (AppShell owns the unwedge)");
  assert.match(effect, /window\.setTimeout\(center, 250\)/, "centers after the ~250ms keyboard animation");
  assert.match(effect, /vv\?\.addEventListener\("resize", center\)/, "re-centers as the viewport settles");
  assert.match(effect, /keyboardInsetRef\.current/, "positions above the numeric keyboard inset");
});

test("the numeric keyboard inset rides the shell bus for the centering math", () => {
  assert.match(read("src/shell/shellSignals.ts"), /keyboardInset: number;/, "ShellUi carries the numeric inset");
  assert.match(read("src/shell/AppShell.tsx"), /keyboardInset,\s*\n\s*\}\);/, "AppShell publishes it");
});
