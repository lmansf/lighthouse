/**
 * Investigations UI wiring (openspec: add-investigations §4.1–4.2).
 *
 * The surfaces are JSX modules the node runner cannot import — so, like
 * chatScroll.test.mjs / firstRunTour.test.mjs, the guarantees are asserted
 * structurally against the source: WHERE the investigation id rides (ask
 * opts, pin, export, the settle-time conversation-ref write) and WHAT the
 * nav does (mounts above the explorer, archives — never deletes, keeps the
 * calm neutral selection). Live behavior is the E2E pass (tasks.md §6.1).
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
const nav = read("src/features/investigations/InvestigationsNav.tsx");
const store = read("src/stores/useChatStore.ts");

test("the ask carries the investigation: id in the wire opts, ref write on settle with the SAME verdict", () => {
  // Captured at ask time (a mid-stream context switch can't retarget)…
  assert.match(
    chat,
    /const investigationId = useChatStore\.getState\(\)\.currentInvestigationId \?\? undefined;/,
    "the ask captures the current investigation at send time",
  );
  // …rides the wire beside the cache controls…
  assert.match(
    chat,
    /\{ bypassCache: opts\?\.bypassCache === true, persistAllowed, investigationId \}/,
    "chatService.ask opts carry investigationId",
  );
  // …and a SUCCESSFUL settle records the conversation ref — same id, same
  // conversation, same persistAllowed — never on Stop (the abort branch owns
  // that path) and never blocking (fire-and-forget with catch).
  assert.match(
    chat,
    /markStopped\(asstId\);\s*\n\s*\} else if \(investigationId\) \{[\s\S]{0,600}addInvestigationConversationRef\(investigationId, conversationIdAtAsk, persistAllowed\)\s*\n\s*\.catch\(\(\) => \{\}\);/,
    "the conversation-ref write happens only on success, with the ask's own persistAllowed",
  );
});

test("belonging rides the actions: pin and note export both carry the current investigation", () => {
  assert.match(
    chat,
    /ragService\.pinAsk\(\s*question,\s*meta\.sql,\s*meta\.fileIds,\s*useChatStore\.getState\(\)\.currentInvestigationId \?\? undefined,\s*\)/,
    "pinAsk adopts the current investigation",
  );
  assert.match(
    chat,
    /ragService\.exportChat\(\s*title,\s*transcriptMarkdown\(msgs, title\),\s*investigationId \? \{ investigationId \} : undefined,\s*\)/,
    "exportChat routes the note into the investigation's folder",
  );
});

test("policy surfaces: provider switch disabled inside local-only, on-device badge in both headers", () => {
  assert.match(
    chat,
    /disabledReason=\{\s*investigationLocalOnly \? "This investigation always answers on-device" : undefined\s*\}/,
    "ProviderSwitch is disabled (with the reason) inside a local-only investigation",
  );
  const sw = read("src/features/chat/ProviderSwitch.tsx");
  assert.match(
    sw,
    /disabledFocusable=\{disabledReason !== undefined\}/,
    "the trigger stays focusable so the reason is announced and hoverable",
  );
  // One badge definition, rendered in the conversation headerMeta AND the hero
  // context row (outside the visible-files branch, so it can't vanish with it).
  assert.equal(
    (chat.match(/\{onDeviceBadge\}/g) ?? []).length,
    2,
    "the on-device badge renders in both headers",
  );
  assert.match(chat, /\{onDeviceBadge\}\s*\n\s*<Badge appearance="tint">\{visibleBadgeText\}<\/Badge>/,
    "conversation header: beside the visible-files badge");
});

test("the scope pill sits above the composer and shows the LIVE file count", () => {
  assert.match(
    chat,
    /currentInvestigation && scopeCount !== null \?/,
    "pill only when the investigation has a non-empty scope",
  );
  assert.match(
    chat,
    /currentInvestigation\.scopeFileIds\.filter\(\(id\) => present\.has\(id\)\)\.length/,
    "dangling scope ids are not counted",
  );
  assert.match(chat, /\{scopePill\}\s*\n\s*\{attachmentBar\}/, "pill rides the attachBar slot");
  // The history drawer filters to the current context via the pure helper.
  assert.match(
    chat,
    /conversationsForContext\(conversations, currentInvestigationId\)/,
    "the drawer list is context-filtered",
  );
});

test("the nav is a section in the sidebar registry — the Sidebar stays feature-agnostic", () => {
  // Sectioned sidebar (openspec: field-patch-0.12.5 §1): InvestigationsNav is now
  // the last section row (its flyout opens below the Files-tree anchor), listed
  // in the registry rather than stacked in app/page.tsx.
  const registry = read("src/shell/sidebarSections.tsx");
  assert.match(
    registry,
    /import \{ InvestigationsNav \} from "@\/features\/investigations\/InvestigationsNav";/,
    "the registry imports the nav",
  );
  assert.match(
    registry,
    /id: "investigations"[\s\S]*Component: InvestigationsNav/,
    "Investigations is a registered section rendering InvestigationsNav",
  );
  // It is the last row (nothing follows it in SIDEBAR_SECTIONS).
  assert.match(registry, /Component: ViewsNav[\s\S]*Component: InvestigationsNav\b[\s\S]*\];/);
  // The Sidebar itself stays feature-agnostic — the rail content comes from the
  // registry, so Sidebar.tsx never names any one section.
  assert.doesNotMatch(
    read("src/shell/Sidebar.tsx"),
    /Investigation/,
    "Sidebar.tsx is untouched by the feature",
  );
});

test("the nav is calm and non-destructive: tour anchor, plain Archive, neutral selection", () => {
  assert.match(nav, /data-tour="investigations"/, "tour anchor present");
  assert.match(nav, />\s*Archive\s*</, 'the menu says "Archive", plainly');
  assert.match(nav, /setInvestigationArchived\(id, true\)/, "archive is the visibility flag op");
  assert.doesNotMatch(
    nav,
    /deleteInvestigation|removeInvestigation|removeFromVault|DeleteRegular/,
    "no delete operation or affordance anywhere in the nav",
  );
  // The active row is the calmed explorer inset — neutral fill + hairline —
  // never an amber flood.
  assert.match(nav, /rowActive: \{\s*\n\s*backgroundColor: tokens\.colorNeutralBackground1Selected/);
  assert.doesNotMatch(
    nav,
    /rowActive: \{[^}]*colorBrand/s,
    "the selection carries no brand fill",
  );
  // v1 scope comes from the explorer's multi-select (files only) — no tree.
  assert.match(nav, /byId\.get\(id\)\?\.kind === "file"/, "folders in the selection are ignored");
});

test("the store owns the context: stamped at birth, followed on open, its own storage key", () => {
  assert.match(
    store,
    /emptyConversation\(s\.currentInvestigationId\)/,
    "New chat stamps the fresh conversation with the current investigation",
  );
  assert.match(
    store,
    /const investigationId = target\.investigationId \?\? null;\s*\n\s*saveCurrentInvestigation\(investigationId\);/,
    "opening a conversation switches the context to match it",
  );
  // The pointer persists under its OWN key — never inside the history blob.
  assert.match(store, /const INVESTIGATION_KEY = "lighthouse\.chat\.investigation";/);
  assert.doesNotMatch(
    store,
    /JSON\.stringify\(\{ conversations: keep, currentId, currentInvestigation/,
    "the history envelope does not carry the pointer",
  );
});

test("the widget stays global: no investigation machinery leaks into WidgetBar", () => {
  assert.doesNotMatch(
    read("src/features/widget/WidgetBar.tsx"),
    /investigation/i,
    "WidgetBar asks in the global context (design: the widget ignores investigations in v1)",
  );
});
