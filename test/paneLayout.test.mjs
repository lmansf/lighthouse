/**
 * §5 (iOS field patch 1) → 0.13.10 §1 pins: the compact layout's pure verdict —
 * paneLayout(minDim, drawerOpen, platform), where minDim is the viewport's
 * SHORT side (min of width and height), so a phone is compact in BOTH
 * orientations. The two structural pins that keep desktop pixel-identical:
 *
 *   1. the desktop platform NEVER takes the compact branch, at any size;
 *   2. at or above COMPACT_BREAKPOINT (short side) no platform does
 *      (iPad-class stays on the desktop arrangement).
 *
 * Run: `node --test test/paneLayout.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { COMPACT_BREAKPOINT, COMPACT_TABS, paneLayout } = await import("../src/shell/paneLayout.ts");

test("the breakpoint is 700 (the CSS query derives from this constant)", () => {
  assert.equal(COMPACT_BREAKPOINT, 700);
});

test("0.13.10 §2: the compact tab set is Chat · Files · Settings, in that order (pinned data)", () => {
  assert.deepEqual(
    COMPACT_TABS.map((t) => t.id),
    ["chat", "files", "settings"],
    "the destinations + order are Chat, Files, Settings — Sections is retired",
  );
  assert.deepEqual(
    COMPACT_TABS.map((t) => t.label),
    ["Chat", "Files", "Settings"],
    "the labels are byte-pinned (twin parity)",
  );
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
      // fp4 §3 structural pin: desktop NEVER shows the compact tab bar.
      assert.equal(l.showTabBar, false, "desktop keeps the persistent column, no tab bar");
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
      // fp4 §3: the compact bottom tab bar is THE nav here.
      assert.equal(closed.showTabBar, true, "the tab bar is the compact navigation");

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
      // fp4 §3 structural pin: an iPad-regular (≥700pt) shows NO tab bar either.
      assert.equal(l.showTabBar, false, "iPad-regular keeps the column, no tab bar");
    }
  }
});

test("0.13.10 §1: the verdict thresholds the SHORT side — a phone is compact in landscape too", () => {
  // iPhone 14/15/16 landscape: 844 wide but only 390 tall. The old width-only
  // signal read 844 ≥ 700 and handed a phone the desktop column; the short
  // side is what actually bounds the arrangement.
  const phoneLandscape = paneLayout(Math.min(844, 390), false, "ios");
  assert.equal(phoneLandscape.compact, true, "844×390 (short side 390) is compact");
  assert.equal(phoneLandscape.showTabBar, true, "landscape phone keeps the tab bar");
  assert.equal(phoneLandscape.showResizeHandle, false);

  // iPad 11" landscape: 1180×820 — short side 820 ≥ 700 keeps the regular
  // column, exactly as portrait (834×1194 → short side 834) does.
  const ipadLandscape = paneLayout(Math.min(1180, 820), false, "ios");
  assert.equal(ipadLandscape.compact, false, "1180×820 (short side 820) stays regular");
  assert.equal(ipadLandscape.showTabBar, false);
  assert.equal(ipadLandscape.sidebarMode, "column");

  // iPad narrow Split View (~320-500 wide): compact exactly as before.
  const splitView = paneLayout(Math.min(375, 820), false, "ios");
  assert.equal(splitView.compact, true, "narrow Split View stays compact");

  // Desktop with a SHORT window (h < 700 is common on laptops): never compact.
  const shortDesktop = paneLayout(Math.min(1440, 640), false, "desktop");
  assert.equal(shortDesktop.compact, false, "a short desktop window never compacts");
  assert.equal(shortDesktop.showTabBar, false);
});
