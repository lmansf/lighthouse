/**
 * E2E — Visual-first answers (openspec: field-patch-0.12.5 §2).
 *
 * Proves the three §2 outcomes end-to-end, in the real chat UI:
 *   1. "how many PDFs do I have"  → an inline STAT TILE (meta count),
 *   2. a synthesis ask over a profiled-table fixture → its CHART,
 *   3. a definitions-free prose ask → NO visual (the constitution ceiling).
 *
 * STATUS / HOW TO RUN: this repo does not yet vendor Playwright (no
 * `@playwright/test` dependency, no `playwright.config.ts`, no CI job), so this
 * spec is written but NOT run here — it is the executable spec 2.7 asks for.
 * The `e2e/` dir is excluded from `tsc` (tsconfig `exclude`) and from `next
 * lint`'s default scope, so it never breaks the JS gates. To wire it up:
 *   - `npm i -D @playwright/test && npx playwright install chromium`
 *   - add a `playwright.config.ts` whose `webServer` boots the app against a
 *     seeded vault (`LIGHTHOUSE_SERVE=1` on the Rust server, or `npm run dev`
 *     for the TS twin) containing: at least one PDF, and a profiled CSV
 *     `sales.csv` (Date,Region,Sales — the parity fixture) both included.
 *   - a zero-network model (LIGHTHOUSE_SMOKE=1) so the deterministic engine
 *     visuals (which do NOT depend on the model) are what's asserted.
 *
 * Selectors are the stable ones the components expose today:
 *   - StatTile:       role="img" with aria-label "<n> <kind>" (StatTile.tsx),
 *   - AnalyticsChart: <figure> with aria-label starting "<kind> chart of …".
 */

import { test, expect } from "@playwright/test";

/** Ask a question in the chat composer and wait for the answer to settle. */
async function ask(page: import("@playwright/test").Page, question: string) {
  const box = page.getByRole("textbox", { name: /ask|message|question/i }).first();
  await box.click();
  await box.fill(question);
  await box.press("Enter");
  // The turn is done when the streaming spinner clears (no per-model timing).
  await expect(page.getByText(/thinking|reading|writing a query/i)).toHaveCount(0, {
    timeout: 60_000,
  });
}

test.describe("visual-first answers (§2)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test('"how many PDFs do I have" renders a stat tile', async ({ page }) => {
    await ask(page, "how many PDFs do I have");
    // The tile carries the ENGINE count as its aria-label ("<n> PDFs"), a real
    // number the meta renderer computed from the file inventory — never prose.
    const tile = page.getByRole("img", { name: /^\d+ PDFs?$/ });
    await expect(tile).toBeVisible();
  });

  test("a synthesis ask over a profiled table renders its chart", async ({ page }) => {
    // sales.csv is a Date/Region/Sales table; the profile's region group-by
    // charts as a bar by default, drawn from the engine's own sums.
    await ask(page, "summarize sales.csv");
    const chart = page.locator("figure[aria-label*='chart of']");
    await expect(chart.first()).toBeVisible();
  });

  test("a definitions-free prose ask grows no visual", async ({ page }) => {
    await ask(page, "what does the introduction say about our mission");
    // No engine-verified quantitative data ⇒ no tile and no chart.
    await expect(page.getByRole("img", { name: /^\d+ / })).toHaveCount(0);
    await expect(page.locator("figure[aria-label*='chart of']")).toHaveCount(0);
  });
});
