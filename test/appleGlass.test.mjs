/**
 * 0.14.0 (§31 §2) pins: glass spent sparingly — the compact tab bar and the
 * Sheet are the ONLY two glass surfaces, and the Sheet carries the full
 * bottom-sheet idiom (grabber, medium/large detents with snap, swipe-to-
 * dismiss, scrim, 26pt concentric top radius). Source pins in the house
 * style; the tab bar's own pins live in compactTabBar.test.mjs.
 *
 * Run: `node --test test/appleGlass.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const sheet = read("src/shell/Sheet.tsx");
const globals = read("app/globals.css");

test("the glass budget: backdrop-filter appears in EXACTLY the two §2 surfaces", () => {
  const hits = execSync("grep -rl backdropFilter src/ app/ --include=*.tsx --include=*.ts || true", {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    hits,
    ["src/shell/CompactTabBar.tsx", "src/shell/Sheet.tsx"],
    "glass never reaches the content layer — two chrome surfaces only",
  );
});

test("the sheet is a floating bottom panel: scrim, 26pt top radius, glass that solidifies", () => {
  assert.match(sheet, /backgroundColor: "rgba\(0, 0, 0, 0\.2\)"/, "the scrim is plain (never glass)");
  assert.match(sheet, /onClick=\{close\}/, "tap outside dismisses");
  assert.match(sheet, /borderTopLeftRadius: "var\(--lh-radius-sheet\)"/, "the 26pt concentric top");
  assert.match(
    sheet,
    /color-mix\(in srgb, var\(--lh-bg-elevated\) calc\(100% - var\(--lh-glass-sheet-mix\) \* var\(--lh-glass-level\)\), transparent\)/,
    "the theme-aware sheet floor (§7: 10% light / 3% dark) — solid at level 0",
  );
  assert.match(sheet, /overscrollBehavior: "contain"/, "body overscroll never chains to the page");
});

test("grabber + detents + swipe-to-dismiss, snaps on the bouncy spring with a haptic tick", () => {
  assert.match(sheet, /width: "36px",\s*\n\s*height: "5px"/, "the 36×5 grabber");
  assert.match(sheet, /const MEDIUM_FRACTION = 0\.55;/, "the medium detent");
  assert.match(sheet, /setPointerCapture\(e\.pointerId\)/, "drag rides pointer capture");
  assert.match(sheet, /d\.v > DISMISS_VELOCITY \|\| cur > mediumOff \+ DISMISS_SLACK/, "flick or far-drag dismisses");
  assert.match(sheet, /if \(next !== detent\) impactLight\(\);/, "detent snap ticks the light impact");
  assert.match(sheet, /var\(--lh-spring-bounce\)/, "snaps ride the overshoot spring");
  assert.match(sheet, /touchAction: "none"/, "the handle owns vertical pans; the body scrolls natively");
});

test("every close path animates out before unmount, and Esc still yields to overlays", () => {
  assert.match(sheet, /const close = useCallback\(/, "one funnel for X/Esc/scrim/swipe");
  assert.match(sheet, /window\.setTimeout\(\(\) => \{\s*\n\s*onCloseRef\.current\(\);\s*\n\s*\}, EXIT_MS\);/, "unmount waits for the exit leg");
  const selector = sheet.match(/OVERLAY_SELECTOR =\s*\n?\s*'([^']+)'/)?.[1] ?? "";
  assert.ok(selector.length > 0 && !selector.includes('[role="dialog"]'), "the 0.13.10 Esc fix survives the rewrite");
});

test("the glass highlight var exists in both themes and the tab-bar reserve includes the float gap", () => {
  assert.equal((globals.match(/--lh-glass-highlight:/g) ?? []).length, 2, "highlight tuned per theme");
  assert.match(read("src/shell/AppShell.tsx"), /TAB_BAR_CONTENT_HEIGHT \+ TAB_BAR_FLOAT_GAP/, "pages reserve content + gap");
});
