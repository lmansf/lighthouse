/**
 * Egress proof (privacy gate).
 *
 * Loads the running app in a real browser, intercepts EVERY outbound request,
 * exercises the flows that historically emitted ambient telemetry (onboarding
 * form + interaction + an ask attempt), and asserts that nothing left the
 * machine except the egress documented in docs/data-flows.md.
 *
 * In this test configuration nothing that legitimately egresses is triggered:
 * no cloud model is configured (the ask uses the local/extractive path), no
 * license backend is set (LICENSE_API_URL unset), no update check is forced,
 * no assets are installed, and the user presses no Send button. So the correct
 * result is ZERO cross-origin requests and, in particular, ZERO requests to the
 * retired ambient endpoints `/api/event` and `/api/usage`.
 *
 * Usage: EGRESS_BASE=http://localhost:3000 node scripts/egress-proof.mjs
 * Exits 0 when clean, 1 (printing offenders) when any forbidden request fired.
 */
import { chromium } from "playwright-core";

const BASE = process.env.EGRESS_BASE || "http://localhost:3000";
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium";

// Same-origin app traffic (the page, its assets, and the local /api transport)
// is not egress. Everything else is classified below.
function isSameOrigin(url) {
  return url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:");
}

// Endpoints that must NEVER be hit again — the deleted ambient telemetry.
const FORBIDDEN_PATHS = ["/api/event", "/api/usage"];

const requests = [];

async function main() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const page = await browser.newPage();

  await page.route("**/*", (route) => {
    requests.push(route.request().url());
    void route.continue();
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);

  // Exercise the UI the way the old click-capture + funnel telemetry watched:
  // type into any visible text field, tick/untick toggles, and click buttons.
  // Even a partial onboarding walk fires what /api/usage used to capture.
  const typeInto = async (sel, text) => {
    const el = page.locator(sel).first();
    if (await el.count()) {
      await el.fill(text).catch(() => {});
    }
  };
  await typeInto('input[type="text"]', "Test User");
  await typeInto('input[type="email"]', "tester@example.com");

  // Click a spread of interactive elements (best-effort; ignore failures).
  const clickables = await page.locator("button, [role='button'], input[type='checkbox'], a").all();
  for (const el of clickables.slice(0, 12)) {
    await el.click({ timeout: 500, trial: false }).catch(() => {});
    await page.waitForTimeout(120);
  }

  // Attempt an ask in whatever composer is present.
  const composer = page.locator("textarea").first();
  if (await composer.count()) {
    await composer.fill("What is in my vault?").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(1000);
  await browser.close();

  const external = [...new Set(requests.filter((u) => !isSameOrigin(u)))];
  const forbidden = [...new Set(requests.filter((u) => FORBIDDEN_PATHS.some((p) => u.includes(p))))];

  console.log(`observed ${requests.length} requests; ${external.length} cross-origin.`);
  if (external.length) {
    console.log("cross-origin requests:");
    for (const u of external) console.log("  " + u);
  }
  if (forbidden.length) {
    console.log("FORBIDDEN (retired ambient endpoints) were hit:");
    for (const u of forbidden) console.log("  " + u);
  }

  // Fail on any forbidden ambient endpoint, or any UNEXPECTED cross-origin host.
  // (A future config that legitimately egresses must be added to data-flows.md
  // AND to this allowlist together.)
  const ALLOWED_EXTERNAL = []; // nothing legitimately egresses in this config
  const unexpected = external.filter(
    (u) => !ALLOWED_EXTERNAL.some((host) => u.includes(host)),
  );

  if (forbidden.length || unexpected.length) {
    console.error("\nEGRESS PROOF FAILED — see offenders above.");
    process.exit(1);
  }
  console.log("\nEGRESS PROOF PASSED — no ambient egress observed.");
  process.exit(0);
}

main().catch((e) => {
  console.error("egress proof harness error:", e);
  process.exit(2);
});
