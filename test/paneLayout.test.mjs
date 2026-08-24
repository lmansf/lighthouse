/**
 * §5 (iOS field patch 1) → 0.13.10 §1 pins: the compact layout's pure verdict —
 * paneLayout(minDim, platform), where minDim is the viewport's
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

test("§49 §4: the compact tab set is Chat · Reports · Settings, in that order (pinned data)", () => {
  // The Files tab went with the vault in 0.15.0: a conversation's files are its
  // attachments, shown in the composer's own attachment bar.
  assert.deepEqual(
    COMPACT_TABS.map((t) => t.id),
    ["chat", "reports", "settings"],
    "the destinations + order are Chat, Reports, Settings",
  );
  assert.deepEqual(
    COMPACT_TABS.map((t) => t.label),
    ["Chat", "Reports", "Settings"],
    "the labels are byte-pinned (twin parity)",
  );
});

test("desktop never compacts — any width (structural pin)", () => {
  for (const width of [320, 375, 390, 500, 699, 700, 1024, 2560]) {
    const l = paneLayout(width, "desktop");
    assert.equal(l.compact, false, `desktop@${width}`);
    // fp4 §3 structural pin: desktop NEVER shows the compact tab bar.
    assert.equal(l.showTabBar, false, "desktop keeps the single workspace, no tab bar");
  }
});

test("mobile below the breakpoint: the compact page arrangement", () => {
  for (const platform of ["ios", "android"]) {
    for (const width of [320, 375, 390, 699]) {
      const l = paneLayout(width, platform);
      assert.equal(l.compact, true, `${platform}@${width}`);
      // fp4 §3: the compact bottom tab bar is THE nav here.
      assert.equal(l.showTabBar, true, "the tab bar is the compact navigation");
    }
  }
});

test("mobile at/above the breakpoint keeps the desktop arrangement (iPad ≥700pt)", () => {
  for (const platform of ["ios", "android"]) {
    for (const width of [700, 744, 820, 1024, 1366]) {
      const l = paneLayout(width, platform);
      assert.equal(l.compact, false, `${platform}@${width}`);
      // fp4 §3 structural pin: an iPad-regular (≥700pt) shows NO tab bar either.
      assert.equal(l.showTabBar, false, "iPad-regular keeps the desktop arrangement");
    }
  }
});

test("0.13.10 §1: the verdict thresholds the SHORT side — a phone is compact in landscape too", () => {
  // iPhone 14/15/16 landscape: 844 wide but only 390 tall. The old width-only
  // signal read 844 ≥ 700 and handed a phone the desktop arrangement; the short
  // side is what actually bounds it.
  const phoneLandscape = paneLayout(Math.min(844, 390), "ios");
  assert.equal(phoneLandscape.compact, true, "844×390 (short side 390) is compact");
  assert.equal(phoneLandscape.showTabBar, true, "landscape phone keeps the tab bar");

  // iPad 11" landscape: 1180×820 — short side 820 ≥ 700 keeps the regular
  // arrangement, exactly as portrait (834×1194 → short side 834) does.
  const ipadLandscape = paneLayout(Math.min(1180, 820), "ios");
  assert.equal(ipadLandscape.compact, false, "1180×820 (short side 820) stays regular");
  assert.equal(ipadLandscape.showTabBar, false);

  // iPad narrow Split View (~320-500 wide): compact exactly as before.
  assert.equal(paneLayout(Math.min(375, 820), "ios").compact, true, "narrow Split View is compact");

  // Desktop with a SHORT window (h < 700 is common on laptops): never compact.
  const shortDesktop = paneLayout(Math.min(1440, 640), "desktop");
  assert.equal(shortDesktop.compact, false, "a short desktop window never compacts");
  assert.equal(shortDesktop.showTabBar, false);
});
