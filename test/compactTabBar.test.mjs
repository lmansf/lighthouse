/**
 * fp4 §3 → 0.13.10 §2 source pins: the compact bottom tab bar (Chat · Files ·
 * Settings) is THE navigation on a mobile shell. These are text pins (the
 * component imports Fluent, which won't load under `node --test`), proving the
 * iOS-idiomatic contract can't silently regress:
 *   - fixed to the bottom, safe-area-inset-bottom aware, ≥44pt targets;
 *   - the active tab is marked (aria-current) with a filled glyph;
 *   - it slides fully out of view (and stops intercepting taps) when hidden,
 *     honoring reduced motion;
 *   - AppShell hosts it, hides it while the keyboard is up or a sheet is open,
 *     opens Settings as a full page, and reserves room above the bar;
 *   - the lone chat-header "open files and sections" button is gone.
 *
 * Run: `node --test test/compactTabBar.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const bar = read("src/shell/CompactTabBar.tsx");
const shell = read("src/shell/AppShell.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");
const pane = read("src/shell/paneLayout.ts");

test("the bar floats: fixed, inset from the edges, above the home indicator (§31 §2)", () => {
  assert.match(bar, /position:\s*"fixed"/, "fixed to the viewport");
  assert.match(
    bar,
    /bottom:\s*`calc\(var\(--lh-safe-bottom, 0px\) \+ \$\{TAB_BAR_FLOAT_GAP\}px\)`/,
    "hovers the float gap above the safe area (never under the indicator)",
  );
  assert.match(bar, /borderRadius\("var\(--lh-capsule\)"\)/, "the floating capsule shape");
  assert.match(bar, /maxWidth:\s*"420px"/, "a pill on landscape phones, not a plank");
});

test("targets are ≥44pt and the tab set comes from paneLayout data", () => {
  assert.match(bar, /export const TAB_BAR_CONTENT_HEIGHT = 49/, "content height is a 49pt row");
  assert.match(bar, /minHeight:\s*`\$\{TAB_BAR_CONTENT_HEIGHT\}px`/, "each tab fills the 49pt height");
  assert.match(bar, /COMPACT_TABS\.map/, "renders the paneLayout tab data (not a local list)");
});

test("the active tab is marked and uses a filled glyph", () => {
  assert.match(bar, /aria-current=\{isActive \? "page" : undefined\}/, "active tab is aria-current");
  assert.match(
    bar,
    /isActive \? TAB_ICONS\[t\.id\]\.active : TAB_ICONS\[t\.id\]\.rest/,
    "filled glyph when active, outline when not (the iOS idiom)",
  );
});

test("hidden slides fully off-screen, stops intercepting taps, and rides the motion tokens", () => {
  assert.match(
    bar,
    /hidden:\s*\{[^}]*transform:\s*`translateY\(calc\(100% \+ var\(--lh-safe-bottom, 0px\)/s,
    "parks below the viewport, clearing the float inset",
  );
  assert.match(bar, /hidden:\s*\{[\s\S]{0,400}?pointerEvents:\s*"none"/, "never intercepts while parked");
  // Motion rides the §1 spring/duration tokens, which prefers-reduced-motion
  // collapses globally (pinned in appleTokens.test.mjs).
  assert.match(bar, /transitionTimingFunction:\s*"var\(--lh-spring\)"/, "springs, not easings");
  assert.match(bar, /transitionDuration:\s*"var\(--lh-dur\)"/, "token duration (PRM-collapsible)");
});

test("§31 §2: glass capsule + scroll-minimize with top-restore", () => {
  assert.match(bar, /color-mix\(in srgb, var\(--lh-bg-secondary\) calc\(100% - 38% \* var\(--lh-glass-level\)\), transparent\)/, "the translucent mix solidifies at level 0");
  assert.match(bar, /blur\(calc\(var\(--lh-glass-blur\) \* var\(--lh-glass-level\)\)\)/, "blur scales with the level (0 = none)");
  assert.match(bar, /inset 0 0\.5px 0 var\(--lh-glass-highlight\)/, "the 0.5px inner highlight");
  assert.match(bar, /window\.addEventListener\("scroll", onScroll, true\)/, "capture-phase direction tracking (element scrolls don't bubble)");
  assert.match(bar, /if \(y <= TOP_RESTORE\)/, "scroll-to-top restores");
  assert.match(bar, /if \(dy > SCROLL_DELTA\) setMinimized\(true\);/, "scroll-down minimizes");
  assert.match(bar, /else if \(dy < -SCROLL_DELTA\) setMinimized\(false\);/, "scroll-up restores");
  assert.match(bar, /labelMinimized/, "labels collapse in the minimized capsule");
  assert.match(bar, /"lh-press"/, "tabs carry the §1 press compression");
});

test("AppShell hosts the bar, hides it for keyboard/sheet, and opens Settings as a page", () => {
  assert.match(
    shell,
    /<CompactTabBar active=\{compactTab\} onSelect=\{handleTabSelect\} hidden=\{tabBarHidden\} \/>/,
    "the shell renders the tab bar bound to the compactTab state",
  );
  assert.match(
    shell,
    /const tabBarHidden = keyboardInset > 0 \|\| editableFocused \|\| sheetOpen/,
    "the bar hides while the keyboard is up (overlay inset OR resize-mode editable focus) or a modal section sheet is open",
  );
  assert.match(shell, /<SettingsPage \/>/, "the Settings tab opens Settings as a full page");
  assert.match(shell, /aria-label="Settings"/, "the page announces itself as Settings");
  assert.match(
    shell,
    /setProperty\("--lh-tabbar-h"/,
    "the shell reserves room above the bar via the --lh-tabbar-h var",
  );
});

test("desktop is untouched: showTabBar is compact-only and never fires the reserve on desktop", () => {
  // The verdict pins live in paneLayout.test; here we just prove the wiring is
  // driven by showTabBar (compact) and not some ad-hoc width/platform check.
  assert.match(pane, /showTabBar:\s*compact/, "showTabBar === compact (structural)");
  assert.match(shell, /layout\.showTabBar/, "the reserve keys off the verdict, not a parallel signal");
});

test("the lone chat-header 'open files and sections' button is gone (the tab bar replaces it)", () => {
  assert.doesNotMatch(chat, /Open files and sections/, "the aria-label is gone");
  assert.doesNotMatch(chat, /NavigationRegular/, "its icon import is gone");
  assert.doesNotMatch(chat, /lighthouse:open-drawer/, "it no longer dispatches the open-drawer event");
});
