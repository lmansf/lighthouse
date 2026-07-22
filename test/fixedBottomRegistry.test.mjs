/**
 * §39 §1: the fixed-bottom surface registry's structural pin — the §33 nudge
 * class (a bottom-anchored surface floating over the tab bar because it never
 * consumed the shell vars) made un-repeatable. Any src/ file declaring
 * `position: "fixed"` together with a bottom offset must EITHER reference
 * --lh-tabbar-h / --lh-safe-bottom, or appear on the explicit allowlist below
 * with a reason. New surfaces: read docs/CONVENTIONS.md ("Fixed/bottom-
 * anchored surfaces") and either consume the vars or add yourself here with a
 * reason a reviewer can audit.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Desktop-only fixed surfaces that never meet the compact tab bar. */
const ALLOWLIST = new Map([
  ["src/features/quickopen/QuickOpen.tsx", "centered command palette overlay (desktop-first; no bottom anchor to the shell)"],
  ["src/features/widget/SummonHint.tsx", "widget-mode desktop surface; no compact tab bar exists in widget mode"],
  ["src/shell/VersionBadge.tsx", "desktop corner stamp; not mounted on compact"],
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test("every fixed surface with a bottom offset consumes the shell vars or is allowlisted", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    if (!/position:\s*["']fixed["']/.test(text)) continue;
    // Crude but effective: a fixed-position file that also styles a bottom
    // offset is treated as bottom-anchored. False positives join the
    // allowlist with a reason instead of weakening the pattern.
    if (!/\bbottom\b/.test(text)) continue;
    const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");
    const consumesVars = /--lh-tabbar-h|--lh-safe-bottom/.test(text);
    if (!consumesVars && !ALLOWLIST.has(rel)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Fixed bottom-anchored surface(s) without --lh-tabbar-h/--lh-safe-bottom:\n` +
      `  ${offenders.join("\n  ")}\n` +
      `Consume the shell vars or add an allowlist entry WITH a reason — see ` +
      `docs/CONVENTIONS.md ("Fixed/bottom-anchored surfaces: the registry").`,
  );
});

test("the allowlist carries no stale entries (every entry still exists and is still fixed)", () => {
  for (const [rel, reason] of ALLOWLIST) {
    const full = path.join(ROOT, rel);
    const text = readFileSync(full, "utf8"); // throws loudly if the file moved
    assert.match(
      text,
      /position:\s*["']fixed["']/,
      `${rel} is allowlisted (${reason}) but no longer position:fixed — remove the entry`,
    );
  }
});

test("the CONVENTIONS registry names the var-consuming surfaces that exist today", () => {
  const doc = readFileSync(path.join(ROOT, "docs/CONVENTIONS.md"), "utf8");
  for (const rel of [
    "src/shell/CompactTabBar.tsx",
    "src/shell/AppShell.tsx",
    "src/features/feedback/FeedbackNudge.tsx",
    "src/features/feedback/BugReport.tsx",
    "src/features/explorer/FileTileGrid.tsx",
    "src/shell/Sheet.tsx",
    "src/shell/controls/LhDialog.tsx",
  ]) {
    assert.ok(doc.includes(rel), `registry table is missing ${rel}`);
    assert.match(
      readFileSync(path.join(ROOT, rel), "utf8"),
      /--lh-tabbar-h|--lh-safe-bottom/,
      `${rel} is on the registry but no longer consumes the shell vars`,
    );
  }
});
