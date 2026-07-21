/**
 * 0.13.10 (§30) pins: the mobile-native structure — Sections retired with its
 * capabilities relocated, and the compact Files page as a tile grid. Source
 * pins in the house style (the JSX can't load under node); the pure verdicts
 * live in paneLayout.test.mjs and live behavior in the E2E pass.
 *
 * Run: `node --test test/mobileStructure.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const gone = (p) => !existsSync(path.join(ROOT, p));

const shell = read("src/shell/AppShell.tsx");
const grid = read("src/features/explorer/FileTileGrid.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const chips = read("src/features/chat/InvestigateChips.tsx");
const settingsPage = read("src/features/settings/SettingsPage.tsx");

test("the Sections world is deleted — components, registry, store, nav-only surfaces", () => {
  for (const p of [
    "src/shell/SectionRail.tsx",
    "src/shell/SectionFlyout.tsx",
    "src/shell/sidebarSections.tsx",
    "src/stores/useSidebarFlyout.ts",
    "src/stores/sidebarFlyoutReducer.ts",
    "src/features/recipes/RecipesNav.tsx",
    "src/features/insights/InsightsNav.tsx",
    "src/features/capabilities/CapabilityNav.tsx",
  ]) {
    assert.ok(gone(p), `${p} is deleted`);
  }
  // No nav surface says "Sections" anymore, on any platform.
  for (const p of ["src/shell/AppShell.tsx", "src/shell/CompactTabBar.tsx", "src/shell/Sidebar.tsx"]) {
    assert.ok(!/>\s*Sections\s*</.test(read(p)), `${p} renders no Sections label`);
  }
  assert.doesNotMatch(read("src/shell/paneLayout.ts"), /"sections"/, "no sections tab id");
});

test("the report-template launcher survives as chat chips, labels byte-identical", () => {
  assert.match(chips, /ragService\s*\n?\s*\.capabilityMap\(|ragService\.capabilityMap\(/, "gated on the capability map");
  assert.match(chips, /t\.investigable/ , "only investigable tables chip");
  assert.match(chips, /ragService\.investigate\(table, undefined, template\)/, "same engine op");
  assert.match(chips, />\s*Standard report\s*</, "Standard report entry");
  assert.match(chips, />\s*Scientific method\s*</, "IMRaD entry");
  assert.match(chips, />\s*Business report\s*</, "BLUF entry");
  assert.match(chips, /"imrad"/, "imrad template id");
  assert.match(chips, /"bluf"/, "bluf template id");
  assert.match(chat, /<InvestigateChips includedFileIds=\{includedFileIds\} \/>/, "mounted in the hero");
});

test("relocations: definitions + saved views live in Settings on both hosts", () => {
  assert.match(settingsPage, /<SemanticNav \/>/, "Business definitions group hosts SemanticNav");
  assert.match(settingsPage, /<ViewsNav \/>/, "Saved views group hosts ViewsNav");
  const menu = read("src/features/settings/SettingsMenu.tsx");
  assert.match(menu, />\s*Business definitions\s*</, "desktop gear menu item");
  assert.match(menu, />\s*Saved views\s*</, "desktop gear menu item");
});

test("open-preferences routes to the Settings page on compact", () => {
  assert.match(
    shell,
    /if \(compactRef\.current\) setCompactTab\("settings"\);/,
    "the event selects the Settings tab on compact",
  );
});

test("tile grid: tap selects (never flips visibility), long-press inspects, folders drill", () => {
  // Tap = direct multi-select through the SAME store selection the
  // investigation scope reads.
  assert.match(grid, /setSelectionMode\(true\);\s*\n\s*toggleSelected\(node\.id\);/, "tap toggles selection");
  // The tap path must never call the visibility ops — only the action row may.
  const tapFn = grid.slice(grid.indexOf("const tapTile"), grid.indexOf("const clearAll"));
  assert.ok(!tapFn.includes("applySelection") && !tapFn.includes("applyLocalOnly"),
    "a tap never silently changes rag_included/local_only");
  assert.match(grid, /setFolderId\(node\.id\);/, "folder tap drills in");
  assert.match(grid, /const LONG_PRESS_MS = 500;/, "long-press threshold");
  assert.match(grid, /new CustomEvent\(INSPECT_FILE_EVENT, \{ detail: \{ id: node\.id \} \}\)/, "long-press → inspector");
});

test("tile grid: the action row batch-applies through the same store ops", () => {
  assert.match(grid, /onChange=\{\(_, d\) => void applySelection\(Boolean\(d\.checked\)\)\}/, "Visible to AI switch");
  assert.match(grid, /onChange=\{\(_, d\) => void applyLocalOnly\(Boolean\(d\.checked\)\)\}/, "Private switch");
  assert.match(grid, /void removeFromVault\(ids\)/, "Remove uses the trash op");
  assert.match(grid, /setConfirmRemove\(true\)/, "…behind an inline confirm");
  assert.match(grid, /"lighthouse:open-investigations"/, "scope hands off to the picker");
  assert.match(chat, /window\.addEventListener\("lighthouse:open-investigations", onOpen\);/, "picker listens");
});

test("tile grid: at-rest badges, pull-down search, prominent Add", () => {
  assert.match(grid, /EyeRegular/, "in-the-beam badge");
  assert.match(grid, /LockClosedRegular/, "private badge");
  assert.match(grid, /el\.scrollTop = row\.offsetHeight/, "search parks above the fold (pull-down reveals)");
  assert.match(grid, />\s*Add\s*<\/Button>/, "the add control stays prominent");
  assert.match(grid, /repeat\(auto-fill, minmax\(148px, 1fr\)\)/, "auto-fill tile columns");
});

test("desktop keeps the tree: FilesSurface branches on paneLayout, page.tsx mounts it", () => {
  assert.match(
    grid,
    /return compact \? <FileTileGrid \/> : <FileExplorer \/>;/,
    "the branch lives OUTSIDE FileExplorer (its hooks/render untouched)",
  );
  assert.match(read("app/page.tsx"), /<AppShell sidebar=\{<FilesSurface \/>\} main=\{<ChatPanel \/>\} \/>/);
  // The desktop return of AppShell carries no rail/flyout remnants.
  assert.doesNotMatch(shell, /SectionRail|SectionFlyout|rail=\{/, "no rail in either arrangement");
});
