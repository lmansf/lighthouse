/**
 * First-run tour behavior (proof gate e).
 *
 * The tour's SHOW-ONCE contract is pure decision logic (`shouldAutoOpenTour`),
 * unit-tested here across the fresh-install / shown / failed-read cases. The
 * surrounding guarantees are asserted structurally against the source, because
 * they are properties of WHERE state lives and WHERE the component mounts:
 *   - skip is permanent      → the flag is POSTed true on first appearance
 *   - vault switch is safe    → the flag is an install-global setting field
 *   - widget mode defers      → the tour mounts only from the main-window page
 *   - one orientation surface → Quick Start is deleted and re-entry is wired
 * The flag's persistence round-trip is covered byte-for-byte by the Rust twin's
 * settings_test.rs; here we only assert the TS twin declares it.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

// tourGating.ts is pure TS (no React/Fluent), so it loads straight into the
// node test runner; the hook only supplies extensionless `.ts` resolution.
register("./_ts-extensionless-hook.mjs", import.meta.url);
const { shouldAutoOpenTour } = await import("../src/features/help/tourGating.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

test("shows once: a fresh install greets, an already-shown tour never re-greets", () => {
  assert.equal(shouldAutoOpenTour({}), true, "fresh install (no tourShown key) greets");
  assert.equal(shouldAutoOpenTour({ tourShown: false }), true, "explicit not-shown greets");
  // Skipping AND completing both persist tourShown:true — so from then on, and
  // on every relaunch that reads it back, the tour stays dismissed.
  assert.equal(shouldAutoOpenTour({ tourShown: true }), false, "already shown => never again");
});

test("a failed settings read greets nobody (never greet-every-launch)", () => {
  assert.equal(shouldAutoOpenTour(null), false);
  assert.equal(shouldAutoOpenTour(undefined), false);
});

test("skip is permanent: the flag is persisted the moment the tour appears", () => {
  const tour = read("src/features/help/FirstRunTour.tsx");
  assert.match(tour, /fetch\("\/api\/settings"/, "reads the flag from install-global settings");
  // Persisted on FIRST APPEARANCE (before any Next/Skip), so a skip sticks too.
  assert.match(
    tour,
    /method:\s*"POST"[\s\S]*tourShown:\s*true/,
    "POSTs tourShown:true on show, so skip and complete both stick",
  );
});

test("vault switch never re-shows: tourShown is an install-global setting, not vault/localStorage", () => {
  assert.match(read("src/server/settings.ts"), /tourShown\?:\s*boolean/, "tourShown is a DesktopSettings field");
});

test("widget mode defers: the tour mounts only from the onboarded main window", () => {
  const page = read("app/page.tsx");
  assert.match(page, /FirstRunTour/, "main window page mounts the tour");
  assert.match(page, /onboarded\s*&&[\s\S]*FirstRunTour/, "gated behind onboarding being done");
  assert.doesNotMatch(read("app/widget/page.tsx"), /FirstRunTour/, "widget window never mounts it");
  assert.doesNotMatch(read("app/explorer/page.tsx"), /FirstRunTour/, "explorer window never mounts it");
});

test("one orientation surface: Quick Start is folded in and re-entry is wired", () => {
  assert.throws(() => read("src/features/help/QuickStart.tsx"), /ENOENT/, "QuickStart.tsx is deleted (folded)");
  const menu = read("src/features/settings/SettingsMenu.tsx");
  assert.match(menu, /Take the tour/, "settings gear offers manual re-entry");
  assert.match(menu, /START_TOUR_EVENT/, "re-entry dispatches the start event (ignores tourShown)");
});
