// §22.2 History as a sidebar section — recent chats moved out of the
// ChatPanel's header drawer into HistoryNav, mounted by the SectionFlyout via
// the registry. The pure seams are exercised for real (the new
// conversationsAllContexts selector; grouping has its own suite in
// historyGrouping.test.mjs); the JSX surfaces (HistoryNav, ChatPanel,
// sidebarSections) can't load in node, so their guarantees are asserted
// structurally against the source — the recipesNavUi/investigationsUi house
// style. Live behavior is the E2E pass.
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
const registry = read("src/shell/sidebarSections.tsx");

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

test("History is the FIRST registered sidebar section, mounting HistoryNav", () => {
  assert.match(registry, /import \{ HistoryNav \} from "@\/features\/chat\/HistoryNav";/);
  // First row of SIDEBAR_SECTIONS, directly above What stands out.
  assert.match(
    registry,
    /SIDEBAR_SECTIONS: SidebarSection\[\] = \[\s*\{ id: "history", label: "History", icon: HistoryRegular, Component: HistoryNav \},\s*\{ id: "insights"/,
    "history leads the registry",
  );
});

test("HistoryNav is prop-less (the flyout mounts components bare) and reads the store directly", () => {
  assert.match(nav, /export function HistoryNav\(\) \{/, "no props — the SectionFlyout contract");
  assert.match(read("src/shell/SectionFlyout.tsx"), /<Body \/>/, "the flyout mounts it verbatim");
  for (const sel of [
    "s.conversations",
    "s.currentId",
    "s.openConversation",
    "s.renameConversation",
    "s.deleteConversation",
    "s.persistEnabled",
    "s.setPersistEnabled",
  ]) {
    assert.ok(nav.includes(sel), `reads useChatStore ${sel} directly`);
  }
});

test("the drawer body moved verbatim: persist switch + hints, search, rename, confirm delete", () => {
  assert.match(nav, /label="Save chats on this device"/);
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

test("the current chat is highlighted; opening a conversation closes the flyout", () => {
  assert.match(nav, /const active = c\.id === currentId;/);
  assert.match(nav, /active && styles\.rowActive/, "the histRowActive pattern");
  assert.match(
    nav,
    /if \(id !== currentId\) openConversation\(id\);\s*\n\s*close\(\);/,
    "open → store switch + useSidebarFlyout close()",
  );
  assert.match(nav, /useSidebarFlyout\(\(s\) => s\.close\)/);
});

test("New chat rides the existing lighthouse:new-chat seam (ChatPanel keeps its cleanup)", () => {
  assert.match(nav, /new CustomEvent\("lighthouse:new-chat"\)/);
  assert.doesNotMatch(nav, /newConversation/, "no store call — one New-chat path");
});

// --- The ChatPanel side: the old entry points are gone -----------------------

test("ChatPanel dropped the drawer, its header History button, and the hero affordance", () => {
  assert.doesNotMatch(chat, /OverlayDrawer|DrawerHeader|DrawerBody/, "the drawer is gone");
  assert.doesNotMatch(chat, /historyOpen|setHistoryOpen/, "…and its open state");
  assert.doesNotMatch(chat, /historyButton|heroHistory/, "…and both entry points");
  assert.doesNotMatch(chat, /histSearch|renamingId|confirmDeleteId/, "…and the drawer-local state");
});
