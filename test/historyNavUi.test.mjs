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

const { conversationsAllContexts, conversationsForContext } = await import(
  "../src/stores/useChatStore.ts"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const nav = read("src/features/chat/HistoryNav.tsx");
const chat = read("src/features/chat/ChatPanel.tsx");

// --- The pure selector: All chats, current context first ---------------------

const convo = (id, investigationId, updatedAt) => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messages: [{ id: "u1", role: "user", content: "q" }],
  ...(investigationId ? { investigationId } : {}),
});

test("conversationsAllContexts lists the current context first, newest-first per partition", () => {
  const all = [
    convo("g-old", null, 100),
    convo("a-new", "inv-1", 400),
    convo("b-new", "inv-2", 500),
    convo("g-new", null, 300),
    convo("a-old", "inv-1", 200),
  ];
  assert.deepEqual(
    conversationsAllContexts(all, "inv-1").map((c) => c.id),
    ["a-new", "a-old", "b-new", "g-new", "g-old"],
    "own chats lead (newest first), then everything else (newest first)",
  );
  // The global context leads with the unassigned chats.
  assert.deepEqual(
    conversationsAllContexts(all, null).map((c) => c.id),
    ["g-new", "g-old", "b-new", "a-new", "a-old"],
  );
  // Nothing is dropped or duplicated, and membership agrees with the exact filter.
  const listed = conversationsAllContexts(all, "inv-1");
  assert.equal(listed.length, all.length);
  assert.deepEqual(
    listed.slice(0, 2).map((c) => c.id).sort(),
    conversationsForContext(all, "inv-1").map((c) => c.id).sort(),
    "the leading partition IS the exact-context set",
  );
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

test("scoped listing first, with the All-chats toggle widening to every context", () => {
  assert.match(nav, /conversationsForContext\(conversations, currentInvestigationId\)/);
  assert.match(nav, /conversationsAllContexts\(conversations, currentInvestigationId\)/);
  assert.match(nav, /checked=\{showAll\}/, "the toggle is stateful");
  assert.match(nav, />\s*All chats\s*</, "…and labeled plainly");
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

test("New chat rides the existing lighthouse:new-chat seam (ChatPanel keeps its cleanup)", () => {
  assert.match(nav, /new CustomEvent\("lighthouse:new-chat"\)/);
  assert.doesNotMatch(nav, /newConversation/, "no store call — one New-chat path");
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
