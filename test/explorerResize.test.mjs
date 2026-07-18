/**
 * Resizable explorer (openspec: add-usability-field-patch §1). The engine owns
 * the persisted width; its exhaustive round-trip is pinned in Rust
 * (native/.../tests/settings_test.rs::explorer_width_persists_per_mode_and_clamps).
 * This suite pins the CLIENT half in the *Ui.test house style: the TS twin
 * (src/server/settings.ts) is round-tripped FOR REAL against a scratch settings
 * file — byte-for-byte the Rust behavior (clamp at write AND read, per-mode
 * merge, junk ignored) — and the React surfaces (which can't load in node) are
 * asserted structurally against their source. The live built-app relaunch is
 * the deferred E2E; the web localStorage cache carries reload persistence.
 *
 * Run: `node --test test/explorerResize.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const {
  EXPLORER_WIDTH_MIN,
  EXPLORER_WIDTH_MAX,
  explorerWidth,
  setExplorerWidth,
  readDesktopSettings,
} = await import("../src/server/settings.ts");

/** Point the twin at a fresh scratch settings file seeded with `seed`. */
function seedSettings(seed) {
  const dir = mkdtempSync(path.join(tmpdir(), "lh-explorer-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(seed));
  process.env.LIGHTHOUSE_SETTINGS_FILE = file;
  return file;
}

// --- A. The bounds mirror the engine ----------------------------------------

test("width bounds mirror the engine (PARITY: EXPLORER_WIDTH_MIN/MAX)", () => {
  assert.equal(EXPLORER_WIDTH_MIN, 200);
  assert.equal(EXPLORER_WIDTH_MAX, 720);
});

// --- B. Per-mode round-trip, merge, clamp-at-write, junk ignored -------------

test("the twin round-trips per mode, merges siblings, clamps at write, ignores junk", () => {
  seedSettings({ vaultDir: "/somewhere/vault", widgetPos: [7, 9] });
  try {
    // Unset ⇒ null for both modes.
    assert.equal(explorerWidth(readDesktopSettings(), "window"), null);
    assert.equal(explorerWidth(readDesktopSettings(), "widget"), null);

    // In-range width round-trips for its mode and does NOT touch the sibling.
    setExplorerWidth("window", 360);
    assert.equal(explorerWidth(readDesktopSettings(), "window"), 360);
    assert.equal(explorerWidth(readDesktopSettings(), "widget"), null);

    // The sibling persists independently — a merge, not a clobber.
    setExplorerWidth("widget", 280);
    let s = readDesktopSettings();
    assert.equal(explorerWidth(s, "widget"), 280);
    assert.equal(explorerWidth(s, "window"), 360);

    // Clamp at write: above MAX and below MIN both saturate.
    setExplorerWidth("window", 100000);
    assert.equal(explorerWidth(readDesktopSettings(), "window"), EXPLORER_WIDTH_MAX);
    setExplorerWidth("window", 1);
    assert.equal(explorerWidth(readDesktopSettings(), "window"), EXPLORER_WIDTH_MIN);

    // Unknown mode / non-finite width leave the file untouched.
    setExplorerWidth("sidebar", 300);
    setExplorerWidth("window", Number.NaN);
    s = readDesktopSettings();
    assert.equal(explorerWidth(s, "window"), EXPLORER_WIDTH_MIN); // unchanged
    assert.equal(explorerWidth(s, "widget"), 280); // unchanged
    assert.equal(s.explorerWidth?.sidebar, undefined);

    // Shell-owned + unmodeled keys survive the narrow read-modify-write.
    assert.equal(s.vaultDir, "/somewhere/vault");
    assert.deepEqual(s.widgetPos, [7, 9]);
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

// --- C. Clamp at READ, too (a hand-written out-of-range file) ----------------

test("the twin clamps an out-of-range file at read", () => {
  seedSettings({ explorerWidth: { window: 9999, widget: 1 } });
  try {
    const s = readDesktopSettings();
    assert.equal(explorerWidth(s, "window"), EXPLORER_WIDTH_MAX);
    assert.equal(explorerWidth(s, "widget"), EXPLORER_WIDTH_MIN);
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

// --- D. The React wiring (structural — the JSX can't load in node) -----------

test("AppShell wires the resize divider, per-mode persistence, and auto-fit", () => {
  const src = read("src/shell/AppShell.tsx");
  // The ARIA window-splitter divider between sidebar and main.
  assert.match(src, /role="separator"/);
  assert.match(src, /aria-orientation="vertical"/);
  assert.match(src, /aria-valuenow=\{width\}/);
  // Pointer drag + keyboard resize.
  assert.match(src, /onPointerDown=\{onHandlePointerDown\}/);
  assert.match(src, /onKeyDown=\{onHandleKeyDown\}/);
  // Per-window-mode cache + settings-file persistence.
  assert.match(src, /lighthouse\.explorer\.width/);
  assert.match(src, /explorerWidth:\s*\{\s*mode,\s*width/);
  // Double-click auto-fit request + result round-trip.
  assert.match(src, /lighthouse:explorer-autofit"/);
  assert.match(src, /lighthouse:explorer-autofit-result/);
});

test("Sidebar rides the width CSS var and suppresses the transition mid-drag", () => {
  const src = read("src/shell/Sidebar.tsx");
  assert.match(src, /var\(--sidebar-w/); // dynamic width via inline var
  assert.match(src, /"--sidebar-w":\s*`\$\{width\}px`/);
  assert.match(src, /resizing\s*\?\s*\{\s*transitionProperty:\s*"none"\s*\}/);
});

test("FileExplorer enriches the title as a primitive + measures for auto-fit", () => {
  const src = read("src/features/explorer/FileExplorer.tsx");
  // A primitive string prop to the existing native title — NOT a per-row Tooltip.
  assert.match(src, /titleText:\s*string/);
  assert.match(src, /title=\{titleText\}/);
  assert.match(src, /data-row-name/);
  // Canvas-metrics auto-fit, replying with an absolute width.
  assert.match(src, /lighthouse:explorer-autofit"/);
  assert.match(src, /measureText/);
  assert.match(src, /lighthouse:explorer-autofit-result/);
});
