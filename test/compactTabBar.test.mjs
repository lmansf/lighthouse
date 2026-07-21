/**
 * fp4 §3 source pins: the compact portrait bottom tab bar (Chat · Files ·
 * Sections) is THE navigation on a mobile shell. These are text pins (the
 * component imports Fluent, which won't load under `node --test`), proving the
 * iOS-idiomatic contract can't silently regress:
 *   - fixed to the bottom, safe-area-inset-bottom aware, ≥44pt targets;
 *   - the active tab is marked (aria-current) with a filled glyph;
 *   - it slides fully out of view (and stops intercepting taps) when hidden,
 *     honoring reduced motion;
 *   - AppShell hosts it, hides it while the keyboard is up or a sheet is open,
 *     opens the Sections rail as a full page, and reserves room above the bar;
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

test("the bar is fixed to the bottom and safe-area-inset-bottom aware", () => {
  assert.match(bar, /position:\s*"fixed"/, "fixed to the viewport");
  assert.match(bar, /bottom:\s*0/, "pinned to the bottom edge");
  assert.match(
    bar,
    /paddingBottom:\s*"var\(--lh-safe-bottom/,
    "pads the home-indicator inset so the row never rides under it",
  );
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

test("hidden slides fully off-screen, stops intercepting taps, and honors reduced motion", () => {
  assert.match(bar, /hidden:\s*\{[^}]*transform:\s*"translateY\(100%\)"/s, "parks below the viewport");
  assert.match(bar, /hidden:\s*\{[^}]*pointerEvents:\s*"none"/s, "never intercepts while parked");
  assert.match(bar, /prefers-reduced-motion/, "the slide is honored off for reduced motion");
});

test("AppShell hosts the bar, hides it for keyboard/sheet, and opens Sections as a page", () => {
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
  assert.match(shell, /<SectionRail page \/>/, "the Sections tab opens the rail as a full page");
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
