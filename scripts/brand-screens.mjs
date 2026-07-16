/**
 * Brand screenshot matrix (0.12.0 Beam identity).
 *
 * Drives the running dev app in a real browser and captures every major
 * surface in BOTH themes into docs/brand/ — the release-PR evidence that the
 * rebrand holds together. Sibling of scripts/egress-proof.mjs (same
 * playwright-core + bundled-chromium pattern; zero cross-origin traffic).
 *
 * The Beam ANSWER CARD is captured through the real rendering path by
 * intercepting POST /api/chat and streaming byte-exact engine wire shapes
 * (the NDJSON a Rust analytics answer produces: result table + "Query used"
 * fence + freshness footer + lighthouse-chart fence + analytics/provenance
 * meta). Analytics is Rust-engine-only, so the web twin can't compute one
 * live — but the PIXELS here are the genuine UI rendering genuine shapes.
 *
 * Usage (two passes against differently-seeded servers):
 *   SCREENS_BASE=http://localhost:3000 node scripts/brand-screens.mjs          # onboarded set
 *   FRESH=1 SCREENS_BASE=http://localhost:3000 node scripts/brand-screens.mjs  # onboarding shots
 * The onboarded pass expects profile.json step:"done" in the server's state
 * dir (seed a scratch VAULT_DIR and write it); the FRESH pass expects a clean
 * state dir so the app lands on the onboarding panel.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.SCREENS_BASE || "http://localhost:3000";
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium";
const OUT = "docs/brand";
const FRESH = process.env.FRESH === "1"; // capture onboarding-only run

// Byte-exact engine wire shapes for one Beam analytics answer (mirrors the
// synth.rs single-query path: markdown table → Query used → Computed from,
// then the engine-built lighthouse-chart fence, then the final chunk).
const SQL = "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC";
const CHART =
  '{"kind":"bar","series":[{"name":"total","values":[1240000.0,980500.0,875250.0,640900.0]}],"x":["Northeast","Northwest","Southeast","Southwest"]}';
const ANSWER_MD =
  "Revenue held steady across the four regions, with the Northeast leading at $1.24M.\n" +
  "\n" +
  "| region | total |\n" +
  "| --- | --- |\n" +
  "| Northeast | 1,240,000 |\n" +
  "| Northwest | 980,500 |\n" +
  "| Southeast | 875,250 |\n" +
  "| Southwest | 640,900 |\n" +
  "\n" +
  // The engine's direct_footer/freshness_line shapes, byte-for-byte:
  // emphasis label + sql fence + curly-quoted freshness, then the trailing
  // chart fence exactly as synth.rs appends it.
  `*Query used:*\n\`\`\`sql\n${SQL}\n\`\`\`\n` +
  "*Computed from:* “sales 2026.csv” (saved 2 hours ago)\n" +
  `\n\`\`\`lighthouse-chart\n${CHART}\n\`\`\`\n`;

function ndjsonAnswer() {
  const chunks = [
    { delta: ANSWER_MD, done: false },
    {
      delta: "",
      references: [
        { fileId: "sales 2026.csv", name: "sales 2026.csv", snippet: "region,amount", score: 1.0, kind: "file" },
      ],
      analytics: { sql: SQL, fileIds: ["sales 2026.csv"] },
      meta: { origin: "device", excerptCount: 2, sourceFileCount: 1 },
      done: true,
    },
  ];
  return chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
}

const shot = async (page, name, theme) => {
  await page.waitForTimeout(450); // settle fonts/layout
  await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
  console.log(`  ✓ ${name}-${theme}.png`);
};

async function captureTheme(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // Theme + quiet first-run surfaces before any app code runs.
  await page.addInitScript((mode) => {
    localStorage.setItem("lighthouse.theme.mode", mode);
    localStorage.setItem("lighthouse.quickstart.shown", "1");
    localStorage.setItem("lighthouse.feedbackNudge.shown", "1");
  }, theme);
  // The Beam answer card: real UI, byte-exact engine shapes.
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjsonAnswer() }),
  );
  // Keep the tour from auto-opening over the main-window shots (it has its
  // own dedicated capture below via the start event).
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") {
      const res = await route.fetch();
      const body = await res.json();
      return route.fulfill({ json: { ...body, tourShown: true } });
    }
    return route.continue();
  });

  // domcontentloaded (not networkidle — the dev server's HMR socket keeps the
  // network busy forever), then wait for the hydrated app to paint real text.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, null, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1000);

  if (FRESH) {
    await shot(page, "onboarding", theme);
    await ctx.close();
    return;
  }

  // 1. Main window (shell + explorer + empty chat).
  await shot(page, "main-window", theme);

  // 2. Chat with the Beam answer card. The full answer story (question, prose,
  // card with table/disclosure/freshness/chart, refinement chips, related
  // files, provenance stamp) runs ~1150px tall — give this one shot a taller
  // desktop window so a single frame holds it, then restore the standard frame.
  await page.setViewportSize({ width: 1440, height: 1240 });
  const composer = page.locator("textarea").first();
  await composer.fill("total revenue by region");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".lh-answer-card", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page
    .getByText("Answered on this device", { exact: true })
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await shot(page, "chat-beam-answer", theme);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 3. First-run tour (manual re-entry event; ignores tourShown).
  await page.evaluate(() => window.dispatchEvent(new Event("lighthouse:start-tour")));
  await shot(page, "tour", theme);
  await page.keyboard.press("Escape");

  // 4. Settings (Preferences dialog).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lighthouse:open-preferences")));
  await shot(page, "settings", theme);
  await page.keyboard.press("Escape");

  // 5. Explorer focus (widen the sidebar story: quick-open over the tree).
  await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
  await page.waitForTimeout(300);
  await page.keyboard.type("sales");
  await shot(page, "quick-open", theme);
  await page.keyboard.press("Escape");

  // 6. Widget window, framed at the shell's real pill size (main.rs
  // WIDGET_WIDTH 560; height grows as the dropdown expands — 420 shows pill +
  // results). The pill is icons + an input, so wait for the input, then type
  // a query so the shot tells the summon-and-search story.
  await page.setViewportSize({ width: 560, height: 420 });
  await page.goto(`${BASE}/widget`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const pillInput = page.getByPlaceholder(/Search your files/);
  await pillInput.waitFor({ timeout: 30_000 });
  // The summon pattern re-focuses AND select-alls the input on focus events
  // (WidgetBar armInput), which can swallow just-typed text in a driven
  // browser — fill in one shot and re-fill until the value sticks.
  for (let i = 0; i < 6; i += 1) {
    await pillInput.fill("sales");
    await page.waitForTimeout(350);
    if ((await pillInput.inputValue()) === "sales") break;
  }
  await page.waitForTimeout(500);
  await shot(page, "widget", theme);

  await ctx.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  for (const theme of ["light", "dark"]) {
    console.log(`${FRESH ? "onboarding" : "surfaces"} · ${theme}`);
    await captureTheme(browser, theme);
  }
  await browser.close();
  console.log("brand screens captured →", OUT);
}

main().catch((e) => {
  console.error("brand-screens error:", e);
  process.exit(1);
});
