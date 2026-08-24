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
  // Exactly the five inventoried call sites (the useState declaration has no
  // paren, so it doesn't count); a stray new trigger makes this go red. It was
  // ten until 0.15.0 removed the Files tab and the sidebar it paged in — the
  // open-drawer seam, the file-opened auto-return, the Mod+B toggle, the
  // reveal-node jump and the Sidebar's collapse prop all went with them.
  assert.equal(sites.length, 5, "the five inventoried call sites");
  for (const [pattern, why] of [
    [/const \[compactTab, setCompactTab\] = useState<CompactTab>\("chat"\);/, "the declaration"],
    [/e\.preventDefault\(\);\s*\n\s*setCompactTab\("chat"\);/, "Esc returns to Chat"],
    [/const onUserAsk = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("chat"\);/, "§34 user-ask intent"],
    [/const onPrefs = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("settings"\);/, "open-preferences"],
    [/const onStartTour = \(\) => \{\s*\n\s*if \(compactRef\.current\) setCompactTab\("chat"\);/, "§33 tour replay"],
    [/setCompactTab\(tab\);/, "the tab bar tap itself"],
  ]) {
    assert.match(shell, pattern, `inventoried trigger present: ${why}`);
  }
});
