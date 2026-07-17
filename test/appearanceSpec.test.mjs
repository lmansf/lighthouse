/**
 * Appearance customization + the ask-to-adjust directive (openspec:
 * add-usability-field-patch §3). The whitelist and the fenced-directive parser
 * ARE the safety boundary — a directive must map ONLY onto bounded enum keys
 * and can express no CSS/markup — so they're exercised for real here. The React
 * surfaces (Preferences, the theme application) load structurally in later UI
 * tests; this pins the pure spec.
 *
 * Run: `node --test test/appearanceSpec.test.mjs`
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

const spec = await import("../src/lib/appearanceSpec.ts");

// --- A. The whitelist normalizer -------------------------------------------

test("normalizeAppearance keeps valid enum keys and drops everything else", () => {
  assert.deepEqual(
    spec.normalizeAppearance({
      themePreset: "beam-dark",
      accent: "teal",
      density: "compact",
      fontScale: "l",
    }),
    { themePreset: "beam-dark", accent: "teal", density: "compact", fontScale: "l" },
  );
  // Unknown keys, out-of-vocabulary values, wrong types all dropped.
  assert.deepEqual(
    spec.normalizeAppearance({
      accent: "#ff0000", // free-form hex is NOT allowed
      density: "roomy", // out of vocabulary
      fontScale: 3, // wrong type
      customCss: "body{}", // unknown key — never honored
    }),
    {},
  );
  assert.deepEqual(spec.normalizeAppearance(null), {});
  assert.deepEqual(spec.normalizeAppearance("nope"), {});
});

test("the enums are the curated, bounded sets", () => {
  assert.deepEqual([...spec.THEME_PRESETS], ["beam-light", "beam-dark", "auto"]);
  assert.deepEqual([...spec.DENSITIES], ["comfortable", "compact"]);
  assert.deepEqual([...spec.FONT_SCALES], ["s", "m", "l"]);
  assert.ok(spec.ACCENTS.includes("amber")); // the Beam default is always present
});

// --- B. The ask-to-adjust directive ----------------------------------------

test("no fence → null (a normal answer)", () => {
  assert.equal(spec.parseAppearanceDirective("Here is your answer."), null);
});

test("a valid directive yields the whitelisted patch", () => {
  const text =
    'Switching you to dark.\n```lighthouse-appearance-request\n{"themePreset":"beam-dark","accent":"teal"}\n```';
  const d = spec.parseAppearanceDirective(text);
  assert.deepEqual(d, { patch: { themePreset: "beam-dark", accent: "teal" }, rejected: false });
});

test("a directive naming only unknown/invalid keys is REJECTED, never applied", () => {
  const text = '```lighthouse-appearance-request\n{"accent":"chartreuse","customCss":"x"}\n```';
  const d = spec.parseAppearanceDirective(text);
  assert.deepEqual(d, { patch: {}, rejected: true });
});

test("valid keys survive alongside invalid ones (partial validity applies)", () => {
  const text = '```lighthouse-appearance-request\n{"density":"compact","accent":"neon"}\n```';
  const d = spec.parseAppearanceDirective(text);
  assert.deepEqual(d, { patch: { density: "compact" }, rejected: false });
});

test("unterminated or unparseable fences produce null", () => {
  assert.equal(spec.parseAppearanceDirective("```lighthouse-appearance-request\n{no close"), null);
  assert.equal(
    spec.parseAppearanceDirective("```lighthouse-appearance-request\nnot json\n```"),
    null,
  );
});

test("the fence is stripped from displayed prose (residue + unterminated tail)", () => {
  const out = spec.stripAppearanceRequestFences(
    'Done.\n```lighthouse-appearance-request\n{"accent":"teal"}\n``` Enjoy.',
  );
  assert.equal(out.includes("lighthouse-appearance-request"), false);
  assert.ok(out.includes("Done."));
  assert.ok(out.includes("Enjoy."));
});

// --- C. The boundary is documented and no code path emits markup ------------

test("the spec forbids free-form color / CSS by construction", () => {
  const src = read("src/lib/appearanceSpec.ts");
  // Only the four whitelisted keys are ever read.
  assert.match(src, /isThemePreset\(o\.themePreset\)/);
  assert.match(src, /isAccent\(o\.accent\)/);
  assert.match(src, /isDensity\(o\.density\)/);
  assert.match(src, /isFontScale\(o\.fontScale\)/);
  // No key named for CSS/markup/script anywhere in the whitelist surface.
  assert.equal(/customCss|rawCss|styleSheet|innerHTML/.test(src), false);
});
