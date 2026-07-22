/**
 * 0.14.0 (§31 §1) pins: the Apple-feel token layer — SF-first type on the HIG
 * scale in rem over the Dynamic Type root hook, semantic pairs, glass +
 * reduce-transparency plumbing, and the touch-feel primitives. Source pins in
 * the house style (theme.ts imports Fluent, so it can't load under node);
 * live behavior is verified in the §7 gates.
 *
 * Run: `node --test test/appleTokens.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const theme = read("src/shell/theme.ts");
const globals = read("app/globals.css");

test("SF wins on Apple platforms: -apple-system leads, Segoe UI Variable is gone", () => {
  const stack = theme.match(/const FONT_STACK =\s*\n?\s*'([^']+)'/)?.[1] ?? "";
  assert.ok(stack.startsWith("-apple-system"), "-apple-system is first");
  assert.ok(!stack.includes("Segoe UI Variable"), "the Variable face no longer outranks SF");
  for (const fam of ["system-ui", '"Segoe UI"', "Roboto"]) {
    assert.ok(stack.includes(fam), `${fam} stays as the honest fallback`);
  }
  // The pre-hydration frame uses the IDENTICAL stack (the sync the comments demand).
  assert.ok(globals.includes(`font-family: ${stack};`), "globals.css body matches FONT_STACK byte-for-byte");
});

test("the HIG scale rides rem on a 17pt base — Body is 1rem, tokens divide by 17", () => {
  assert.match(theme, /const rem = \(px: number\) => `\$\{Math\.round\(\(px \/ 17\) \* 10000\) \/ 10000\}rem`;/);
  assert.match(theme, /fontSizeBase300: rem\(17\)/, "Base300 IS the 17pt Body");
  assert.match(theme, /lineHeightBase300: rem\(22\)/, "Body line height 22");
  assert.match(theme, /fontSizeBase200: rem\(13\)/, "Footnote 13");
  assert.match(theme, /fontSizeBase400: rem\(20\)/, "Title3 20");
  assert.match(theme, /fontSizeBase600: rem\(28\)/, "Title1 28");
  // Both themes adopt the scale (spread once per theme object).
  assert.equal((theme.match(/\.\.\.TYPE_TOKENS,/g) ?? []).length, 2, "Paper AND Ink spread TYPE_TOKENS");
});

test("the Dynamic Type hook: -apple-system-body on :root behind @supports, no severing px", () => {
  const hook = globals.match(/@supports \(font: -apple-system-body\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(hook.includes("font: -apple-system-body;"), "the root rides the OS body style on WebKit");
  assert.ok(!/font-size/.test(hook), "no explicit size inside the hooked branch (it would sever the link)");
  // Elsewhere the root is 106.25% (= 17px of a 16px default), keeping 1rem = Body.
  assert.match(globals, /font-size: 106\.25%;/);
});

test("scaleTheme scales rem tokens too — fontScale survives the rem migration", () => {
  assert.match(theme, /v\.endsWith\("rem"\) \? "rem" : v\.endsWith\("px"\) \? "px" : null/);
  assert.match(theme, /^\s*if \(\/\^\(fontSizeBase\|fontSizeHero\|lineHeight\)\/\.test\(key\)\)/m);
});

test("the radius scale is 8/12/16 in Fluent + sheet/capsule vars in globals", () => {
  assert.match(theme, /borderRadiusMedium: "8px"/);
  assert.match(theme, /borderRadiusLarge: "12px"/);
  assert.match(theme, /borderRadiusXLarge: "16px"/);
  assert.match(globals, /--lh-radius-sheet: 26px;/);
  assert.match(globals, /--lh-capsule: 999px;/);
  assert.match(globals, /--lh-radius-concentric: calc\(var\(--lh-parent-radius\) - var\(--lh-gap\)\);/);
});

test("semantic pairs exist for BOTH themes and dark is base-vs-elevated, not inverted", () => {
  for (const v of ["--lh-bg:", "--lh-bg-secondary:", "--lh-bg-grouped:", "--lh-bg-elevated:", "--lh-label:", "--lh-label-quaternary:", "--lh-separator:", "--lh-fill:", "--lh-tint:"]) {
    assert.equal((globals.match(new RegExp(v, "g")) ?? []).length, 2, `${v} declared in Paper and Ink`);
  }
  const dark = globals.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(dark.includes("--lh-bg: #0E0F12"), "dark base is the ink canvas");
  assert.ok(dark.includes("--lh-bg-elevated: #1E2126"), "elevated dark is LIGHTER than base");
});

test("glass: level var + reduce-transparency override forces solid, PRM keeps fades", () => {
  assert.match(globals, /--lh-glass-level: 1;/);
  const rt = globals.match(/:root\[data-reduce-transparency="true"\] \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(rt.includes("--lh-glass-level: 0"), "OS setting zeroes the glass");
  assert.ok(rt.includes("--lh-glass-blur: 0px"), "…and the blur");
  const prm = globals.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(prm.includes("--lh-dur: 0.01ms"), "movement collapses under PRM");
  assert.ok(!prm.includes("--lh-dur-fade"), "fades keep their duration — they ARE the PRM vocabulary");
});

test("touch feel: tap-highlight off, manipulation on controls, press class behind hover:none", () => {
  assert.match(globals, /-webkit-tap-highlight-color: transparent;/);
  assert.match(globals, /touch-action: manipulation;/);
  const press = globals.match(/@media \(hover: none\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(press.includes(".lh-press:active"), "press feedback only where hover doesn't exist");
  assert.ok(press.includes("scale(0.97)"), "the §31 press compression");
});

test("squircle is progressive enhancement only — behind @supports + an opt-in class", () => {
  const sq = globals.match(/@supports \(corner-shape: squircle\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(sq.includes(".lh-squircle"), "opt-in class, not a global restyle");
});

test("glass intensity is CLIENT-side: clamped in the store, never sent to the engine", () => {
  const store = read("src/stores/useAppearanceStore.ts");
  assert.match(store, /Math\.min\(1, Math\.max\(0, v\)\)/, "0..1 clamp");
  // The engine POST names exactly the three whitelisted keys — glass stays out.
  assert.match(
    store,
    /appearance: \{ accent: next\.accent, density: next\.density, fontScale: next\.fontScale \}/,
    "the settings POST carries only engine-whitelisted keys",
  );
  const spec = read("src/lib/appearanceSpec.ts");
  assert.ok(!spec.includes("glass"), "the engine/twin whitelist is untouched");
});

test("reduce-transparency + haptics ride the shell: command, plugin, capability, stamps", () => {
  assert.match(read("src/shell/systemAppearance.ts"), /invoke<boolean>\("reduce_transparency"\)/);
  const providers = read("app/providers.tsx");
  assert.match(providers, /--lh-glass-level/, "providers stamp the level");
  assert.match(providers, /dataset\.reduceTransparency = "true"/, "providers stamp the OS attribute");
  assert.match(providers, /visibilitychange/, "re-read on return to foreground");
  const commands = read("native/crates/lighthouse-desktop/src/commands.rs");
  assert.match(commands, /pub fn reduce_transparency\(\) -> bool/);
  assert.match(commands, /accessibilityDisplayShouldReduceTransparency/, "macOS leg");
  assert.match(commands, /UIAccessibilityIsReduceTransparencyEnabled/, "iOS leg");
  assert.match(read("native/crates/lighthouse-desktop/src/lib.rs"), /commands::reduce_transparency,/);
  assert.match(read("native/crates/lighthouse-desktop/src/lib.rs"), /#\[cfg\(mobile\)\]\s*\n\s*let builder = builder\.plugin\(tauri_plugin_haptics::init\(\)\);/);
  const cap = JSON.parse(read("native/crates/lighthouse-desktop/capabilities/mobile.json"));
  assert.deepEqual(cap.platforms, ["iOS", "android"]);
  assert.ok(cap.permissions.includes("haptics:allow-selection-feedback"));
  assert.ok(cap.permissions.includes("haptics:allow-impact-feedback"));
  // The UI wrapper invokes the plugin's verified command names directly.
  const haptics = read("src/shell/haptics.ts");
  assert.match(haptics, /plugin:haptics\|selection_feedback/);
  assert.match(haptics, /\{ style: "light" \}/);
  assert.match(haptics, /platformKind\(\) === "ios"/, "iOS-only by design");
});
