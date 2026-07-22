/**
 * §32 §3b: THE accessor every consumer reads an answer's table through.
 *
 * Under the apple-fm prose-only contract the model narrates over a fact sheet
 * and never types the table — the ENGINE carries the verified rows on the
 * structured channel (`meta.table`, §22.6 idiom, KEEP IN SYNC with
 * contracts.rs ChunkMeta::table). Cloud/desktop answers and legacy saved
 * chats keep their markdown tables. `answerTable()` hides that split: prefer
 * the structured field, fall back to parsing the FIRST GFM table out of the
 * answer text — so RefineChips, Chart-it, boards, and the evidence pack all
 * keep working across eras from ONE seam.
 *
 * The markdown parser lives here (moved from boardModel, which re-exports it)
 * so lib code never imports a feature module.
 */

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
 * table it returns, so callers render it as-is — no re-truncation. Same
 * `|`-row grammar as evidencePack.answerMarkdownToHtml, kept pure here so
 * cards can render real DOM (and the stat detector can inspect cells) without
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

/**
 * Decode the engine's `meta.table` JSON (`{"columns":[…],"rows":[[…]]}`) into
 * the same shape the markdown parser yields. The field is engine-built, but a
 * malformed value must degrade to the text parse, never throw mid-render.
 */
export function parseTableJson(json: string): ParsedTable | null {
  try {
    const v = JSON.parse(json) as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(v.columns) || v.columns.length === 0 || !Array.isArray(v.rows)) return null;
    const rows: string[][] = [];
    for (const r of v.rows) {
      if (!Array.isArray(r)) return null;
      rows.push(r.map((c) => String(c)));
    }
    return { header: v.columns.map((c) => String(c)), rows };
  } catch {
    return null;
  }
}

/**
 * The answer's table: the engine's structured `meta.table` when present (and
 * valid), else the first GFM table parsed out of the answer markdown.
 */
export function answerTable(m: {
  content: string;
  meta?: { table?: string } | null;
}): ParsedTable | null {
  const structured = m.meta?.table ? parseTableJson(m.meta.table) : null;
  return structured ?? parseMarkdownTable(m.content);
}
