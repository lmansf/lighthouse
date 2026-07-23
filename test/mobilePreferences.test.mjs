/**
 * §43 §5 pinned: the desktop-SHELL cluster in Preferences is form-factor-gated
 * on platformKind(), not the `desktop` capability flag. `desktop` means
 * "embedded shell" and is TRUE on the iOS Tauri shell too (see
 * contracts/services.ts), so it wrongly surfaced the Interface (window/widget)
 * choice, the tray/background-conserve toggle, the global summon shortcut and
 * whisper on iOS — all of which drive the desktop floating bar + tray + global
 * key listeners and are inert on a phone. platformKind() === "desktop" is the
 * real form-factor truth. The feature toggles above the cluster (semantic
 * search, OCR, draft, briefings) are NOT shell chrome and stay `desktop`-gated.
 *
 * Byte-pinned copy is unchanged; a real iPhone/iPad WidgetKit widget is §44.
 *
 * Run: `node --test test/mobilePreferences.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const menu = readFileSync(path.join(ROOT, "src/features/settings/SettingsMenu.tsx"), "utf8");

test("the desktop-shell cluster gates on platformKind() === \"desktop\", not the shell flag", () => {
  for (const [guard, why] of [
    [/\{platformKind\(\) === "desktop" && \(\s*\n\s*<Field label="Interface">/, "the Interface (window/widget) choice"],
    [/\{platformKind\(\) === "desktop" && uiMode !== "widget" && \(/, "background-conserve (tray)"],
    [/\{platformKind\(\) === "desktop" && \(\s*\n\s*<>\s*\n\s*<LhSwitch\s*\n\s*checked=\{locks\?\.auditLogOn/, "the local audit-log toggle"],
    [/\{platformKind\(\) === "desktop" && locks\?\.widgetHotkeysOff && \(/, "the managed-off summon shortcut note"],
    [/\{platformKind\(\) === "desktop" && hotkeyOk && !locks\?\.widgetHotkeysOff && \(/, "the summon-shortcut recorder"],
    [/\{platformKind\(\) === "desktop" && whisperCapable && !locks\?\.widgetHotkeysOff && \(/, "whisper summon"],
  ]) {
    assert.match(menu, guard, `form-factor-gated: ${why}`);
  }
});

test("the shell flag no longer gates any desktop-shell-chrome block", () => {
  // The floating-bar/tray/summon/whisper guards must not read the raw `desktop`
  // flag anymore; each is now platformKind()-gated. (The feature toggles keep it.)
  assert.doesNotMatch(menu, /\{desktop && \(\s*\n\s*<Field label="Interface">/, "Interface no longer shell-gated");
  assert.doesNotMatch(menu, /\{desktop && uiMode !== "widget" && \(/, "background-conserve no longer shell-gated");
  assert.doesNotMatch(menu, /\{desktop && whisperCapable/, "whisper no longer shell-gated");
  assert.doesNotMatch(menu, /\{desktop && hotkeyOk && !locks\?\.widgetHotkeysOff/, "recorder no longer shell-gated");
  assert.doesNotMatch(menu, /\{desktop && locks\?\.widgetHotkeysOff && \(/, "managed-off note no longer shell-gated");
});

test("the non-chrome feature toggles stay `desktop`-gated (out of §5 scope)", () => {
  // Semantic search, OCR, draft answers, briefings run on the engine and are not
  // desktop-shell chrome — they keep the capability-flag gate, untouched by §5.
  assert.match(menu, /\{desktop && \(\s*\n\s*<LhSwitch\s*\n\s*checked=\{semanticSearch\}/, "semantic search stays desktop-gated");
  assert.match(menu, /\{desktop && \(\s*\n\s*<LhSwitch\s*\n\s*checked=\{draftAnswers\}/, "draft answers stays desktop-gated");
});

test("byte-pinned Interface/widget copy is unchanged (labels move only with their pins)", () => {
  assert.match(menu, /<Radio value="window" label="Window mode — the regular app window" \/>/);
  assert.match(
    menu,
    /label="Widget mode \(experimental\) — a floating search bar lives on your desktop; the main window stays in the tray until you open it"/,
  );
});
