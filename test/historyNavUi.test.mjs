// §22.2 → 0.13.10 §2: History opens from the CHAT HEADER on every platform —
// a full-screen Sheet on compact, an anchored popover on desktop (the Sections
// rail that used to host it is retired). The pure seams are exercised for
// real (the conversationsAllContexts selector; grouping has its own suite in
// historyGrouping.test.mjs); the JSX surfaces (HistoryNav, ChatPanel) can't
// load in node, so their guarantees are asserted structurally against the
// source. Live behavior is verified on-device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { conversationsAllContexts } = await import("../src/stores/useChatStore.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const nav = read("src/features/chat/HistoryNav.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");

// --- The pure selector: every chat, newest first ------------------------------
// Until 0.15.0 this partitioned by investigation (own context's chats first).
// With investigations deleted there is one context, so there is one order.

const convo = (id, updatedAt) => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messages: [{ id: "u1", role: "user", content: "q" }],
});

test("conversationsAllContexts lists every conversation newest-first", () => {
  const all = [convo("old", 100), convo("new", 400), convo("mid", 300)];
  assert.deepEqual(
    conversationsAllContexts(all).map((c) => c.id),
    ["new", "mid", "old"],
  );
  // Nothing is dropped or duplicated, and the input array is not mutated.
  assert.equal(conversationsAllContexts(all).length, all.length);
  assert.deepEqual(all.map((c) => c.id), ["old", "new", "mid"], "the caller's array is untouched");
});

// --- The section: registry entry, prop-less mount, store-directness ----------

test("HistoryNav takes only onClose (the hosting surface's dismissal) and reads the store directly", () => {
  assert.match(
    nav,
    /export function HistoryNav\(\{ onClose \}: \{ onClose\?: \(\) => void \} = \{\}\)/,
    "one optional prop — the surface's close, nothing else",
  );
  for (const sel of [
    "s.conversations",
    "s.currentId",
    "s.openConversation",
    "s.renameConversation",
    "s.deleteConversation",
    "s.persistEnabled",
  ]) {
    assert.ok(nav.includes(sel), `reads useChatStore ${sel} directly`);
  }
});

test("0.13.10 §2: the persist SWITCH moved to Settings; the list keeps search/rename/delete", () => {
  // The control lives in Preferences (Settings); History only states posture.
  assert.doesNotMatch(nav, /label="Save chats on this device"/, "no switch here anymore");
  assert.doesNotMatch(nav, /setPersistEnabled/, "…and no setter wired");
  assert.match(
    read("src/features/settings/SettingsMenu.tsx"),
    /label="Save chats on this device/,
    "Preferences carries the one persist control",
  );
  assert.ok(nav.includes("Kept on this device and cleared automatically after two weeks."));
  assert.ok(nav.includes("Chats aren't being saved — they clear when you close the app."));
  assert.match(nav, /placeholder="Search chats…"/);
  assert.match(nav, /aria-label="Rename chat"/);
  assert.match(nav, /aria-label="Delete chat"/);
  assert.match(nav, />\s*Delete this chat\?\s*</, "delete keeps the inline confirm, no dialog");
});

test("date grouping: the pure helper drives Today/Yesterday/This week/Earlier headers", () => {
  assert.match(nav, /groupByRecency\(listed\)/, "buckets come from the tested lib");
  assert.match(nav, /import \{ groupByRecency, relativeTimeLabel \} from "@\/lib\/historyGrouping";/);
  assert.match(nav, /\{g\.label\}/, "the group header renders the bucket label");
});

test("one listing, no context toggle (investigations are gone)", () => {
  assert.match(nav, /conversationsAllContexts\(conversations\)/, "the single listing");
  assert.doesNotMatch(nav, /showAll|conversationsForContext/, "no scope toggle survives");
});

test("the current chat is highlighted; opening a conversation dismisses the surface", () => {
  assert.match(nav, /const active = c\.id === currentId;/);
  assert.match(nav, /active && styles\.rowActive/, "the histRowActive pattern");
  assert.match(
    nav,
    /if \(id !== currentId\) openConversation\(id\);\s*\n\s*close\(\);/,
    "open → store switch + the host surface's close",
  );
  assert.match(nav, /const close = onClose \?\? \(\(\) => \{\}\);/, "close is the onClose prop");
});

test("§43 §2: History carries NO New chat — the header is the sole entry", () => {
  // The dead duplicate in the History panel is gone; the chat header's New
  // chat (compact icon-only + desktop label, pinned in compactHeader.test.mjs)
  // is the one working entry. HistoryNav neither dispatches the seam nor calls
  // the store — one New-chat path, not two.
  assert.doesNotMatch(nav, /new CustomEvent\("lighthouse:new-chat"\)/, "no New-chat button in History");
  assert.doesNotMatch(nav, /newConversation|newChat/, "no store call and no dead style");
  assert.doesNotMatch(nav, />\s*New chat\s*</, "no New chat label in the History panel");
});

// --- The ChatPanel side: the old entry points are gone -----------------------

test("0.13.10 §2: the chat header hosts History — Sheet on compact, popover on desktop", () => {
  assert.doesNotMatch(chat, /OverlayDrawer|DrawerHeader|DrawerBody/, "the old drawer stays gone");
  assert.match(chat, /aria-label="Chat history"/, "the header clock button");
  assert.match(
    chat,
    /compactLayout && historyOpen \? \(\s*\n\s*<Sheet title="History" onClose=/,
    "compact opens the full-screen Sheet",
  );
  assert.match(
    chat,
    /<PopoverSurface className=\{styles\.historySurface\}>\s*\n\s*<HistoryNav onClose=/,
    "desktop anchors the same HistoryNav in a popover",
  );
  assert.match(chat, /\{historyButton\}\s*\n\s*<Tooltip content="Save this chat/, "beside Save/New chat");
  assert.doesNotMatch(chat, /histSearch|renamingId|confirmDeleteId/, "list state stays in HistoryNav");
});
