/**
 * Sectioned-sidebar flyout (openspec: field-patch-0.12.5 §1). Three layers, the
 * *Ui.test / explorerResize.test house style:
 *
 *   A. The PURE reducer (src/stores/sidebarFlyoutReducer.ts) — open/toggle/close,
 *      width clamping, and hydrate — unit-tested directly. It carries no React,
 *      zustand, or Fluent import, so it loads straight into the node runner (the
 *      loader can't touch `.tsx` / @fluentui/react-components).
 *   B. The persistence twin (src/server/settings.ts) — flyoutWidth + openFlyout —
 *      round-tripped FOR REAL against a scratch settings file, byte-for-byte the
 *      Rust behavior pinned in settings_test.rs::flyout_width_and_open_section_*.
 *   C. The React wiring (rail, flyout, store, AppShell, Sidebar) — asserted
 *      structurally against source, since the JSX can't load in node. Live
 *      behavior is the Playwright E2E (scripts/e2e-sidebar-flyout.mjs — the
 *      playwright-core + bundled-chromium pattern of scripts/brand-screens.mjs).
 *
 * Run: `node --test test/sidebarFlyout.test.mjs`
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

const {
  FLYOUT_MIN,
  FLYOUT_MAX,
  FLYOUT_DEFAULT,
  clampFlyoutWidth,
  initialFlyoutState,
  reduceOpen,
  reduceToggle,
  reduceClose,
  reduceSetWidth,
  reduceHydrate,
} = await import("../src/stores/sidebarFlyoutReducer.ts");

const {
  FLYOUT_WIDTH_MIN,
  FLYOUT_WIDTH_MAX,
  flyoutWidth,
  setFlyoutWidth,
  openFlyout,
  setOpenFlyout,
  readDesktopSettings,
} = await import("../src/server/settings.ts");

// ============================ A. The pure reducer ============================

test("bounds: the reducer bounds mirror the engine (280–680) and the default sits inside", () => {
  assert.equal(FLYOUT_MIN, 280);
  assert.equal(FLYOUT_MAX, 680);
  assert.ok(FLYOUT_DEFAULT >= FLYOUT_MIN && FLYOUT_DEFAULT <= FLYOUT_MAX);
  assert.deepEqual(initialFlyoutState, { openSection: null, flyoutWidth: FLYOUT_DEFAULT });
});

test("clampFlyoutWidth saturates to the bounds, rounds, and defaults non-finite", () => {
  assert.equal(clampFlyoutWidth(100000), FLYOUT_MAX);
  assert.equal(clampFlyoutWidth(1), FLYOUT_MIN);
  assert.equal(clampFlyoutWidth(360.4), 360);
  assert.equal(clampFlyoutWidth(Number.NaN), FLYOUT_DEFAULT);
  assert.equal(clampFlyoutWidth(Infinity), FLYOUT_DEFAULT);
});

test("open sets the section; opening the already-open one is a no-op (same ref)", () => {
  const s0 = { openSection: null, flyoutWidth: 360 };
  const s1 = reduceOpen(s0, "insights");
  assert.equal(s1.openSection, "insights");
  // Idempotent: re-opening the open section returns the SAME object (no churn).
  assert.equal(reduceOpen(s1, "insights"), s1);
  // Empty id never opens.
  assert.equal(reduceOpen(s0, ""), s0);
});

test("toggle opens a closed section and closes the open one (re-click)", () => {
  let s = { openSection: null, flyoutWidth: 360 };
  s = reduceToggle(s, "library");
  assert.equal(s.openSection, "library");
  // Re-click the same → closed.
  s = reduceToggle(s, "library");
  assert.equal(s.openSection, null);
  // Toggling a different section switches (one open at a time).
  s = reduceToggle(s, "recipes");
  s = reduceToggle(s, "semantic");
  assert.equal(s.openSection, "semantic");
});

test("close clears the open section, and is a no-op (same ref) when already closed", () => {
  const open = { openSection: "recipes", flyoutWidth: 400 };
  assert.equal(reduceClose(open).openSection, null);
  const closed = { openSection: null, flyoutWidth: 400 };
  assert.equal(reduceClose(closed), closed);
});

test("setWidth clamps; an unchanged clamp returns the same ref", () => {
  const s = { openSection: "insights", flyoutWidth: 360 };
  assert.equal(reduceSetWidth(s, 5000).flyoutWidth, FLYOUT_MAX);
  assert.equal(reduceSetWidth(s, 10).flyoutWidth, FLYOUT_MIN);
  assert.equal(reduceSetWidth(s, 480).flyoutWidth, 480);
  assert.equal(reduceSetWidth(s, 360), s, "no-op width returns same ref");
  // Section is preserved across a width change.
  assert.equal(reduceSetWidth(s, 500).openSection, "insights");
});

test("hydrate adopts only present fields, re-clamps width, and normalizes empty→null", () => {
  const base = { openSection: null, flyoutWidth: FLYOUT_DEFAULT };
  // Full hydrate.
  const a = reduceHydrate(base, { openSection: "library", flyoutWidth: 9999 });
  assert.deepEqual(a, { openSection: "library", flyoutWidth: FLYOUT_MAX });
  // Partial hydrate never clobbers an untouched field with a default.
  const b = reduceHydrate({ openSection: "recipes", flyoutWidth: 500 }, { flyoutWidth: 300 });
  assert.deepEqual(b, { openSection: "recipes", flyoutWidth: 300 });
  const c = reduceHydrate({ openSection: "recipes", flyoutWidth: 500 }, { openSection: "semantic" });
  assert.deepEqual(c, { openSection: "semantic", flyoutWidth: 500 });
  // Explicit null / empty string both mean "closed".
  assert.equal(reduceHydrate(a, { openSection: null }).openSection, null);
  assert.equal(reduceHydrate(a, { openSection: "" }).openSection, null);
  // A non-finite / absent width is ignored (keeps current).
  assert.equal(reduceHydrate({ openSection: null, flyoutWidth: 420 }, { flyoutWidth: null }).flyoutWidth, 420);
});

// ===================== B. The persistence twin (settings.ts) =================

function seedSettings(seed) {
  const dir = mkdtempSync(path.join(tmpdir(), "lh-flyout-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(seed));
  process.env.LIGHTHOUSE_SETTINGS_FILE = file;
  return file;
}

test("twin bounds mirror the engine (PARITY: FLYOUT_WIDTH_MIN/MAX = 280/680)", () => {
  assert.equal(FLYOUT_WIDTH_MIN, 280);
  assert.equal(FLYOUT_WIDTH_MAX, 680);
});

test("flyout width round-trips per mode, merges siblings, clamps at write, ignores junk", () => {
  seedSettings({ vaultDir: "/somewhere/vault", widgetPos: [7, 9] });
  try {
    assert.equal(flyoutWidth(readDesktopSettings(), "window"), null);
    assert.equal(flyoutWidth(readDesktopSettings(), "widget"), null);

    setFlyoutWidth("window", 360);
    assert.equal(flyoutWidth(readDesktopSettings(), "window"), 360);
    assert.equal(flyoutWidth(readDesktopSettings(), "widget"), null);

    // Merge, not clobber.
    setFlyoutWidth("widget", 300);
    let s = readDesktopSettings();
    assert.equal(flyoutWidth(s, "widget"), 300);
    assert.equal(flyoutWidth(s, "window"), 360);

    // Clamp at write.
    setFlyoutWidth("window", 100000);
    assert.equal(flyoutWidth(readDesktopSettings(), "window"), FLYOUT_WIDTH_MAX);
    setFlyoutWidth("window", 1);
    assert.equal(flyoutWidth(readDesktopSettings(), "window"), FLYOUT_WIDTH_MIN);

    // Unknown mode / non-finite width leave the file untouched.
    setFlyoutWidth("sidebar", 300);
    setFlyoutWidth("window", Number.NaN);
    s = readDesktopSettings();
    assert.equal(flyoutWidth(s, "window"), FLYOUT_WIDTH_MIN);
    assert.equal(flyoutWidth(s, "widget"), 300);
    assert.equal(s.flyoutWidth?.sidebar, undefined);

    // Shell-owned + unmodeled keys survive the narrow read-modify-write.
    assert.equal(s.vaultDir, "/somewhere/vault");
    assert.deepEqual(s.widgetPos, [7, 9]);
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

test("the twin clamps an out-of-range flyout width file at read", () => {
  seedSettings({ flyoutWidth: { window: 9999, widget: 1 } });
  try {
    const s = readDesktopSettings();
    assert.equal(flyoutWidth(s, "window"), FLYOUT_WIDTH_MAX);
    assert.equal(flyoutWidth(s, "widget"), FLYOUT_WIDTH_MIN);
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

test("openFlyout round-trips a section id and a blank id CLEARS it", () => {
  seedSettings({ vaultDir: "/v", widgetPos: [1, 2] });
  try {
    assert.equal(openFlyout(readDesktopSettings()), null);
    setOpenFlyout("insights");
    assert.equal(openFlyout(readDesktopSettings()), "insights");
    setOpenFlyout("library");
    assert.equal(openFlyout(readDesktopSettings()), "library");
    // Blank / whitespace clears (flyout closed) and removes the key.
    setOpenFlyout("   ");
    assert.equal(openFlyout(readDesktopSettings()), null);
    assert.equal(readDesktopSettings().openFlyout, undefined);
    // A hand-written blank also reads as closed.
    setOpenFlyout("recipes");
    setOpenFlyout("");
    assert.equal(openFlyout(readDesktopSettings()), null);
    // Shell-owned keys survive.
    const s = readDesktopSettings();
    assert.equal(s.vaultDir, "/v");
    assert.deepEqual(s.widgetPos, [1, 2]);
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

// ==================== C. The React wiring (structural) ======================

test("the store persists via /api/settings and leans on the pure reducer", () => {
  const store = read("src/stores/useSidebarFlyout.ts");
  assert.match(store, /from "\.\/sidebarFlyoutReducer"/, "the store imports the pure reducer");
  assert.match(store, /openFlyout: openSection \?\? ""/, "open-section persists (empty = closed)");
  assert.match(store, /flyoutWidth: \{ mode, width: c \}/, "width persists per mode, explorerWidth idiom");
  assert.match(store, /lighthouse\.sidebar\.flyout/, "an instant localStorage cache like the explorer width");
  assert.match(store, /setTimeout\(/, "width writes are debounced");
});

test("SectionRail: focusable header rows, aria-expanded, roving tabindex, Beam focus ring", () => {
  const rail = read("src/shell/SectionRail.tsx");
  assert.match(rail, /data-section-rail/, "the rail is tagged so click-outside can spare it");
  assert.match(rail, /aria-expanded=\{isOpen\}/, "each row reflects its open state");
  assert.match(rail, /aria-controls=\{isOpen \? FLYOUT_PANEL_ID : undefined\}/, "the row discloses the flyout");
  assert.match(rail, /tabIndex=\{i === focusIdx \? 0 : -1\}/, "roving tabindex — one row tabbable");
  assert.match(rail, /ArrowDown/, "Down moves focus between rows");
  assert.match(rail, /ArrowUp/, "Up moves focus between rows");
  assert.match(rail, /onClick=\{\(\) => toggle\(section\.id\)\}/, "click toggles the section");
  assert.match(rail, /colorStrokeFocus2/, "the focus ring uses the Beam focus token (both themes)");
});

test("SectionFlyout: a labeled region with a Close button, Esc, click-outside, and its own resizer", () => {
  const fly = read("src/shell/SectionFlyout.tsx");
  assert.match(fly, /id=\{FLYOUT_PANEL_ID\}/, "the panel id matches the rail's aria-controls");
  // §5: a labeled region inline; the compact sheet presents as a modal dialog.
  assert.match(
    fly,
    /role=\{compact \? "dialog" : "region"\}/,
    "the flyout is a labeled region (a dialog as the compact sheet)",
  );
  assert.match(fly, /aria-label="Close"/, "the X is labeled Close");
  assert.match(fly, /"Escape"[\s\S]*close\(\)/, "Esc closes");
  assert.match(fly, /pointerdown/, "a click-outside listener closes");
  assert.match(fly, /\[data-section-rail\]/, "…but a click on the rail is spared");
  // A section's own portaled dialog/menu must not trip Esc or click-outside.
  assert.match(fly, /fui-DialogSurface/, "the close paths spare portaled overlays (dialog/menu-aware)");
  // Its own resize handle reuses the ARIA window-splitter pattern.
  assert.match(fly, /role="separator"/);
  assert.match(fly, /aria-orientation="vertical"/);
  assert.match(fly, /aria-valuenow=\{flyoutWidth\}/);
  assert.match(fly, /setPointerCapture/, "pointer drag with capture");
  assert.match(fly, /prefers-reduced-motion/, "the slide honors reduced motion");
  // Constitution: a fixed, clamped set of values — no arbitrary CSS/code.
  assert.match(fly, /FLYOUT_MIN|FLYOUT_MAX/, "the resize is clamped to the safe bounds");
});

test("the flyout renders the section's existing component verbatim, from the registry", () => {
  const fly = read("src/shell/SectionFlyout.tsx");
  assert.match(fly, /const Body = section\.Component/, "the flyout mounts the registered component");
  assert.match(fly, /<Body \/>/, "…verbatim");
  const registry = read("src/shell/sidebarSections.tsx");
  assert.match(registry, /export const SIDEBAR_SECTIONS/, "the registry is the single source of order");
  for (const id of ["insights", "semantic", "capabilities", "recipes", "library", "investigations"]) {
    assert.ok(registry.includes(`id: "${id}"`), `the registry carries the ${id} section`);
  }
});

test("AppShell hosts the rail + flyout and reconciles the flyout against the settings file", () => {
  const shell = read("src/shell/AppShell.tsx");
  assert.match(shell, /rail=\{<SectionRail \/>\}/, "the rail rides below the file tree in the sidebar");
  assert.match(shell, /!collapsed && <SectionFlyout \/>/, "the flyout hides with the collapsed sidebar");
  assert.match(shell, /useSidebarFlyout\.getState\(\)\.hydrate/, "the store hydrates from the settings fetch");
  assert.match(shell, /sectionById\(sof\)/, "an unknown/removed open-section id is dropped (no ghost flyout)");
});

test("Sidebar renders the section rail below the tree, hidden while collapsed", () => {
  const sidebar = read("src/shell/Sidebar.tsx");
  assert.match(sidebar, /rail\?: React\.ReactNode/, "the Sidebar takes a rail slot");
  assert.match(sidebar, /!collapsed && rail \? <div className=\{styles\.rail\}>\{rail\}<\/div> : null/, "rail hides when collapsed");
});

test("first-run tour keeps its file-tree anchor accurate for the new layout", () => {
  const tour = read("src/features/help/FirstRunTour.tsx");
  assert.match(tour, /anchor: "explorer"/, 'the tour still anchors "explorer" to the file tree');
  assert.match(read("src/features/explorer/FileExplorer.tsx"), /data-tour="explorer"/, "the tree keeps the anchor");
});
