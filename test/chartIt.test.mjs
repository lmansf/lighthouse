// "Chart it" chip (charts by default, 0.12.1) — the pure heuristic is
// exercised for real in test/chartFromTable.test.mjs; the ChatPanel JSX can't
// load in node, so the chip's guarantees are asserted structurally against
// the source — the boardsUi.test.mjs house style. The invariants: the chip
// appears only on tabular answers the ENGINE didn't chart, it is pure UI
// (zero model/network calls), the inline chart is the house renderer over the
// client-built spec, and its per-message state mirrors savedNotes (cleared on
// conversation switch, never persisted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const chat = read("src/features/chat/ChatPanel.tsx");
const heuristic = read("src/lib/chartFromTable.ts");
const chart = read("src/features/chat/AnalyticsChart.tsx");
const rust = read("native/crates/lighthouse-core/src/analytics.rs");

// The RefineChips region (the chip + its heuristic memo live here).
const refineRegion = chat.slice(
  chat.indexOf("function RefineChips"),
  chat.indexOf("/** True when a hast <pre>"),
);

test("the chip is offered from the real parsers: table → heuristic → validated spec", () => {
  assert.ok(refineRegion.length > 0, "RefineChips region found");
  // (a) the answer's GFM table via the boards module's EXPORTED parser…
  assert.match(refineRegion, /const table = parseMarkdownTable\(content\);/);
  assert.match(
    chat,
    /import \{ parseMarkdownTable \} from "@\/features\/boards\/boardModel";/,
  );
  // (b) …through the client heuristic (which round-trips parseChartSpec)…
  assert.match(refineRegion, /chartSpecFromTable\(table\)/);
  // (c) …and never when the engine already charted this answer.
  assert.match(refineRegion, /if \(metaChart \|\| hasEngineChartFence\(content\)\) return null;/);
  // Invalid/absent spec hides the chip entirely.
  assert.match(refineRegion, /\{tableChart && \(\s*<Button/);
});

test("the chip is pure UI: no rag/chat service, no network, state-toggle only", () => {
  // The chip's click handler is the toggle and nothing else.
  assert.match(refineRegion, /onClick=\{onToggleChart\}/);
  // The parent handler only flips savedNotes-style per-message state.
  assert.match(
    chat,
    /onToggleChart=\{\(\) =>\s*setInlineCharts\(\(prev\) => \(\{ \.\.\.prev, \[m\.id\]: !prev\[m\.id\] \}\)\)\s*\}/,
  );
  // No service or network call anywhere in the chip's region or the module.
  assert.doesNotMatch(refineRegion, /chatService|ragService|fetch\(|invoke\(/);
  assert.doesNotMatch(heuristic, /chatService|ragService|fetch\(|XMLHttpRequest|WebSocket/);
});

test("clicking mounts the house renderer inline; clicking again hides it", () => {
  assert.match(refineRegion, /\{chartShown && tableChart && <AnalyticsChart spec=\{tableChart\} \/>\}/);
  assert.match(refineRegion, /\{chartShown \? "Hide chart" : "Chart it"\}/);
});

test("per-message state mirrors savedNotes: keyed by turn id, cleared on switch", () => {
  assert.match(chat, /const \[inlineCharts, setInlineCharts\] = useState<Record<string, boolean>>\(\{\}\);/);
  assert.match(chat, /chartShown=\{!!inlineCharts\[m\.id\]\}/);
  // The conversation-switch effect clears it beside savedNotes/packNotes/pinNotes.
  assert.match(chat, /setPinNotes\(\{\}\);\s*setRatings\(\{\}\);\s*setInlineCharts\(\{\}\);/);
});

test("the bucketing subtitle is ONE string across engine and client (KEEP IN SYNC)", () => {
  const template = "smaller rows grouped as “Other”";
  assert.ok(rust.includes(template), "Rust emitter carries the subtitle template");
  assert.ok(heuristic.includes(template), "client heuristic carries the same template");
  assert.match(heuristic, /KEEP IN SYNC: lighthouse-core analytics\.rs `bucket_top_n`/);
  assert.match(rust, /KEEP IN SYNC: src\/lib\/chartFromTable\.ts/);
});

test("AnalyticsChart renders the subtitle slot in muted small text, tokens only", () => {
  assert.match(chart, /\{spec\.subtitle && \(/);
  assert.match(chart, /className=\{styles\.subtitle\}/);
  // Muted small text via existing tokens; no new colors.
  assert.match(
    chart,
    /subtitle: \{\s*display: "block",\s*color: tokens\.colorNeutralForeground3,\s*fontSize: tokens\.fontSizeBase200,/,
  );
});

test("ANY tabular answer gets the chip: a standalone mount covers answers without analytics meta", () => {
  // The component exists and reuses the exact same pure pipeline…
  const rowRegion = chat.slice(
    chat.indexOf("function ChartItRow"),
    chat.indexOf("/** True when a hast <pre>"),
  );
  assert.ok(rowRegion.length > 0, "ChartItRow found");
  assert.match(rowRegion, /if \(metaChart \|\| hasEngineChartFence\(content\)\) return null;/);
  assert.match(rowRegion, /parseMarkdownTable\(content\)/);
  assert.match(rowRegion, /chartSpecFromTable\(table\)/);
  assert.match(rowRegion, /<AnalyticsChart spec=\{tableChart\} \/>/);
  // …and is mounted exactly where analytics answers are NOT (prose answers),
  // sharing the same per-message inlineCharts state.
  assert.match(
    chat,
    /\{!m\.analytics && !m\.error && !\(streaming && m\.id === lastId\) && \(\s*<ChartItRow/,
  );
  assert.match(chat, /chartShown=\{!!inlineCharts\[m\.id\]\}/);
});
