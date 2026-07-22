/**
 * §34: the compact shell is a TAB navigation, not a stack — no gesture or
 * observer may yank the user off a page, tab roots carry no Back, and the
 * Files page carries no stray Settings gear. The shell is JSX (node can't
 * mount it), so the guarantees are pinned structurally against the sources
 * (the chartIt.test.mjs house style); the scroll-torture pass is the
 * on-device acceptance run.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const shell = read("src/shell/AppShell.tsx");
const sidebar = read("src/shell/Sidebar.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");

test("§1a: the naive edge-swipe is DELETED, not hardened", () => {
  for (const gone of ["onDrawerTouchStart", "onDrawerTouchEnd", "touchStartX"]) {
    assert.ok(!shell.includes(gone), `${gone} must not exist in AppShell`);
  }
  // Neither compact page wires ANY touch handler of its own.
  assert.ok(!shell.includes("onTouchStart={on"), "no page-level touch wiring remains");
  // Sheets keep their own proper pointer-captured swipe-dismiss, untouched.
  const sheet = read("src/shell/Sheet.tsx");
  assert.match(sheet, /setPointerCapture|onPointerDown/, "Sheet's own dismiss gesture stays");
});

test("§1b: auto-return is explicit intent — the ask event, never message-list observation", () => {
  // The old observer is gone root and branch: AppShell no longer reads the
  // chat store AT ALL, so no store-level append can ever switch tabs.
  assert.ok(!shell.includes("messages.length"), "no message-length observation");
  assert.ok(!shell.includes("prevMessageCount"), "the observer's ref is gone");
  assert.ok(!shell.includes("useChatStore"), "AppShell is fully decoupled from the chat store");
  // The intent signal: ChatPanel's ONE ask entry dispatches; AppShell listens.
  assert.match(
    chat,
    /if \(!q \|\| streaming\) return;\s*\n\s*\/\/ §34 §1b[\s\S]{0,200}window\.dispatchEvent\(new CustomEvent\(USER_ASK_EVENT\)\);/,
    "sendQuestion announces intent right after its guard (chip + event asks funnel here)",
  );
  assert.match(
    shell,
    /const onUserAsk = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("chat"\);\s*\n\s*\};\s*\n\s*window\.addEventListener\(USER_ASK_EVENT, onUserAsk\);/,
    "AppShell returns to Chat on the intent event (compact only)",
  );
  const signals = read("src/shell/shellSignals.ts");
  assert.match(signals, /export const USER_ASK_EVENT = "lighthouse:user-ask";/);
});

test("§1c inventory: every setCompactTab call site is a known, intended trigger", () => {
  const sites = shell.match(/setCompactTab\(/g) ?? [];
  // Exactly the ten inventoried call sites (the useState declaration has no
  // paren, so it doesn't count); a stray new trigger makes this go red.
  assert.equal(sites.length, 10, "the ten inventoried call sites");
  for (const [pattern, why] of [
    [/const \[compactTab, setCompactTab\] = useState<CompactTab>\("chat"\);/, "the declaration"],
    [/const onOpen = \(\) => setCompactTab\("files"\);/, "open-drawer event (legacy header seam)"],
    [/e\.preventDefault\(\);\s*\n\s*setCompactTab\("chat"\);/, "Esc returns to Chat"],
    [/const close = \(\) => setCompactTab\("chat"\);/, "a file opening returns to Chat"],
    [/const onUserAsk = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("chat"\);/, "§34 user-ask intent"],
    [/const onPrefs = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("settings"\);/, "open-preferences"],
    [/const onStartTour = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("chat"\);/, "§33 tour replay"],
    [/setCompactTab\(tab\);/, "the tab bar tap itself"],
    [/setCompactTab\(\(t\) => \(t === "files" \? "chat" : "files"\)\);/, "Mod+B files toggle"],
    [/const onReveal = \(\) => \{\s*\n\s*\/\/ §5\/fp4 §3[\s\S]{0,120}setCompactTab\("files"\);/, "reveal-node"],
    [/onToggleCollapsed=\{\(\) => setCompactTab\("chat"\)\}/, "Sidebar's required prop (no compact control invokes it since §34)"],
  ]) {
    assert.match(shell, pattern, `inventoried trigger present: ${why}`);
  }
});

test("§2: tab roots carry NO Back — titles stay, Esc stays, desktop untouched", () => {
  assert.ok(!shell.includes("IconBack"), "AppShell renders no Back control");
  assert.ok(!shell.includes('aria-label="Back to chat"'), "the aria-label left with it");
  assert.ok(!sidebar.includes("IconBack"), "Sidebar renders no Back control");
  assert.match(shell, /<Text weight="semibold">Settings<\/Text>\s*\n\s*<\/div>/, "the Settings title stays, alone");
  // Esc keeps returning to Chat (hardware keyboards / iPad).
  assert.match(shell, /if \(e\.key !== "Escape"\) return;\s*\n\s*if \(anySheetOpen\(\)\) return;\s*\n\s*e\.preventDefault\(\);\s*\n\s*setCompactTab\("chat"\);/);
  // Desktop/iPad-regular byte-identical: the desktop tree never had a Back —
  // the collapse chevron remains its trailing control.
  assert.match(sidebar, /aria-label="Collapse sidebar"/, "desktop chevron intact");
});

test("§3: no Settings gear under the Files tab; desktop's footer byte-for-byte", () => {
  // The footer (gear + label) renders only off the compact page…
  assert.match(
    sidebar,
    /\{!compactPage && \(\s*\n\s*<div className=\{mergeClasses\(styles\.footer, collapsed && styles\.footerCollapsed\)\}>\s*\n\s*<SettingsMenu \/>/,
    "the footer gear is gated off the compact Files page",
  );
  assert.match(sidebar, />\s*Settings\s*<\/Text>/, "desktop's footer label text unchanged");
  // …and AppShell's compact files branch is the ONLY caller that sets the flag.
  assert.equal((shell.match(/compactPage\b/g) ?? []).length, 1, "one compactPage call site (the files page)");
  assert.ok(!read("src/features/widget/WidgetBar.tsx").includes("compactPage"), "widget untouched");
  // UpdateNotice + VersionBadge untouched by the gate.
  assert.match(sidebar, /\{collapsed \? <UpdateNotice collapsed \/> : <UpdateNotice \/>\}/);
});

test("the quick-open launcher gate survived the prop rename (fp3 §5 behavior intact)", () => {
  assert.match(sidebar, /\{!compactPage && \(\s*\n\s*<Tooltip content="Quick open a file"/, "compact page keeps the tile grid's pull-down as its one finder");
});
