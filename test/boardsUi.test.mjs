// Boards UI (openspec: add-boards §2-§4) — the pure card/board logic module
// (src/features/boards/boardModel.ts) is imported and exercised for real:
// grid span mapping, the card-list edits persisted through setBoardCards,
// stat-tile detection from engine markdown/summaries, the delta between two
// engine summaries, and the freshness line. The JSX surfaces (BoardPanel,
// BoardCard, the ChatPanel/SettingsMenu affordances) can't load in node, so
// their guarantees are asserted structurally against the source — the
// investigationsUi.test.mjs house style. Live behavior is the E2E pass (§6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const model = await import("../src/features/boards/boardModel.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// --- Grid span mapping (§4.1) ------------------------------------------------

test("spanForSize: S one track, M two, L the full row", () => {
  assert.equal(model.spanForSize("S"), "span 1");
  assert.equal(model.spanForSize("M"), "span 2");
  assert.equal(model.spanForSize("L"), "1 / -1");
});

// --- Card-order edits (§4.1: one atomic full-list replace) --------------------

const cards = () => [
  { pinId: "a", size: "S" },
  { pinId: "b", size: "M" },
  { pinId: "c", size: "L" },
];

test("moveCard swaps with the neighbor and never mutates the input", () => {
  const input = cards();
  const down = model.moveCard(input, 0, 1);
  assert.deepEqual(
    down.map((c) => c.pinId),
    ["b", "a", "c"],
  );
  const up = model.moveCard(input, 2, -1);
  assert.deepEqual(
    up.map((c) => c.pinId),
    ["a", "c", "b"],
  );
  // Sizes travel with their cards, and the caller's list is untouched.
  assert.equal(down[1].size, "S");
  assert.deepEqual(input, cards());
});

test("moveCard: falling off either end is a no-op (null — no engine call)", () => {
  assert.equal(model.moveCard(cards(), 0, -1), null);
  assert.equal(model.moveCard(cards(), 2, 1), null);
  assert.equal(model.moveCard(cards(), 3, -1), null);
  assert.equal(model.moveCard([], 0, 1), null);
});

test("reorderCard drops the dragged card at the target index", () => {
  const input = cards();
  assert.deepEqual(
    model.reorderCard(input, 0, 2).map((c) => c.pinId),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    model.reorderCard(input, 2, 0).map((c) => c.pinId),
    ["c", "a", "b"],
  );
  assert.equal(model.reorderCard(input, 1, 1), null, "same-place drop");
  assert.equal(model.reorderCard(input, 0, 3), null, "target out of range");
  assert.equal(model.reorderCard(input, -1, 0), null, "source out of range");
  assert.deepEqual(input, cards(), "input untouched");
});

test("withCardSize resizes one card; a repeat of the same size is a no-op", () => {
  const input = cards();
  const next = model.withCardSize(input, 0, "L");
  assert.equal(next[0].size, "L");
  assert.equal(next[1].size, "M", "neighbors untouched");
  assert.equal(model.withCardSize(input, 0, "S"), null, "already that size");
  assert.equal(model.withCardSize(input, 9, "M"), null);
  assert.deepEqual(input, cards());
});

test("withoutCard removes exactly one reference (never the pin — refs only)", () => {
  const input = cards();
  const next = model.withoutCard(input, 1);
  assert.deepEqual(
    next.map((c) => c.pinId),
    ["a", "c"],
  );
  assert.equal(model.withoutCard(input, 3), null);
  assert.deepEqual(input, cards(), "input untouched");
});

test("appendCard adds a size-M card by default and is idempotent per pin", () => {
  const next = model.appendCard(cards(), "d");
  assert.deepEqual(next[3], { pinId: "d", size: "M" });
  assert.equal(next.length, 4);
  const sized = model.appendCard([], "x", "L");
  assert.deepEqual(sized, [{ pinId: "x", size: "L" }]);
  assert.equal(model.appendCard(cards(), "b"), null, "already on the board");
});

// --- Stat-tile detection (§2.1: single-row/single-value) ----------------------

test("parseMarkdownTable reads the engine's GFM table", () => {
  const md = "Answer intro\n\n| region | total |\n| --- | ---: |\n| NE | 125 |\n| NW | 50 |\n";
  assert.deepEqual(model.parseMarkdownTable(md), {
    header: ["region", "total"],
    rows: [
      ["NE", "125"],
      ["NW", "50"],
    ],
  });
  assert.equal(model.parseMarkdownTable("no table here"), null);
  assert.equal(model.parseMarkdownTable("| lonely |\n| no align follows |"), null);
});

test("detectStat: a one-row one-column table is a stat, header as label", () => {
  const stat = model.detectStat("| total |\n| --- |\n| 4,200 |", undefined);
  assert.deepEqual(stat, { raw: "4,200", value: 4200, label: "total" });
});

test("detectStat: one row of label + numeric value is a stat, row as label", () => {
  const stat = model.detectStat("| region | total |\n| --- | --- |\n| West | $1,200 |", undefined);
  assert.deepEqual(stat, { raw: "$1,200", value: 1200, label: "West" });
});

test("detectStat: anything wider or taller stays a table, not a stat", () => {
  const twoRows = "| t |\n| --- |\n| 1 |\n| 2 |";
  assert.equal(model.detectStat(twoRows, undefined), null);
  const threeCols = "| a | b | c |\n| --- | --- | --- |\n| x | 1 | 2 |";
  assert.equal(model.detectStat(threeCols, undefined), null);
  const twoNumbers = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(model.detectStat(twoNumbers, undefined), null, "two numbers = a comparison");
  // The live markdown is the truth: a parseable summary never overrides it.
  assert.equal(model.detectStat(twoRows, "TOTAL 42"), null);
});

test("detectStat: a stored single-segment summary is a stat, raw token kept", () => {
  assert.deepEqual(model.detectStat(undefined, "TOTAL $4,200"), {
    raw: "$4,200",
    value: 4200,
    label: "TOTAL",
  });
  assert.equal(model.detectStat(undefined, "NE 125 · NW 50"), null, "multi-segment");
  assert.equal(model.detectStat(undefined, "just words"), null, "no numeric tail");
  assert.equal(model.detectStat(undefined, undefined), null);
});

// --- Delta between two engine summaries (§2.1, via the pinChart parsers) ------

test("statDelta subtracts comparable single-point summaries", () => {
  assert.equal(model.statDelta("TOTAL 100", "TOTAL 120"), 20);
  assert.equal(model.statDelta("TOTAL 120", "TOTAL 100"), -20);
  assert.equal(model.statDelta("TOTAL $1,000", "TOTAL $1,250"), 250);
});

test("statDelta fails closed on anything incomparable", () => {
  assert.equal(model.statDelta(undefined, "TOTAL 120"), null, "no prior");
  assert.equal(model.statDelta("A 1", "B 2"), null, "labels moved — schema change");
  assert.equal(model.statDelta("NE 1 · NW 2", "NE 2 · NW 3"), null, "multi-point");
  assert.equal(model.statDelta("TOTAL 100", "TOTAL 100"), null, "zero delta says nothing");
  assert.equal(model.statDelta("TOTAL x", "TOTAL 5"), null, "non-numeric prior");
});

// --- Freshness (§2.1: engine sentence verbatim; stored like the pins dialog) --

test("freshnessFromFooter extracts the engine's Computed-from line verbatim", () => {
  const footer =
    '*Query used:*\n```sql\nSELECT region, SUM(amount) AS total FROM sales GROUP BY region\n```\n*Computed from:* "sales.csv" (saved just now)\n';
  assert.equal(
    model.freshnessFromFooter(footer),
    'Computed from: "sales.csv" (saved just now)',
    "emphasis marks are markdown syntax; every other byte is the engine's",
  );
  assert.equal(
    model.freshnessFromFooter('Computed from: "a.csv" (saved 2h ago)'),
    'Computed from: "a.csv" (saved 2h ago)',
    "already-plain form passes through",
  );
  assert.equal(model.freshnessFromFooter("*Query used:*\n```sql\nSELECT 1\n```\n"), null);
  assert.equal(model.freshnessFromFooter(""), null);
});

test("formatCheckedRelative mirrors the pins dialog's wording", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);
  const min = 60_000;
  assert.equal(model.formatCheckedRelative(undefined, now), "not checked yet");
  assert.equal(model.formatCheckedRelative(now - 20_000, now), "checked just now");
  assert.equal(model.formatCheckedRelative(now - 5 * min, now), "checked 5m ago");
  assert.equal(model.formatCheckedRelative(now - 3 * 60 * min, now), "checked 3h ago");
  assert.equal(model.formatCheckedRelative(now - 2 * 24 * 60 * min, now), "checked 2d ago");
  // Beyond a week it's a date (locale-formatted, so shape only).
  assert.match(model.formatCheckedRelative(now - 30 * 24 * 60 * min, now), /^checked \S/);
});

test("cardFreshness: one helper for screen AND export (§5.1) — never reworded", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);
  // Live + engine footer → the footer's own Computed-from sentence verbatim.
  assert.equal(
    model.cardFreshness(
      { live: true, footer: '*Computed from:* "sales.csv" (saved just now)' },
      now,
    ),
    'Computed from: "sales.csv" (saved just now)',
  );
  // Live but the footer carries no freshness line → the checked-relative
  // fallback, never a paraphrase of engine text.
  assert.equal(
    model.cardFreshness({ live: true, footer: "*Query used:*", lastRunMs: now - 300_000 }, now),
    "checked 5m ago",
  );
  // Stored (twin) → labeled stored, never passed off as live.
  assert.equal(
    model.cardFreshness({ live: false, lastRunMs: now - 300_000 }, now),
    "stored · checked 5m ago",
  );
  assert.equal(model.cardFreshness({ live: false }, now), "stored · not checked yet");
});

// --- Structural guarantees on the JSX surfaces --------------------------------

const panel = read("src/features/boards/BoardPanel.tsx");
const card = read("src/features/boards/BoardCard.tsx");
const scope = read("src/features/boards/boardScope.ts");
const chat = read("src/features/chat/ChatPanel.tsx");
const menu = read("src/features/settings/SettingsMenu.tsx");
const page = read("app/page.tsx");

test("refresh has no scheduler and no model: open/manual/pins-changed only", () => {
  // The three triggers…
  assert.match(panel, /if \(open\) void loadBoard\(\);/, "opening the board refreshes it");
  assert.match(panel, /Refresh all/, "the manual refresh affordance exists");
  assert.match(
    panel,
    /addEventListener\("lighthouse:pins-changed"/,
    "the existing watcher relay is the third trigger",
  );
  // …and nothing else: no timers, no polling, no model-touching service.
  assert.doesNotMatch(panel, /setInterval|setTimeout/, "no timers, no polling");
  assert.doesNotMatch(panel, /chatService/, "cards never consult the model");
  assert.doesNotMatch(card, /chatService/, "cards never consult the model");
  assert.doesNotMatch(scope, /chatService/, "board CRUD never consults the model");
  assert.match(
    panel,
    /MODEL-FREE/,
    "the conserve posture (SQL re-runs are model-free, ungated) is documented",
  );
});

test("diff badges ride the pins-changed payload and hold before→after", () => {
  assert.match(panel, /ChangedPin/, "the badge state is the relay's own payload");
  assert.match(
    panel,
    /for \(const c of list\) next\[c\.id\] = c; \/\/ newest wins per pin id/,
    "retention is newest-wins per pin",
  );
  assert.match(card, /was: \$\{changed\.before\} → now: \$\{changed\.after\}/, "before→after shown");
  assert.match(card, /statDelta\(changed\.before, changed\.after\)/, "the stat delta rides it");
});

test("drill-in is the normal ask: the widget's ask-question seam, no new path", () => {
  assert.match(
    panel,
    /dispatchEvent\(\s*new CustomEvent\("lighthouse:ask-question", \{ detail: \{ question \} \}\),?\s*\)/,
    "the board dispatches the existing ask seam",
  );
  assert.match(
    chat,
    /addEventListener\("lighthouse:ask-question"/,
    "ChatPanel still owns that seam (sendQuestion — cache, provenance, conserve unchanged)",
  );
});

test("cards render engine results with the honesty postures", () => {
  assert.match(card, /parseChartSpec/, "chart card parses the engine spec");
  assert.match(card, /AnalyticsChart spec=/, "…and draws with the house chart");
  assert.match(card, /fontVariantNumeric: "tabular-nums"/, "stat numerals are tabular");
  assert.match(card, /This pin was removed\./, "tombstone copy");
  assert.match(card, /answer\.error \?\? `stale: \$\{answer\.staleReason\}`/, "staleReason posture");
  // Freshness rides the ONE shared helper (unit-tested above): live cards get
  // the engine footer's sentence verbatim, stored cards the "stored ·" label —
  // and the export uses the same function, so screen and pack can't diverge.
  assert.match(card, /cardFreshness\(answer, Date\.now\(\)\)/, "the shared freshness helper");
});

test("layout persists through setBoardCards; keyboard first, drag as extra", () => {
  assert.match(panel, /ragService\.setBoardCards\(b\.id, next\)/, "one atomic full-list replace");
  assert.match(card, /Move up/, "keyboard move controls");
  assert.match(card, /Move down/, "keyboard move controls");
  assert.match(card, /MenuItemRadio name="size"/, "size cycling via the card menu");
  assert.match(panel, /BOARD_CARD_MIME/, "drag enhancement uses the FileExplorer MIME idiom");
});

test("the board opens beside the pins entry and mounts once from the page", () => {
  assert.match(
    menu,
    /lighthouse:open-pins[\s\S]{0,700}lighthouse:open-board/,
    "the Board entry sits beside Pinned questions in the settings menu",
  );
  assert.match(panel, /addEventListener\("lighthouse:open-board"/, "the host listens for it");
  assert.match(page, /BoardHost/, "the host mounts from the composition root");
  assert.match(page, /onboarded && \(/, "…inside the onboarded-only overlay fragment");
});

test("export composes client-side and rides the allowlisted artifact path (§5.1)", () => {
  assert.match(panel, /composeBoardPack/, "the shared composer, beside composeEvidencePack");
  assert.match(
    panel,
    /standaloneChartSvg/,
    "charts are the ALREADY-RENDERED SVGs, serialized in place",
  );
  assert.match(
    panel,
    /data-lh-board-card/,
    "…captured through each card's own DOM node (the saveEvidencePack idiom)",
  );
  assert.match(card, /data-lh-board-card=\{cardRef\.pinId\}/, "the card carries the anchor");
  assert.match(panel, /cardFreshness\(answer, now\)/, "pack stamps = the screen's own helper");
  assert.match(panel, /subdir: "Lighthouse Results"/, "the strict engine-side allowlist");
  assert.match(panel, /ext: "html"/, "…as a self-contained HTML artifact");
  assert.doesNotMatch(panel, /fetch\(/, "no network of its own — exportChat is the one write");
});

test("Add to board exists at the pin-success moment and on pins-dialog rows", () => {
  assert.match(chat, /addPinToCurrentBoard/, "ChatPanel uses the shared board seam");
  assert.match(chat, /addPinNoteToBoard/, "pin-success affordance");
  assert.match(chat, /addPinRowToBoard/, "pins-dialog row affordance");
  assert.match(scope, /appendCard\(board\.cards, pinId, "M"\)/, "size M default, appended");
  assert.match(
    scope,
    /Already on/,
    "adding is idempotent — a duplicate reports instead of doubling",
  );
});
