/**
 * Evidence-pack export for Beam analytics answers (src/features/chat/ChatPanel.tsx)
 * and board packs (openspec: add-boards §5.1, src/features/boards/BoardPanel.tsx).
 *
 * One analytics answer → one SELF-CONTAINED HTML file the analyst can attach
 * to an email or drop in a share folder: the question, the narrative + result
 * table (with every honesty footer preserved verbatim), the chart as inline
 * SVG, the exact SQL, and file provenance + freshness. `composeBoardPack`
 * composes a whole board the same way: per-card sections plus ONE Queries
 * appendix. Everything in a pack is already on the answer/card — this module
 * only COMPOSES; it derives no numbers, fetches nothing, and embeds no
 * external resource (no scripts, no remote fonts/images — the file renders
 * identically offline, which doubles as the privacy proof: opening it can't
 * phone anywhere).
 *
 * Pure and dependency-light so it's unit-testable in node
 * (test/evidencePack.test.mjs) without a DOM, like sortTable.ts/chartSpec.ts:
 * the caller passes the timestamp in (never Date.now() here) and every chart
 * as an already-serialized SVG string (the panels capture the rendered
 * charts); fixed inputs always produce byte-identical output.
 */

// RELATIVE leaf imports (not the "@/contracts" barrel), deliberately: the
// barrel pulls in the real fetch-backed services, and the node test runner
// resolves only relative specifiers — this keeps the module pure and testable
// without a DOM or bundler. providers.ts is a plain constant table.
import { MODEL_PROVIDERS } from "../contracts/mocks/providers";
import type { AnalyticsMeta, ChatChunk, RagReference } from "../contracts/types";

/** The provenance stamp payload of a settled answer (ChatChunk's final meta). */
export type ProvenanceMeta = NonNullable<ChatChunk["meta"]>;

/** Map a provider id to its vendor label for the provenance stamp; falls back
 *  to the id itself when the provider isn't in the picker table. */
function vendorLabelFor(id: string): string {
  return MODEL_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/**
 * The engine-emitted provenance stamp rendered under a finished answer — and
 * reproduced verbatim in the evidence pack. Reads ONLY the final chunk's
 * `meta` (never the model's text), so it is always truthful: "Answered on
 * this device" when nothing left the machine, else "Answered via <vendor> —
 * N excerpts from M files sent". Single source of truth: ChatPanel imports
 * this same function for the on-screen stamp.
 */
export function provenanceStampText(meta: ProvenanceMeta): string {
  if (meta.origin === "device") return "Answered on this device";
  const excerpts = `${meta.excerptCount} excerpt${meta.excerptCount === 1 ? "" : "s"}`;
  const files = `${meta.sourceFileCount} file${meta.sourceFileCount === 1 ? "" : "s"}`;
  return `Answered via ${vendorLabelFor(meta.origin)} — ${excerpts} from ${files} sent`;
}

/** Everything a pack is composed from — all of it already on the answer. */
export interface EvidencePackInput {
  /** The user question that produced the answer (the pack's title). */
  question: string;
  /** The answer's full markdown (`m.content`): narrative, result table,
   *  "Query used" fence, freshness line, honesty footers, chart fence. */
  contentMarkdown: string;
  /** The rendered chart serialized as a standalone SVG string (theme colors
   *  baked in), or absent — the pack then simply omits the chart section. */
  chartSvg?: string | null;
  /** The final chunk's provenance stamp (origin + counts), if present. */
  meta?: ProvenanceMeta | null;
  /** Structured analytics provenance: the exact SQL + the files it read. */
  analytics: AnalyticsMeta;
  /** The answer's references — display names for the files-read list. */
  references?: Pick<RagReference, "fileId" | "name">[];
  /** Epoch ms of composition — the CALLER supplies it (pure function). */
  generatedAt: number;
}

// --- Minimal deterministic markdown → HTML -----------------------------------
//
// The app renders answers with react-markdown, which isn't cleanly importable
// in a pure module (it's a React component tree). Analytics answers use a
// small, engine-shaped markdown subset — paragraphs, ONE GFM result table,
// fenced code (the ```sql "Query used" block), emphasis honesty footers, and
// the occasional heading/list from the model — so the pack renders exactly
// that subset deterministically. Unknown constructs degrade to escaped text,
// never to broken markup.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline markdown (code spans, bold, italics) on ONE already-escaped chunk.
 * Code spans are tokenized out first so a literal `*` inside `SELECT * FROM t`
 * can never open an emphasis run.
 */
function inlineHtml(raw: string): string {
  const codes: string[] = [];
  let s = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n][^*]*)\*/g, "<em>$1</em>");
  // Underscore emphasis only when free-standing (the engine's footers), so a
  // snake_case name inside a table cell is never half-italicized.
  s = s.replace(
    /(^|[\s(“])_([^_]+)_(?=$|[\s)”.,;:!?])/gm,
    "$1<em>$2</em>",
  );
  // Each source line on its own visual line (the honesty footers stack).
  s = s.replace(/\n/g, "<br>\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
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
 * Render the answer markdown to HTML, DROPPING every ```lighthouse-chart
 * fence (the chart travels separately as inline SVG). Exported for tests.
 */
export function answerMarkdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    const text = para.join("\n").trim();
    para = [];
    if (text) out.push(`<p>${inlineHtml(text)}</p>`);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // past the closing fence (or EOF)
      if (lang !== "lighthouse-chart") {
        out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      }
      continue;
    }
    // GFM table: a `|` row whose next line is the alignment row.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      flushPara();
      const header = tableCells(line);
      i += 2; // past header + alignment row
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      const th = header.map((c) => `<th>${inlineHtml(c)}</th>`).join("");
      const trs = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`)
        .join("\n");
      out.push(
        `<div class="tablewrap"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table></div>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      // The question owns <h1>; content headings nest under it (capped).
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>\n${items.map((t) => `<li>${inlineHtml(t)}</li>`).join("\n")}\n</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      out.push(`<ol>\n${items.map((t) => `<li>${inlineHtml(t)}</li>`).join("\n")}\n</ol>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join("\n");
}

// --- Pack assembly ------------------------------------------------------------

/** Deterministic, unambiguous timestamp: "2026-07-15 09:30 UTC". */
function formatUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())} UTC`;
}

/** The engine's deterministic `*Computed from:* …` freshness line, verbatim
 *  from the answer markdown (null when the answer carries none). */
function freshnessLineFrom(content: string): string | null {
  const m = /^\*Computed from:\* .*$/m.exec(content);
  return m ? m[0] : null;
}

// Self-contained styling: system font stack, no remote anything. Kept small
// and print-friendly — an evidence pack is made to be forwarded and filed.
const PACK_CSS = `
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a; background: #ffffff;
    max-width: 760px; margin: 0 auto; padding: 32px 24px 24px;
    line-height: 1.5; font-size: 15px;
  }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em;
       color: #555; margin: 28px 0 8px; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
  h3, h4 { font-size: 15px; margin: 16px 0 6px; }
  p { margin: 0 0 10px; }
  .stamp, .generated { color: #555; font-size: 13px; margin: 0 0 2px; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #d0d0d0; padding: 4px 8px; text-align: left;
           font-variant-numeric: tabular-nums; }
  th { background: #f4f4f4; }
  pre { background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 4px;
        padding: 10px 12px; overflow-x: auto; font-size: 13px; }
  code { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; font-size: 0.92em; }
  figure.chart { margin: 10px 0; }
  figure.chart svg { max-width: 100%; height: auto; border: 1px solid #e0e0e0; border-radius: 4px; }
  ol.files, ul.files { margin: 6px 0 10px; padding-left: 26px; }
  footer { margin-top: 32px; border-top: 1px solid #e0e0e0; padding-top: 8px;
           color: #777; font-size: 12px; }
  /* Board packs only: the per-card heading is the pin's QUESTION — content,
     not a section label — so it keeps sentence case and body ink. */
  section.card > h2 { text-transform: none; letter-spacing: 0; color: #1a1a1a; font-size: 16px; }
  /* A card's stale/error note: the board card's honesty posture, danger ink. */
  p.stale { color: #a4262c; }
`;

/**
 * Wrap composed body parts in the packs' one self-contained document shell:
 * system font stack, PACK_CSS inlined, no external resource of any kind.
 * Shared by both composers so the offline invariant lives in one place.
 */
function packDocument(title: string, body: string): string {
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PACK_CSS}</style>`,
    `</head>`,
    `<body>`,
    body,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

/**
 * Compose one self-contained evidence-pack HTML document from a settled
 * analytics answer. Every section is derived from the inputs alone — same
 * inputs, same bytes.
 */
export function composeEvidencePack(input: EvidencePackInput): string {
  const {
    question,
    contentMarkdown,
    chartSvg,
    meta,
    analytics,
    references = [],
    generatedAt,
  } = input;
  const ts = formatUtc(generatedAt);
  const parts: string[] = [];

  // (a) The question, when it was generated, and the truthful origin stamp.
  parts.push(`<header>`);
  parts.push(`<h1>${escapeHtml(question)}</h1>`);
  parts.push(`<p class="generated">Generated ${escapeHtml(ts)}</p>`);
  if (meta) {
    parts.push(`<p class="stamp">${escapeHtml(provenanceStampText(meta))}</p>`);
  }
  parts.push(`</header>`);

  // (b) The narrative + result table — the answer as the analyst saw it,
  // honesty footers and all, minus the chart fence (embedded below as SVG).
  parts.push(`<section>`);
  parts.push(`<h2>Answer</h2>`);
  parts.push(answerMarkdownToHtml(contentMarkdown));
  parts.push(`</section>`);

  // (c) The chart, exactly as rendered — inline SVG, no external resources.
  if (chartSvg && chartSvg.trim()) {
    parts.push(`<section>`);
    parts.push(`<h2>Chart</h2>`);
    parts.push(`<figure class="chart">${chartSvg}</figure>`);
    parts.push(`</section>`);
  }

  // (d) The exact SQL the engine executed (structured provenance, not text).
  parts.push(`<section>`);
  parts.push(`<h2>Query used</h2>`);
  parts.push(`<pre><code>${escapeHtml(analytics.sql)}</code></pre>`);
  parts.push(`</section>`);

  // (e) Provenance: the engine's freshness line verbatim + the files read.
  parts.push(`<section>`);
  parts.push(`<h2>Provenance</h2>`);
  const fresh = freshnessLineFrom(contentMarkdown);
  if (fresh) parts.push(`<p>${inlineHtml(fresh)}</p>`);
  const nameByFileId = new Map(references.map((r) => [r.fileId, r.name]));
  const listed = new Set<string>();
  const items: string[] = [];
  for (const id of analytics.fileIds) {
    if (listed.has(id)) continue;
    listed.add(id);
    const name = nameByFileId.get(id) ?? id.split("/").pop() ?? id;
    items.push(name === id ? escapeHtml(name) : `${escapeHtml(name)} — ${escapeHtml(id)}`);
  }
  // References beyond the queried files (defensive; normally the same set).
  for (const r of references) {
    if (listed.has(r.fileId)) continue;
    listed.add(r.fileId);
    items.push(escapeHtml(r.name));
  }
  if (items.length) {
    parts.push(
      `<ol class="files">\n${items.map((t) => `<li>${t}</li>`).join("\n")}\n</ol>`,
    );
  }
  parts.push(`</section>`);

  // (f) Footer: who made this file and the promise it stands on.
  parts.push(
    `<footer>Generated by Lighthouse · ${escapeHtml(
      ts,
    )} · every number computed by the engine from your files</footer>`,
  );

  return packDocument(question, parts.join("\n"));
}

// --- Board pack (openspec: add-boards §5.1) -----------------------------------

/**
 * One board card as its pack section — everything here is already ON the
 * rendered card; the composer rewords nothing.
 */
export interface BoardPackCard {
  /** The pin's question — the card section's heading. */
  question: string;
  /** The card body's markdown: the engine's row-capped result table on a
   *  live card; the pin's stored compact summary text on a stored (twin)
   *  card. Absent on a failed card — the stale note stands as the body,
   *  exactly like the on-screen card. */
  markdown?: string | null;
  /** The rendered chart serialized as a standalone SVG string — the CALLER
   *  captures it (standaloneChartSvg); this module stays DOM-free. */
  chartSvg?: string | null;
  /** The freshness stamp EXACTLY as the card shows it: the engine footer's
   *  "Computed from: …" sentence on a live card, "stored · checked 3m ago"
   *  on a stored one — the stored labeling travels verbatim, never reworded. */
  freshness: string;
  /** The pin's stored SQL — this card's entry in the Queries appendix. */
  sql: string;
  /** Live cards: the engine's provenance footer, reproduced VERBATIM in the
   *  appendix. Stored cards carry none (the twin executed nothing). */
  footer?: string | null;
  /** True = computed now by the engine; false = stored state (twin). A
   *  stored card's appendix entry repeats its stored freshness stamp where
   *  a live card shows its engine footer, so no query reads as fresher than
   *  it is. */
  live: boolean;
  /** The card's on-screen stale/error text, when its refresh failed. */
  staleNote?: string | null;
}

/** A board export: the board's name, the composition instant (the CALLER
 *  supplies it — pure function), and the cards in board order. */
export interface BoardPackInput {
  title: string;
  generatedAt: number;
  cards: BoardPackCard[];
}

/**
 * Compose one self-contained board-pack HTML document (openspec: add-boards):
 * the board title, per-card sections (the question as heading, the rendered
 * result table, the chart as inline SVG when captured, the freshness stamp,
 * the stale/error note when present), and ONE "Queries" appendix at the end
 * listing every card's exact SQL and engine footer verbatim. Same promises
 * as composeEvidencePack: composed from the inputs alone — nothing derived,
 * nothing fetched, no external resource — so fixed inputs produce
 * byte-identical output that renders offline.
 */
export function composeBoardPack(input: BoardPackInput): string {
  const { title, generatedAt, cards } = input;
  const ts = formatUtc(generatedAt);
  const parts: string[] = [];

  parts.push(`<header>`);
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  parts.push(`<p class="generated">Generated ${escapeHtml(ts)}</p>`);
  parts.push(`</header>`);

  // An empty board exports honestly: the pack says so instead of implying
  // results that never existed — and carries no Queries appendix.
  if (cards.length === 0) {
    parts.push(`<section>`);
    parts.push(`<p>This board has no cards.</p>`);
    parts.push(`</section>`);
  }

  for (const c of cards) {
    parts.push(`<section class="card">`);
    parts.push(`<h2>${escapeHtml(c.question)}</h2>`);
    if (c.markdown && c.markdown.trim()) parts.push(answerMarkdownToHtml(c.markdown));
    // The chart exactly as rendered on the card — inline SVG, nothing remote.
    if (c.chartSvg && c.chartSvg.trim()) {
      parts.push(`<figure class="chart">${c.chartSvg}</figure>`);
    }
    parts.push(`<p class="stamp">${escapeHtml(c.freshness)}</p>`);
    if (c.staleNote && c.staleNote.trim()) {
      parts.push(`<p class="stale">${escapeHtml(c.staleNote)}</p>`);
    }
    parts.push(`</section>`);
  }

  // ONE appendix at the end: every card's exact SQL fence plus its engine
  // footer verbatim — the evidence pack's "Query used" honesty, board-wide.
  // A stored card has no engine footer (nothing ran), so its entry repeats
  // the card's stored freshness stamp instead — the same on-screen wording.
  if (cards.length > 0) {
    parts.push(`<section>`);
    parts.push(`<h2>Queries</h2>`);
    for (const c of cards) {
      parts.push(`<h3>${escapeHtml(c.question)}</h3>`);
      parts.push(`<pre><code>${escapeHtml(c.sql)}</code></pre>`);
      if (c.footer && c.footer.trim()) {
        parts.push(answerMarkdownToHtml(c.footer));
      } else if (!c.live) {
        parts.push(`<p class="stamp">${escapeHtml(c.freshness)}</p>`);
      }
    }
    parts.push(`</section>`);
  }

  parts.push(
    `<footer>Generated by Lighthouse · ${escapeHtml(
      ts,
    )} · every number computed by the engine from your files</footer>`,
  );

  return packDocument(title, parts.join("\n"));
}
