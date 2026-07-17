/**
 * Appearance settings persistence (openspec: add-usability-field-patch §3). The
 * TS twin's setAppearance/appearance are round-tripped FOR REAL against a
 * scratch settings file — the same validation the engine enforces (settings.rs
 * set_appearance): only whitelisted keys with in-vocabulary values persist,
 * merges keep siblings, and hand-written junk is dropped at read. The React
 * surfaces that apply it are asserted structurally (the *Ui.test house style).
 *
 * Run: `node --test test/appearanceSettings.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const { setAppearance, appearance, readDesktopSettings } = await import("../src/server/settings.ts");

function seed(obj) {
  const dir = mkdtempSync(path.join(tmpdir(), "lh-appearance-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(obj));
  process.env.LIGHTHOUSE_SETTINGS_FILE = file;
}

test("the twin round-trips valid appearance keys, merges, and drops junk", () => {
  seed({ vaultDir: "/v" });
  try {
    assert.deepEqual(appearance(readDesktopSettings()), {});
    setAppearance({ accent: "teal", density: "compact", fontScale: "l", themePreset: "beam-dark" });
    assert.deepEqual(appearance(readDesktopSettings()), {
      accent: "teal",
      density: "compact",
      fontScale: "l",
      themePreset: "beam-dark",
    });
    // A single-key change (the directive setting only `accent`) keeps the rest.
    setAppearance({ accent: "orchid" });
    const a = appearance(readDesktopSettings());
    assert.equal(a.accent, "orchid");
    assert.equal(a.density, "compact");
    // Junk — a free-form color, an unknown key, an out-of-vocabulary value — is
    // dropped; nothing changes and the shell-owned key survives.
    setAppearance({ accent: "#ff0000", customCss: "body{}", density: "roomy" });
    assert.equal(appearance(readDesktopSettings()).accent, "orchid");
    assert.equal(appearance(readDesktopSettings()).density, "compact");
    assert.equal(readDesktopSettings().vaultDir, "/v");
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

test("a hand-written file is validated at read — only whitelisted survives", () => {
  seed({ appearance: { accent: "neon", density: "compact", fontScale: "xl", customCss: "y" } });
  try {
    assert.deepEqual(appearance(readDesktopSettings()), { density: "compact" });
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

// --- Structural: the client applies appearance through the AA-validated theme -

test("theme + store + providers + Preferences wire accent/density/fontScale", () => {
  const theme = read("src/shell/theme.ts");
  assert.match(theme, /export function themeFor/);
  assert.match(theme, /ACCENT_THEMES/);
  assert.match(theme, /scaleTheme/); // fontScale + density scale tokens, never a color
  assert.match(read("src/stores/useAppearanceStore.ts"), /export const useAppearanceStore/);
  assert.match(read("app/providers.tsx"), /themeFor\(resolved, accent, density, fontScale\)/);
  const menu = read("src/features/settings/SettingsMenu.tsx");
  assert.match(menu, /setAppearance\(\{ accent:/);
  assert.match(menu, /setAppearance\(\{ density:/);
  assert.match(menu, /setAppearance\(\{ fontScale:/);
});

test("the accent set is gated by the contrast script", () => {
  const contrast = read("scripts/check-contrast.mjs");
  assert.match(contrast, /teal:/);
  assert.match(contrast, /orchid:/);
  assert.match(contrast, /accent · Paper/);
});
