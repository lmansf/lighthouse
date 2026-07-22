/**
 * 0.14.2 compact chat header (field report IMG_1672, v0.14.1 iPhone): the
 * 400pt header seated five controls plus a text button, starving the
 * title/investigation picker down to a single letter ("A…"). The fp3 §4
 * keep/cut rule applies to the header now: shield + History + icon-only New
 * chat stay one tap, the provider switch and Save-to-note demote into a More
 * menu, and desktop keeps every control inline. The JSX can't load in node,
 * so these are structural pins against the sources (the chartIt.test.mjs
 * house style).
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
const chat = read("src/features/chat/ChatPanel.tsx");
const provider = read("src/features/chat/ProviderSwitch.tsx");

// The conversation header's meta row (the region the screenshot shows).
const meta = chat.slice(
  chat.indexOf("<div className={styles.headerMeta}>"),
  chat.indexOf("<div className={styles.bodyWrap}"),
);

test("compact header keeps three one-tap actions and a More menu — nothing more", () => {
  assert.ok(meta.length > 0, "headerMeta region found");
  const compactBranch = meta.slice(0, meta.indexOf(") : ("));
  // One-tap: shield, history, icon-only New chat (aria-label carries the name).
  assert.match(compactBranch, /\{statusShield\}\s*\{historyButton\}/);
  assert.match(
    compactBranch,
    /icon=\{<IconAdd \/>\}\s*\n\s*aria-label="New chat"/,
    "New chat is icon-only at compact (no text child eating title width)",
  );
  // The overflow: a More button opening a Menu that hosts the demoted pair.
  assert.match(compactBranch, /icon=\{<IconMore \/>\} aria-label="More chat actions"/);
  assert.match(compactBranch, /<ProviderSwitch\s*\n\s*submenu/);
  assert.match(compactBranch, /Save chat to note/);
  // The demoted pair keeps its behavior: same export seam, same disabled gate.
  assert.match(compactBranch, /disabled=\{streaming \|\| exportBusy\}/);
  assert.match(compactBranch, /onClick=\{\(\) => void exportChatToNote\(\)\}/);
});

test("desktop header is unchanged: five inline controls, New chat keeps its label", () => {
  const desktopBranch = meta.slice(meta.indexOf(") : ("));
  assert.match(desktopBranch, /<ProviderSwitch\s*\n(?!\s*submenu)/, "no submenu mode on desktop");
  assert.match(desktopBranch, /\{statusShield\}\s*\{historyButton\}/);
  assert.match(desktopBranch, /aria-label="Save chat to a vault note"/);
  assert.match(desktopBranch, />\s*New chat\s*<\/Button>/, "desktop New chat keeps its text label");
});

test("ProviderSwitch's submenu mode is the same switch, retriggered", () => {
  // A nested "AI model" MenuItem trigger — same Menu state/roster/probe around it.
  assert.match(provider, /submenu = false,/);
  assert.match(
    provider,
    /\{submenu \? \(\s*\n\s*<MenuItem\s*\n\s*icon=\{<IconAI \/>\}/,
    "submenu trigger is a MenuItem with the same icon",
  );
  assert.match(provider, /secondaryContent=\{label\}/, "current provider stays visible");
  // Honesty holds in both modes: the disabled reason is announced.
  const reasons = provider.match(/aria-label=\{disabledReason \?\? `AI model: \$\{label\} — switch`\}/g) ?? [];
  assert.equal(reasons.length, 2, "both triggers carry the reason/name aria-label");
});

// The title side of the same fix: the picker truncates gracefully, so the meta
// row never starves it invisibly (minWidth: 0 lets ellipsis engage).
test("the header title keeps its ellipsis contract", () => {
  assert.match(chat, /headerTitleName:\s*\{\s*\n\s*overflow: "hidden",\s*\n\s*textOverflow: "ellipsis",\s*\n\s*whiteSpace: "nowrap",/);
});
