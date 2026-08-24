/**
 * 0.13.10 (§30) pins: the mobile-native structure — Sections retired with its
 * capabilities relocated. (The compact Files page went the same way in
 * 0.15.0.) Source pins in the house style (the JSX can't load under node);
 * the pure verdicts live in paneLayout.test.mjs and live behavior is verified
 * on-device.
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
const chat = read("src/features/chat/ChatPanel.tsx");
const chips = read("src/features/chat/ReportChip.tsx");
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
  for (const p of ["src/shell/AppShell.tsx", "src/shell/CompactTabBar.tsx"]) {
    assert.ok(!/>\s*Sections\s*</.test(read(p)), `${p} renders no Sections label`);
  }
  assert.doesNotMatch(read("src/shell/paneLayout.ts"), /"sections"/, "no sections tab id");
});

test("the report-template launcher survives as chat chips, labels byte-identical", () => {
  // §48 §1: the launcher was relocated out of InvestigateChips into ReportChip
  // so it can ride the ONE combined ≤3 suggestion list; the capability-map gate
  // moved into the shared chips hook so the cap sees the report count.
  const validated = read("src/features/chat/useValidatedChips.ts");
  assert.match(validated, /ragService\.capabilityMap\(/, "gated on the capability map");
  assert.match(validated, /t\.investigable/, "only investigable tables chip");
  assert.match(chips, /ragService\.investigate\(table, template\)/, "same engine op");
  // The template picker is an LhMenu item list; the three labels stay
  // byte-identical as item labels.
  assert.match(chips, /label: "Standard report",/, "Standard report entry");
  assert.match(chips, /label: "Scientific method",/, "IMRaD entry");
  assert.match(chips, /label: "Business report",/, "BLUF entry");
  assert.match(chips, /"imrad"/, "imrad template id");
  assert.match(chips, /"bluf"/, "bluf template id");
  // Report chips ride the ONE combined suggestion list (§48 §1) rendered in the
  // hero — no separate InvestigateChips group.
  assert.match(chat, /<SuggestionChips chips=\{mergedChips\}/, "report chips ride the combined suggestion list");
});

test("no definitions / saved-views groups survive the 0.15.0 deletion", () => {
  // Business definitions (the semantic layer) and Saved views were deleted in
  // 0.15.0 (openspec: refocus-chat-attachments §1.6). This pin is the tripwire
  // against a half-removal leaving a dead Settings group or gear-menu row that
  // opens onto nothing.
  const menu = read("src/features/settings/SettingsMenu.tsx");
  for (const [src, where] of [[settingsPage, "the Settings page"], [menu, "the gear menu"]]) {
    assert.doesNotMatch(src, /SemanticNav|ViewsNav/, `no nav component in ${where}`);
    assert.doesNotMatch(src, /Business definitions|Saved views/, `no group label in ${where}`);
  }
});

test("open-preferences routes to the Settings page on compact", () => {
  assert.match(
    shell,
    /if \(compactRef\.current\) setCompactTab\("settings"\);/,
    "the event selects the Settings tab on compact",
  );
});

test("the Sheet's Esc actually closes it — no bare role=dialog in the overlay-yield selector", () => {
  // The review-confirmed 0.13.10 regression: OVERLAY_SELECTOR contained
  // [role="dialog"], which the Sheet's own root carries, so the Esc handler
  // always yielded to itself and only the X worked.
  const sheet = read("src/shell/Sheet.tsx");
  const selector = sheet.match(/OVERLAY_SELECTOR =\s*\n?\s*'([^']+)'/)?.[1] ?? "";
  assert.ok(selector.length > 0, "the selector literal is extractable");
  assert.ok(!selector.includes('[role="dialog"]'), "no bare dialog role in the selector");
  assert.ok(selector.includes(".fui-DialogSurface"), "portaled Fluent dialogs still yield Esc (by class)");
  assert.match(sheet, /onCloseRef\.current\(\);/, "Esc reaches the close");
});

test("§1's runtime signal is the media-query PAIR (the width-only query was the actual bug)", () => {
  const pane = read("src/shell/paneLayout.ts");
  assert.match(
    pane,
    /COMPACT_QUERY = `\(max-width: \$\{COMPACT_BREAKPOINT - 0\.02\}px\), \(max-height: \$\{COMPACT_BREAKPOINT - 0\.02\}px\)`/,
    "the matchMedia query ORs max-width and max-height — short side, not width",
  );
});
