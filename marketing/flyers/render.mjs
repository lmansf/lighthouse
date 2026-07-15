// Renders the flyer HTML files to LinkedIn-ready PNGs (1080×1350 @2x = 2160×2700).
//
// One-time setup (playwright-core is a render-time tool, not a project dep;
// run it anywhere outside the repo if the full dependency install is unwanted):
//   npm install --no-save --no-package-lock playwright-core
// Then:
//   node marketing/flyers/render.mjs [flyers-dir]
//
// Uses a system Chromium if $CHROMIUM is set (or the Playwright-managed one).
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const here = process.argv[2]
  ? resolve(process.argv[2])
  : dirname(fileURLToPath(import.meta.url));
const FLYERS = [
  "lighthouse-flyer-data-analyst",
  "lighthouse-flyer-financial-analyst",
];

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const p of ["/opt/pw-browsers/chromium"]) if (existsSync(p)) return p;
  try {
    return chromium.executablePath();
  } catch {
    throw new Error("No Chromium found — set $CHROMIUM to a Chrome/Chromium binary.");
  }
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  for (const name of FLYERS) {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1350 },
      deviceScaleFactor: 2,
    });
    await page.goto("file://" + join(here, `${name}.html`));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const c = document.querySelector(".canvas");
      return c.scrollHeight - c.clientHeight;
    });
    if (overflow > 0) console.warn(`⚠ ${name}: content overflows the 1350px canvas by ${overflow}px`);
    // "exports/", not "out/" — the repo-wide gitignore swallows any out/ dir.
    const out = join(here, "exports", `${name}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    console.log("wrote", out);
    await page.close();
  }
} finally {
  await browser.close();
}
