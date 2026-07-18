/**
 * Sectioned-sidebar flyout E2E (openspec: field-patch-0.12.5 §1, tasks.md §1.7).
 *
 * Drives the running dev app in a real browser (the playwright-core +
 * bundled-chromium pattern of scripts/brand-screens.mjs / egress-proof.mjs — zero
 * cross-origin traffic) and proves the sidebar-flyout contract end to end:
 *
 *   1. The Files tree is the sidebar's top anchor (data-tour="explorer").
 *   2. Clicking a section header row opens its flyout (a labeled region) —
 *      exactly one at a time — WITHOUT disturbing the file tree (row-mount count
 *      before == after: the virtualization guard).
 *   3. Acting in it (a keyboard resize of the flyout) persists the new width.
 *   4. Esc closes the flyout; the file tree is still there, still the same rows.
 *   5. Reopen shows the persisted state; a full reload ("relaunch") keeps both
 *      the flyout width AND the reopened section — proven against a STATEFUL
 *      /api/settings mock that mirrors the desktop settings file (per-mode merge
 *      + clamp for widths, the openFlyout string, exactly like settings.ts).
 *
 * This is the shipping desktop contract exercised through the web twin's real
 * UI. It needs a running server with an onboarded state dir (a seeded scratch
 * VAULT_DIR whose profile.json is step:"done", like brand-screens.mjs expects)
 * and the bundled chromium.
 *
 * Usage:
 *   E2E_BASE=http://localhost:3000 node scripts/e2e-sidebar-flyout.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE || process.env.SCREENS_BASE || "http://localhost:3000";
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium";

// Mirror the engine clamp so the mock behaves byte-for-byte like settings.ts.
const FLYOUT_MIN = 280;
const FLYOUT_MAX = 680;
const clampFlyout = (w) => Math.min(FLYOUT_MAX, Math.max(FLYOUT_MIN, w));

/** A stateful in-memory stand-in for the desktop settings FILE. GET returns the
 *  current view; POST applies the same narrow read-modify-writes the real route
 *  does, so a reload genuinely re-reads persisted values. */
function makeSettingsMock() {
  const state = {
    desktop: true,
    uiMode: "window",
    tourShown: true, // keep the first-run tour out of the way
    explorerWidth: { window: null, widget: null },
    flyoutWidth: { window: null, widget: null },
    openFlyout: null,
  };
  return async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({ json: { ...state } });
    }
    // POST: apply flyoutWidth (per-mode merge + clamp), openFlyout (string; ""
    // clears), explorerWidth — exactly the app/api/settings/route.ts semantics.
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {
      body = {};
    }
    const fw = body.flyoutWidth;
    if (fw && (fw.mode === "window" || fw.mode === "widget") && typeof fw.width === "number") {
      state.flyoutWidth = { ...state.flyoutWidth, [fw.mode]: clampFlyout(fw.width) };
    }
    if (typeof body.openFlyout === "string") {
      state.openFlyout = body.openFlyout.trim().length > 0 ? body.openFlyout.trim() : null;
    }
    const ew = body.explorerWidth;
    if (ew && (ew.mode === "window" || ew.mode === "widget") && typeof ew.width === "number") {
      state.explorerWidth = { ...state.explorerWidth, [ew.mode]: ew.width };
    }
    return route.fulfill({ json: { ok: true, ...state } });
  };
}

/** Rows currently mounted in the virtualized file tree (the row-mount count the
 *  spec guards before/after a flyout interaction). */
const treeRowCount = (page) => page.locator("[data-tour=\"explorer\"] [data-row-name]").count();

async function run() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Quiet the first-run surfaces before any app code runs.
  await page.addInitScript(() => {
    localStorage.setItem("lighthouse.theme.mode", "light");
    localStorage.setItem("lighthouse.quickstart.shown", "1");
    localStorage.setItem("lighthouse.feedbackNudge.shown", "1");
    // Start each run from a clean flyout cache so persistence is proven by the
    // settings mock, not a stale localStorage entry.
    localStorage.removeItem("lighthouse.sidebar.flyout");
  });

  const settings = makeSettingsMock();
  await page.route("**/api/settings", settings);

  const assert = (cond, msg) => {
    if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
    console.log(`  ✓ ${msg}`);
  };

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(800);

  // 1. The Files tree is the sidebar's top anchor.
  const tree = page.locator('[data-tour="explorer"]');
  await tree.waitFor({ timeout: 15_000 });
  assert(await tree.isVisible(), "the Files tree anchors the sidebar");
  const rowsBefore = await treeRowCount(page);

  // The rail exists with the six section rows.
  const rail = page.locator("[data-section-rail]");
  await rail.waitFor({ timeout: 10_000 });
  const recipesRow = rail.getByRole("button", { name: "Recipes" });
  assert((await recipesRow.getAttribute("aria-expanded")) === "false", "the section starts collapsed");

  // 2. Open the flyout — one at a time — and the tree is undisturbed.
  await recipesRow.click();
  const flyout = page.locator("#lighthouse-section-flyout");
  await flyout.waitFor({ timeout: 10_000 });
  assert(await flyout.isVisible(), "clicking the header opens the flyout");
  assert((await recipesRow.getAttribute("aria-expanded")) === "true", "aria-expanded flips to true");
  assert((await page.locator("#lighthouse-section-flyout").count()) === 1, "exactly one flyout is open");
  const rowsWith = await treeRowCount(page);
  assert(rowsWith === rowsBefore, `file-tree row-mount count is unchanged (${rowsBefore} == ${rowsWith})`);

  // 3. Act in it: keyboard-resize the flyout to a known width, then read it back.
  const handle = page.getByRole("separator", { name: /Resize section panel/ });
  await handle.focus();
  await handle.press("Home"); // jump to the min bound (a deterministic width)
  await page.waitForTimeout(200);
  const widthAtMin = await flyout.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert(Math.abs(widthAtMin - FLYOUT_MIN) <= 2, `Home resizes the flyout to the min bound (${widthAtMin})`);
  for (let i = 0; i < 3; i += 1) await handle.press("ArrowRight"); // widen by 3×24px
  await page.waitForTimeout(500); // let the debounced settings POST land
  const widened = await flyout.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert(widened > widthAtMin, `ArrowRight widens the flyout (${widthAtMin} → ${widened})`);

  // 4. Esc closes; the tree is still intact.
  await page.keyboard.press("Escape");
  await flyout.waitFor({ state: "detached", timeout: 5_000 });
  assert((await page.locator("#lighthouse-section-flyout").count()) === 0, "Esc closes the flyout");
  assert((await treeRowCount(page)) === rowsBefore, "the file tree is unaffected by the flyout lifecycle");

  // 5a. Reopen shows the persisted width (no reload).
  await recipesRow.click();
  await flyout.waitFor({ timeout: 10_000 });
  const reopened = await flyout.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert(Math.abs(reopened - widened) <= 2, `reopen restores the persisted width (${widened} ≈ ${reopened})`);

  // 5b. Relaunch (full reload): the settings mock is the only persistence, so a
  // restored width + reopened section prove the durable round-trip.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1000);
  const flyoutAfter = page.locator("#lighthouse-section-flyout");
  await flyoutAfter.waitFor({ timeout: 10_000 });
  const afterReload = await flyoutAfter.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  assert(Math.abs(afterReload - widened) <= 2, `relaunch keeps the flyout width (${widened} ≈ ${afterReload})`);
  assert(await flyoutAfter.isVisible(), "relaunch reopens the persisted section");
  assert((await treeRowCount(page)) === rowsBefore, "the file tree still holds its rows after relaunch");

  await ctx.close();
  await browser.close();
  console.log("\nsidebar-flyout E2E passed");
}

run().catch((e) => {
  console.error("e2e-sidebar-flyout error:", e);
  process.exit(1);
});
