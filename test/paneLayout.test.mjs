/**
 * §5 (iOS field patch 1) pins: the compact phone layout's pure verdict —
 * paneLayout(width, drawerOpen, platform). The two structural pins that keep
 * desktop pixel-identical:
 *
 *   1. the desktop platform NEVER takes the compact branch, at any width;
 *   2. at or above COMPACT_BREAKPOINT no platform does (iPad-class stays on
 *      the desktop arrangement).
 *
 * Run: `node --test test/paneLayout.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { COMPACT_BREAKPOINT, paneLayout } = await import("../src/shell/paneLayout.ts");

test("the breakpoint is 700 (the CSS query derives from this constant)", () => {
  assert.equal(COMPACT_BREAKPOINT, 700);
});

test("desktop never compacts — any width, drawer state irrelevant (structural pin)", () => {
  for (const width of [320, 375, 390, 500, 699, 700, 1024, 2560]) {
    for (const drawerOpen of [false, true]) {
      const l = paneLayout(width, drawerOpen, "desktop");
      assert.equal(l.compact, false, `desktop@${width}`);
      assert.equal(l.sidebarMode, "column");
      assert.equal(l.drawerVisible, false, "a stale drawerOpen never leaks into desktop");
      assert.equal(l.showResizeHandle, true);
      assert.equal(l.applyExplorerWidth, true);
      assert.equal(l.sectionsAsSheets, false);
    }
  }
});

test("mobile below the breakpoint: full-screen page arrangement, no resize machinery", () => {
  for (const platform of ["ios", "android"]) {
    for (const width of [320, 375, 390, 699]) {
      const closed = paneLayout(width, false, platform);
      assert.equal(closed.compact, true, `${platform}@${width}`);
      // fp3 §3: the compact sidebar is a full-screen PAGE (was an overlay drawer).
      assert.equal(closed.sidebarMode, "page");
      assert.equal(closed.drawerVisible, false);
      assert.equal(closed.showResizeHandle, false, "handle does not exist in compact");
      assert.equal(closed.applyExplorerWidth, false, "explorerWidth never applied in compact");
      assert.equal(closed.sectionsAsSheets, true);

      const open = paneLayout(width, true, platform);
      assert.equal(open.drawerVisible, true, "drawerOpen shows the files page only in compact");
    }
  }
});

test("mobile at/above the breakpoint keeps the desktop arrangement (iPad ≥700pt)", () => {
  for (const platform of ["ios", "android"]) {
    for (const width of [700, 744, 820, 1024, 1366]) {
      const l = paneLayout(width, true, platform);
      assert.equal(l.compact, false, `${platform}@${width}`);
      assert.equal(l.sidebarMode, "column");
      assert.equal(l.drawerVisible, false);
      assert.equal(l.showResizeHandle, true);
      assert.equal(l.applyExplorerWidth, true);
      assert.equal(l.sectionsAsSheets, false);
    }
  }
});
