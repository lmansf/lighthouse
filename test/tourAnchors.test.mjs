/**
 * §33 §3: the anchor floor — every tour step's data-tour target must exist in
 * a component that is MOUNTED in that step's mode, so a dead anchor becomes a
 * red test instead of a silent centered-modal fallback (which stays as
 * last-resort runtime behavior only). Source-pinned per mode, the
 * chartIt.test.mjs house style.
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
const tour = read("src/features/help/FirstRunTour.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const tabBar = read("src/shell/CompactTabBar.tsx");

/** The anchors of one stepsFor branch, in step order. */
function anchorsOf(block) {
  return [...block.matchAll(/anchor: "([^"]+)"/g)].map((m) => m[1]);
}
// stepsFor's compact list is the ternary's first branch, desktop the second.
const compactBlock = tour.slice(tour.indexOf("compact\n    ? ["), tour.indexOf("    : ["));
const desktopBlock = tour.slice(tour.indexOf("    : ["));
const compactAnchors = anchorsOf(compactBlock);
const desktopAnchors = anchorsOf(desktopBlock);

/** Where each anchor's element lives, per mode — the DOM-presence contract.
 *  Compact first-run lands on the Chat tab: the composer, the hero suggestion
 *  slot (either branch), the provenance line, and the always-visible tab bar
 *  are ALL mounted there. Desktop mounts the explorer, the chat pane, and the
 *  sidebar's settings gear together. */
const HOME = {
  compact: {
    chat: ["src/features/chat/ChatPanel.tsx"],
    "tab-files": ["src/shell/CompactTabBar.tsx"],
    suggestions: ["src/features/chat/ChatPanel.tsx"],
    models: ["src/features/chat/ChatPanel.tsx"],
    "tab-settings": ["src/shell/CompactTabBar.tsx"],
  },
  desktop: {
    explorer: ["src/features/explorer/FileExplorer.tsx", "src/features/explorer/FileTileGrid.tsx"],
    chat: ["src/features/chat/ChatPanel.tsx"],
    suggestions: ["src/features/chat/ChatPanel.tsx"],
    models: ["src/features/chat/ChatPanel.tsx"],
    settings: ["src/features/settings/SettingsMenu.tsx"],
  },
};

test("both modes run exactly five steps, in the designed order", () => {
  assert.deepEqual(compactAnchors, ["chat", "tab-files", "suggestions", "models", "tab-settings"]);
  assert.deepEqual(desktopAnchors, ["explorer", "chat", "suggestions", "models", "settings"]);
});

for (const [mode, anchors] of [
  ["compact", compactAnchors],
  ["desktop", desktopAnchors],
]) {
  test(`${mode}: every step's data-tour target exists in a mounted component`, () => {
    for (const anchor of anchors) {
      const homes = HOME[mode][anchor];
      assert.ok(homes, `${mode} step "${anchor}" has a declared home`);
      // Tab anchors are minted by the COMPACT_TABS map (template literal);
      // everything else is a literal attribute.
      const needle =
        anchor.startsWith("tab-")
          ? "data-tour={`tab-${t.id}`}"
          : `data-tour="${anchor}"`;
      assert.ok(
        homes.some((h) => read(h).includes(needle)),
        `${mode} step "${anchor}": ${needle} missing from ${homes.join(", ")}`,
      );
    }
  });
}

test("the tab anchors are the real tab set (files + settings ride the map)", () => {
  assert.match(tabBar, /data-tour=\{`tab-\$\{t\.id\}`\}/, "minted per tab in the existing map");
  const paneLayout = read("src/shell/paneLayout.ts");
  for (const id of ["files", "settings"]) {
    assert.match(paneLayout, new RegExp(`id: "${id}"`), `COMPACT_TABS carries "${id}"`);
  }
});

test("the beam anchor is fully retired — no step targets it, no element mints it", () => {
  assert.ok(!compactAnchors.includes("beam") && !desktopAnchors.includes("beam"));
  assert.ok(!chat.includes('data-tour="beam"'), "ChatPanel no longer mints the beam anchor");
});

test("the suggestions anchor exists on BOTH hero branches (fresh install included)", () => {
  const noFiles = chat.indexOf('className={styles.noFilesCard} data-tour="suggestions"');
  const suggest = chat.indexOf('className={styles.suggestRow} data-tour="suggestions"');
  assert.ok(noFiles !== -1, "no-files card carries the anchor (fresh install)");
  assert.ok(suggest !== -1, "suggestions row carries the anchor");
});

test("replay lands anchored: Chat tab first, activation deferred a frame", () => {
  const appShell = read("src/shell/AppShell.tsx");
  assert.match(
    appShell,
    /if \(compactRef\.current\) setCompactTab\("chat"\);/,
    "AppShell returns to the Chat tab on the start-tour event (compact only)",
  );
  assert.match(
    tour,
    /const onStart = \(\) => \{\s*\n\s*requestAnimationFrame\(\(\) => \{\s*\n\s*setIndex\(0\);\s*\n\s*setActive\(true\);/,
    "the tour activates one frame later so the tab switch commits first",
  );
});

test("the models step tells today's truth, sourced from the pinned roster copy", () => {
  assert.match(tour, /ON_DEVICE_MODEL_COPY\.foundation/, "backend-available wording is the roster's");
  assert.match(tour, /MOBILE_NO_PROVIDER_TRUTHS/, "no-backend wording is the shared truth");
  assert.ok(
    !tour.includes("the private model runs on the desktop app"),
    "the stale desktop-app line is gone from the tour",
  );
});
