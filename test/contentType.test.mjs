/**
 * §35 §1: the CONTENT type scale — answers read at 16px/24px (the pre-#203
 * intent, restored) on a named token pair, with a weight-and-space heading
 * ramp clamped against Dynamic Type inversion. Chrome stays on the HIG ramp
 * untouched. Values are unit-tested off the real theme export; the renderer
 * wiring is source-pinned (the chartIt house style).
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
const chat = read("src/features/chat/ChatPanel.tsx");
const theme = read("src/shell/theme.ts");

test("content tokens: 16px body on a 24px leading, rem so Dynamic Type scales 1:1", () => {
  // theme.ts can't load in node (Fluent ESM interop), so the pin is the
  // SOURCE: the named px intents, expressed through the same rem() the whole
  // theme uses (÷ the 17px root at render time).
  const block = theme.slice(theme.indexOf("export const CONTENT_TYPE"), theme.indexOf("} as const;"));
  assert.match(block, /body: rem\(16\),/);
  assert.match(block, /bodyLineHeight: rem\(24\),/);
  assert.match(block, /h1: rem\(20\),/);
  assert.match(block, /h2: rem\(17\.5\),/);
  assert.match(block, /h3: rem\(16\),/, "h3/h4 = body size — weight carries the hierarchy");
  // AX clamps: ceilings descend with the ramp so no level can invert another.
  assert.match(block, /h1Max: "28px",/);
  assert.match(block, /h2Max: "24px",/);
  assert.match(block, /h3Max: "22px",/);
  assert.match(block, /tableCellCompact: rem\(13\),/);
});

test("chrome stays on the HIG ramp — content tokens are additive, not a remap", () => {
  assert.match(theme, /fontSizeBase300: rem\(17\),/, "UI base300 untouched");
  assert.match(theme, /fontSizeBase400: rem\(20\),/, "UI base400 untouched");
});

test("the answer container reads on the content tokens with clamped headings", () => {
  assert.match(chat, /fontSize: CONTENT_TYPE\.body,\s*\n\s*lineHeight: CONTENT_TYPE\.bodyLineHeight,/);
  for (const level of ["h1", "h2", "h3"]) {
    assert.match(
      chat,
      new RegExp(`min\\(\\$\\{CONTENT_TYPE\\.${level}\\}, \\$\\{CONTENT_TYPE\\.${level}Max\\}\\)`),
      `${level} carries the Dynamic Type clamp`,
    );
  }
  // Weight + space hierarchy: 1.25em above, 0.4em below, semibold h3/h4.
  assert.match(chat, /marginTop: "1\.25em",\s*\n\s*marginBottom: "0\.4em",/);
  assert.match(chat, /fontWeight: tokens\.fontWeightSemibold,\s*\n\s*\},/);
  // Rhythm: 0.75em paragraphs, 20px list gutter, 5px item gaps.
  assert.match(chat, /"& p": \{ marginTop: 0, marginBottom: "0\.75em", maxWidth: "72ch" \}/);
  assert.match(chat, /paddingLeft: "20px",/);
  assert.match(chat, /"& li": \{ marginBottom: "5px", lineHeight: CONTENT_TYPE\.bodyLineHeight \}/);
});

test("compact measure: 16px side padding + smaller data cells, wired at both mounts", () => {
  assert.match(
    chat,
    /answerCompact: \{\s*\n\s*paddingLeft: "16px",\s*\n\s*paddingRight: "16px",\s*\n\s*"& th, & td": \{ fontSize: CONTENT_TYPE\.tableCellCompact \},/,
  );
  const wired = chat.match(/compactLayout && styles\.answerCompact/g) ?? [];
  assert.equal(wired.length, 2, "the answer AND sqlResult mounts both gate the compact measure");
  // A panning table stays contained (fp3 §2's rule still holds).
  assert.match(chat, /overscrollBehaviorX: "contain",/);
});

test("Dynamic Type end-to-end: no legacy inflation, live re-resolve on iOS", () => {
  assert.match(read("app/globals.css"), /-webkit-text-size-adjust: 100%;/, "the third multiplier is dead");
  const swift = read(
    "native/crates/lighthouse-desktop/gen/apple/Sources/lighthouse-desktop/ContentSizeObserver.swift",
  );
  assert.match(swift, /UIContentSizeCategory\.didChangeNotification/, "the observer watches the real signal");
  assert.match(swift, /@objc\(LHContentSizeObserver\)/, "ObjC-visible (the dead-strip-proof lookup)");
  assert.match(swift, /webView\.reload\(\)/, "a reload is the size re-resolve");
  // §40 crate split: the observer-start body lives in tauri-free lighthouse-shell.
  const commands = read("native/crates/lighthouse-shell/src/commands.rs");
  assert.match(commands, /objc_getClass\(b"LHContentSizeObserver\\0"/, "Rust starts it via the runtime idiom");
  assert.match(read("native/crates/lighthouse-desktop/src/lib.rs"), /start_content_size_observer\(\);/, "started at iOS boot");
});
