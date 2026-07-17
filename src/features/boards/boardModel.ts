/**
 * [TEAM: boards] Pure card/board logic (openspec: add-boards §2-§4).
 *
 * Everything here is DOM-free and deterministic so it unit-tests in node
 * (test/boardsUi.test.mjs) without a renderer: grid span mapping, the
 * card-list edits BoardPanel persists through the atomic `setBoardCards`
 * replace, stat-tile detection (single-row/single-value results), the delta
 * between two engine summaries (via the pinChart parsers — never model text),
 * and the freshness line each card carries.
 *
 * Numbers are ENGINE numbers throughout: the markdown table and the pin
 * summaries this module parses come from the verified DataFusion result, so a
 * stat tile or delta can never show a figure the engine didn't compute.
 */

import type { BoardCardRef, BoardCardRefresh, BoardCardSize } from "../../contracts";
// Relative (not @/) imports: node's test runner executes this module directly
// (test/boardsUi.test.mjs via the extensionless hook), and only the bundler
// knows the alias.
import { parsePinNumber, pinChartData } from "../../lib/pinChart";

// --- Layout ---------------------------------------------------------------

/**
 * A card's `grid-column` on the board's responsive grid
 * (`repeat(auto-fill, minmax(...))`): S spans one track, M two, L the full
 * row. The panel's narrow-viewport media query flattens M to full row so a
 * two-track span never overflows a one-column grid.
 */
export function spanForSize(size: BoardCardSize): string {
  if (size === "L") return "1 / -1";
  if (size === "M") return "span 2";
  return "span 1";
}

// --- Card-list edits (persisted wholesale via setBoardCards) ----------------

/** Clone the list (and each ref) so edits never alias the caller's state. */
function cloneCards(cards: BoardCardRef[]): BoardCardRef[] {
  return cards.map((c) => ({ ...c }));
}

/**
 * Swap the card at `index` with its neighbor (`dir` -1 = up, +1 = down).
 * Returns the new list, or null when the move falls off either end — callers
 * skip the engine round-trip on a no-op.
 */
export function moveCard(
  cards: BoardCardRef[],
  index: number,
  dir: -1 | 1,
): BoardCardRef[] | null {
  const to = index + dir;
  if (index < 0 || index >= cards.length || to < 0 || to >= cards.length) return null;
  const next = cloneCards(cards);
  const [picked] = next.splice(index, 1);
  next.splice(to, 0, picked);
  return next;
}

/**
 * Drop the card at `from` so it lands at `to` (the HTML5-drag enhancement;
 * the keyboard "Move up/down" controls ride `moveCard`). Null on out-of-range
 * indices or a same-place drop.
 */
export function reorderCard(
  cards: BoardCardRef[],
  from: number,
  to: number,
): BoardCardRef[] | null {
  if (from < 0 || from >= cards.length || to < 0 || to >= cards.length || from === to) {
    return null;
  }
  const next = cloneCards(cards);
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

/** Resize one card. Null when the index is out of range or already that size. */
export function withCardSize(
  cards: BoardCardRef[],
  index: number,
  size: BoardCardSize,
): BoardCardRef[] | null {
  if (index < 0 || index >= cards.length || cards[index].size === size) return null;
  const next = cloneCards(cards);
  next[index] = { ...next[index], size };
  return next;
}

/**
 * Remove one card. A card is a REFERENCE — the pin itself is never deleted
 * or modified by this (managing the pin stays in the pins dialog).
 */
export function withoutCard(cards: BoardCardRef[], index: number): BoardCardRef[] | null {
  if (index < 0 || index >= cards.length) return null;
  return cards.filter((_, i) => i !== index).map((c) => ({ ...c }));
}

/**
 * Append a pin to the end of the board ("Add to board", size M by default).
 * Null when the pin already has a card — adding is idempotent, so the caller
 * reports "already on the board" instead of minting a duplicate.
 */
export function appendCard(
  cards: BoardCardRef[],
  pinId: string,
  size: BoardCardSize = "M",
): BoardCardRef[] | null {
  if (cards.some((c) => c.pinId === pinId)) return null;
  return [...cloneCards(cards), { pinId, size }];
}

// --- Result-shape detection (markdown table → card body) --------------------

export interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** Split a `| a | b |` markdown table row into trimmed cell strings. */
function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/** True when a line is a GFM alignment row (`| --- | :---: |`). */
function isAlignRow(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * The FIRST GFM table in the engine's result markdown (header row + alignment
 * row + data rows), or null when none parses. The engine already row-caps the
 * table it returns, so the board renders it as-is — no re-truncation. Same
 * `|`-row grammar as evidencePack.answerMarkdownToHtml, kept pure here so the
 * card can render real DOM (and the stat detector can inspect cells) without
 * an HTML string round-trip.
 */
export function parseMarkdownTable(md: string): ParsedTable | null {
  const lines = md.split("\n");
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|") || !isAlignRow(lines[i + 1])) continue;
    const header = tableCells(lines[i]);
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j += 1) {
      rows.push(tableCells(lines[j]));
    }
    return { header, rows };
  }
  return null;
}

export interface StatValue {
  /** The value exactly as the engine printed it ("$1,200", "42.5%"). */
  raw: string;
  /** Numeric reading of `raw` (pinChart's parser), null for non-numeric. */
  value: number | null;
  /** Column header or row label naming the value, when the result carries one. */
  label: string | null;
}

/**
 * Decide whether a card's result is a single value worth a stat tile.
 *
 * Live cards judge the engine's result MARKDOWN: a one-row table with one
 * column (the header names it), or one label column plus one numeric column
 * (the row names it). Anything wider or taller is a table, not a stat — the
 * markdown is the live truth, so a present-but-unsuitable table never falls
 * through to the summary.
 *
 * Stored cards (the twin's last-known snapshots) have no markdown, so the
 * pin's compact summary decides: exactly one "<label> <number>" segment is a
 * stat. Multi-segment summaries stay text/mini-chart territory.
 */
export function detectStat(markdown?: string, summary?: string): StatValue | null {
  if (markdown !== undefined) {
    const table = parseMarkdownTable(markdown);
    if (!table || table.rows.length !== 1) return null;
    const row = table.rows[0];
    if (row.length === 1) {
      return {
        raw: row[0],
        value: parsePinNumber(row[0]),
        label: table.header[0]?.trim() ? table.header[0] : null,
      };
    }
    if (row.length === 2) {
      const value = parsePinNumber(row[1]);
      // Label + number only: two numbers are a comparison (a table), and a
      // numeric "label" would caption the stat with a bare figure.
      if (value !== null && parsePinNumber(row[0]) === null) {
        return { raw: row[1], value, label: row[0] };
      }
    }
    return null;
  }
  if (summary) {
    // One "<label> <number>" segment, read with the same tokenizer as
    // pinChart.parsePinSummary but keeping the RAW numeric token for display.
    const segs = summary
      .split("·")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segs.length !== 1) return null;
    const toks = segs[0].split(/\s+/);
    if (toks.length < 2) return null;
    const raw = toks[toks.length - 1];
    const value = parsePinNumber(raw);
    if (value === null) return null;
    return { raw, value, label: toks.slice(0, -1).join(" ") };
  }
  return null;
}

/**
 * The stat tile's delta between two engine summaries (a retained
 * `pins-changed` before→after). Both must parse as the SAME single labeled
 * point — pinChartData already enforces label alignment, so a schema change
 * between rechecks yields null rather than a nonsense subtraction. A zero
 * delta is null too (the digest moved, this number didn't — nothing to say).
 */
export function statDelta(before: string | undefined, after: string): number | null {
  const d = pinChartData(before, after);
  if (!d || d.labels.length !== 1 || d.before === null) return null;
  const delta = d.after[0] - d.before[0];
  return delta === 0 ? null : delta;
}

// --- Freshness --------------------------------------------------------------

/**
 * The engine's own freshness sentence out of a live card's `run_direct`
 * footer: the deterministic `*Computed from:* …` line, byte-verbatim except
 * for the markdown emphasis marks around "Computed from:" (syntax, not text —
 * chat renders them as italics, a Text node would show literal asterisks).
 * Null when the footer carries no such line; callers fall back to the stored
 * "checked …" form rather than paraphrasing engine text.
 */
export function freshnessFromFooter(footer: string): string | null {
  const emphasized = /^\*Computed from:\* .*$/m.exec(footer);
  if (emphasized) return emphasized[0].replace(/^\*Computed from:\*/, "Computed from:");
  const plain = /^Computed from: .*$/m.exec(footer);
  return plain ? plain[0] : null;
}

/**
 * The freshness stamp a (non-tombstone) card carries — spec: every card has
 * one. SHARED by BoardCard (the on-screen line) and the board export (the
 * pack's stamp, openspec §5.1) so the exported file can never label a card
 * differently than the screen did. Live cards show the engine footer's own
 * freshness sentence VERBATIM (via freshnessFromFooter), falling back to the
 * "checked …" wording only when the footer carries none; stored (twin) cards
 * are labeled stored, never passed off as live.
 */
export function cardFreshness(
  answer: Pick<BoardCardRefresh, "live" | "footer" | "lastRunMs">,
  now: number,
): string {
  if (answer.live) {
    return (
      (answer.footer ? freshnessFromFooter(answer.footer) : null) ??
      formatCheckedRelative(answer.lastRunMs, now)
    );
  }
  return `stored · ${formatCheckedRelative(answer.lastRunMs, now)}`;
}

/**
 * Stored-state freshness, exactly the pins dialog's wording: "checked 3m ago"
 * (formatRelativeTime semantics), "not checked yet" when the pin never ran.
 * `now` is injected so the rendering is deterministic under test.
 */
export function formatCheckedRelative(lastRunMs: number | undefined, now: number): string {
  if (!lastRunMs) return "not checked yet";
  const min = Math.round((now - lastRunMs) / 60000);
  if (min < 1) return "checked just now";
  if (min < 60) return `checked ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `checked ${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `checked ${day}d ago`;
  return `checked ${new Date(lastRunMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}
