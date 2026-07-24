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

test("policy surfaces: provider switch disabled inside local-only, on-device promise in both headers", () => {
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
  // §22.2 (declutter): the standalone On-device badge collapsed into the
  // EgressShield status popover. One shield definition carries the policy flag,
  // mounted in the conversation headerMeta AND the hero (outside the
  // visible-files branch, so the promise can't vanish with it).
  assert.match(
    chat,
    /onDeviceLocalOnly=\{investigationLocalOnly\}/,
    "the shield receives the local-only policy flag",
  );
  // Hero + BOTH conversation-header arrangements (0.14.2 split the header
  // into compact and desktop branches; the shield is a keeper in each).
  assert.equal(
    (chat.match(/\{statusShield\}/g) ?? []).length,
    3,
    "the status shield renders in the hero and both header branches",
  );
  const shield = read("src/features/egress/EgressShield.tsx");
  assert.match(
    shield,
    /This investigation always answers on this device\./,
    "the shield dialog states the on-device promise",
  );
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
  // §22.2: the history list moved from the ChatPanel drawer to the sidebar
  // History section — the context filtering via the pure helper moved with it.
  assert.match(
    read("src/features/chat/HistoryNav.tsx"),
    /conversationsForContext\(conversations, currentInvestigationId\)/,
    "the History section list is context-filtered",
  );
});

test("0.13.10 §3: the nav mounts in the chat-header PICKER (Sheet on compact, popover on desktop)", () => {
  const chat = read("src/features/chat/ChatPanel.tsx");
  assert.match(
    chat,
    /import \{ InvestigationsNav \} from "@\/features\/investigations\/InvestigationsNav";/,
    "the chat header hosts the operations surface",
  );
  assert.match(
    chat,
    /<Sheet title="Investigations" onClose=\{\(\) => setInvOpen\(false\)\} initialDetent="medium">\s*\n\s*<InvestigationsNav \/>/,
    "compact opens the full InvestigationsNav in a Sheet",
  );
  assert.match(
    chat,
    /<PopoverSurface className=\{styles\.invSurface\}>\s*\n\s*(\{\/\*[\s\S]*?\*\/\}\s*\n\s*)?<InvestigationsNav \/>/,
    "desktop anchors the same surface to the title",
  );
  assert.match(chat, /aria-label="Investigations"/, "the title button announces the picker");
  // The Sidebar stays feature-agnostic — no section rail, no nav imports.
  assert.doesNotMatch(
    read("src/shell/Sidebar.tsx"),
    /Investigation/,
    "Sidebar.tsx is untouched by the feature",
  );
});

test("the nav is calm and non-destructive: plain Archive, neutral selection", () => {
  // §33 §4: the anchor was an orphan — no tour step ever targeted it (the
  // anchor floor in tourAnchors.test.mjs now guards the whole registry).
  assert.doesNotMatch(nav, /data-tour=/, "no dangling tour anchor");
  assert.match(nav, />\s*Archive\s*</, 'the menu says "Archive", plainly');
  assert.match(nav, /setInvestigationArchived\(id, true\)/, "archive is the visibility flag op");
  assert.doesNotMatch(
    nav,
    /deleteInvestigation|removeInvestigation|removeFromVault|IconTrash/,
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

test("§46: the nav offers hypothesis-seeded Scientific/Business reports, gated on an investigable table", () => {
  // Data-gated on an investigable table via the same capabilityMap shape the
  // chat chips use — no qualifying table ⇒ no launcher row.
  assert.match(
    nav,
    /reportMap\.tables\.find\(\(t\) => t\.investigable\)\?\.name \?\? null/,
    "the primary investigable table is the report target (null ⇒ no launchers)",
  );
  assert.match(nav, /\{reportTable && \(/, "the launcher row is gated on an investigable table");
  assert.match(nav, />\s*Scientific report\s*</, "a Scientific report launcher");
  assert.match(nav, />\s*Business report\s*</, "a Business report launcher");
  assert.match(nav, /onClick=\{\(\) => openReport\("imrad"\)\}/, "Scientific opens the IMRaD hypothesis prompt");
  assert.match(nav, /onClick=\{\(\) => openReport\("bluf"\)\}/, "Business opens the BLUF hypothesis prompt");
  // The hypothesis prompt (a Textarea) → Generate calls investigate with the
  // template + the current investigation + the (optional, trimmed) hypothesis.
  assert.match(nav, /aria-label="Working hypothesis"/, "the prompt takes a working hypothesis");
  assert.match(
    nav,
    /ragService\.investigate\(\s*reportTable,\s*currentInvestigationId \?\? undefined,\s*hypoTemplate,\s*hypoText\.trim\(\) \|\| undefined,\s*\)/,
    "Generate seeds the templated report with the hypothesis in the current context",
  );
  // The report body stays deterministic — the copy promises engine-computed
  // figures; the hypothesis frames only (the §44/reports digit gate enforces it).
  assert.match(
    nav,
    /Every figure is computed by\s+the engine — an optional hypothesis only frames the write-up, never the numbers\./,
    "the dialog states the numbers are engine-computed, the hypothesis frames only",
  );
});
