/**
 * §43 §4 pinned: the version number leaves the corner on compact and reappears
 * on the Settings page. The VersionBadge is a fixed bottom-anchored corner stamp
 * that does not consume the compact shell's --lh-tabbar-h/--lh-safe-bottom vars
 * (it is allowlisted in fixedBottomRegistry.test.mjs with exactly that reason),
 * so it must NOT render on compact — where it would float over the bottom tab
 * bar. Desktop and iPad-regular (both the non-compact arrangement, no tab bar)
 * keep it. These are JSX surfaces node can't mount, so the guarantees are pinned
 * structurally against the sources (the house style).
 *
 * Run: `node --test test/versionSurface.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const badge = read("src/shell/VersionBadge.tsx");
const settings = read("src/features/settings/SettingsPage.tsx");

test("VersionBadge stands down on compact (via the paneLayout verdict), not on desktop", () => {
  // It reads the SAME compact verdict the shell uses — never a UA/width sniff.
  assert.match(badge, /import \{ usePaneLayout \} from "\.\/paneLayout";/, "gates on the paneLayout verdict");
  assert.match(badge, /const \{ compact \} = usePaneLayout\(/, "reads compact from the verdict");
  // The early return hides it on compact (and still hides when no version).
  assert.match(badge, /if \(compact \|\| !version\) return null;/, "no badge on compact");
  // Still the same build-time stamp, still the fixed corner span on desktop.
  assert.match(badge, /process\.env\.NEXT_PUBLIC_APP_VERSION/);
  assert.match(badge, /position:\s*"fixed"/, "still a fixed corner surface (registry allowlist stays valid)");
});

test("the Settings page carries the always-visible version under Help & about", () => {
  // Same build-time source as VersionBadge / AboutDialog.
  assert.match(settings, /const appVersion = process\.env\.NEXT_PUBLIC_APP_VERSION;/);
  // Rendered as the quiet group footer, guarded on presence (name-only is pointless).
  assert.match(
    settings,
    /\{appVersion && \(\s*\n\s*<Text as="p" className=\{styles\.groupFooter\}>\s*\n\s*Lighthouse v\{appVersion\}/,
    "a quiet 'Lighthouse v<version>' footer",
  );
  // It sits after the Help & about group (the About row still opens the dialog).
  const aboutIdx = settings.indexOf('label="About Lighthouse"');
  const footerIdx = settings.indexOf("Lighthouse v{appVersion}");
  assert.ok(aboutIdx > 0 && footerIdx > aboutIdx, "the version footer follows the Help & about group");
});
