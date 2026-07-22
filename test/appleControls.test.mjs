/**
 * 0.14.0 (§31 §3) pins: the five replaced controls and their migration. The
 * primitives are hand-rolled or ride Fluent as a HEADLESS layer only — no
 * design system was imported — and the consumer sweep left no stray Fluent
 * geometry behind. Source pins in the house style.
 *
 * Run: `node --test test/appleControls.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const grepFiles = (pattern) =>
  execSync(`grep -rla ${JSON.stringify(pattern)} src/features/ --include=*.tsx || true`, {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();

test("no new design system: package.json gained no UI-kit dependency", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const banned of ["@radix-ui", "@base-ui", "@mui", "antd", "@chakra"]) {
    assert.ok(!deps.some((d) => d.includes(banned)), `${banned} was never added`);
  }
});

test("LhSwitch is the iOS geometry with the Fluent-shaped onChange and the haptic tick", () => {
  const sw = read("src/shell/controls/LhSwitch.tsx");
  assert.match(sw, /const TRACK_W = 51;\s*\nconst TRACK_H = 31;/, "51×31 capsule");
  assert.match(sw, /role="switch"/);
  assert.match(sw, /data: \{ checked: boolean \}/, "Fluent-shaped onChange");
  assert.match(sw, /selectionChanged\(\);/, "the selection tick");
  assert.match(sw, /colorBrandBackground/, "the tint rides the accent-aware brand token");
});

test("LhSegmented: sliding paddle, radiogroup semantics, roving arrows", () => {
  const seg = read("src/shell/controls/LhSegmented.tsx");
  assert.match(seg, /role="radiogroup"/);
  assert.match(seg, /role="radio"/);
  assert.match(seg, /translateX\(\$\{index \* 100\}%\)/, "the paddle slides");
  assert.match(seg, /ArrowRight|ArrowLeft/, "keyboard contract");
});

test("LhDialogSurface adapts: desktop 16-radius card, compact sheet geometry, one scrim", () => {
  const dlg = read("src/shell/controls/LhDialog.tsx");
  assert.match(dlg, /borderRadius\("var\(--lh-radius-surface\)"\)/, "desktop card radius");
  assert.match(dlg, /borderTopLeftRadius: "var\(--lh-radius-sheet\)"/, "compact sheet top");
  assert.match(dlg, /data-lh-grabber/, "the sheet grabber");
  assert.match(dlg, /rgba\(0, 0, 0, 0\.2\)/, "the quiet scrim");
  assert.match(dlg, /usePaneLayout\(false\)\.compact/, "the branch is compact");
});

test("LhMenu: compact action sheet with submenu pages; desktop popover skin kills the entrance", () => {
  const menu = read("src/shell/controls/LhMenu.tsx");
  assert.match(menu, /initialDetent="medium"/, "action sheets open at the medium detent");
  assert.match(menu, /setPage\(\{ title: it\.label, items: it\.submenu \}\)/, "submenus push a page");
  assert.match(menu, /animationDuration: "0\.01ms"/, "no Fluent open choreography");
  assert.match(menu, /rowDanger/, "destructive rows exist");
  assert.match(menu, /export function LhMenuPopover/, "the skin-only escape hatch for radio menus");
});

test("LhSelect: chevron-up-down affordance, checkmarks, sheet on compact", () => {
  const sel = read("src/shell/controls/LhSelect.tsx");
  assert.match(sel, /IconChevronUpDown/);
  assert.match(sel, /IconCheck/);
  assert.match(sel, /role="option"/);
  assert.match(sel, /aria-selected=\{o\.value === value\}/);
});

test("the sweep left no Fluent DialogSurface in features — every dialog rides the shared surface", () => {
  assert.deepEqual(grepFiles("<DialogSurface"), [], "no raw DialogSurface JSX remains under src/features/");
  const users = grepFiles("<LhDialogSurface");
  assert.ok(users.length >= 15, `the shared surface is the norm (${users.length} files)`);
});

test("known judgment calls hold: tooltip-ref switch stays Fluent; independent filters aren't segments", () => {
  const fx = read("src/features/explorer/FileExplorer.tsx");
  // The bulk Private switch anchors a Fluent Tooltip (ref cloning) — kept Fluent by design.
  assert.match(fx, /<Switch\b/, "exactly the tooltip-anchored switch survives");
  assert.match(fx, /<ToggleButton\b/, "the two independent boolean filters stay toggles, not segments");
  assert.match(fx, /LhMenuPopover/, "context/sort menus wear the quiet skin");
  // The §30 pinned action-row switches migrated with their expressions intact.
  const grid = read("src/features/explorer/FileTileGrid.tsx");
  assert.match(grid, /<LhSwitch\b[\s\S]{0,200}?applySelection\(Boolean\(d\.checked\)\)/, "the pinned batch op rides LhSwitch now");
});

test("the sign-in chooser and feedback kind are segments; template picker is an LhMenu", () => {
  assert.match(read("src/features/settings/SettingsMenu.tsx"), /<LhSegmented/);
  assert.match(read("src/features/feedback/BugReport.tsx"), /<LhSegmented/);
  assert.match(read("src/features/chat/InvestigateChips.tsx"), /<LhMenu/);
});
