/**
 * The engine-drafted vault brief, TS twin (openspec: field-patch-0.12.5 §3.5).
 * KEEP IN SYNC with native vault_brief.rs.
 *
 * A short, DETERMINISTIC summary of the vault the model is answering over —
 * drafted from facts the engine already knows (file-kind composition + the
 * queryable tables in scope, with date ranges when cheaply known). It is NOT a
 * semantic-store kind and is NOT part of the §3 ablation study; it is the new
 * additive deliverable, drawn only from engine-verified facts (never model
 * prose).
 *
 * PARITY: the pure `renderBrief` renderer is mirrored BYTE-FOR-BYTE by
 * vault_brief.rs::render_brief (the labels + line shapes are the byte contract).
 * The gathering wrapper (`draft_brief`) is Rust-only — the dev twin has no
 * analytics branch to inject a brief into, exactly like semantic.ts::promptBlock.
 */

/** Block label. KEEP IN SYNC with vault_brief.rs::BRIEF_NAME. */
const BRIEF_NAME = "vault brief";
const BRIEF_HEADER =
  "Vault brief (engine-drafted from your files — edit to correct or extend; this is context, not a constraint):";
const COMPOSITION_LABEL = "Files:";
const TABLES_LABEL = "Queryable tables:";

/** One queryable table's brief facts. KEEP IN SYNC with vault_brief.rs::BriefTable. */
export interface BriefTable {
  table: string;
  columns: number;
  /** Optional rendered [min, max] date range over a date column. */
  dates?: [string, string];
}

/**
 * Render the brief from already-gathered facts — a PURE function, the byte
 * contract with vault_brief.rs::render_brief. `composition` is `[KIND, count]`
 * pairs (any order; zero-counts pruned, the rest sorted most-files-first, ties
 * by kind). `null` when there is nothing to say.
 */
export function renderBrief(
  composition: [string, number][],
  tables: BriefTable[],
): { name: string; text: string } | null {
  const comp = composition
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const sections: string[] = [];
  if (comp.length > 0) {
    const parts = comp.map(([k, n]) => `${n} ${k}`);
    sections.push(`${COMPOSITION_LABEL} ${parts.join(", ")}.`);
  }
  if (tables.length > 0) {
    const lines = [TABLES_LABEL];
    for (const t of tables) {
      const cols = t.columns === 1 ? "1 column" : `${t.columns} columns`;
      const dates = t.dates ? `; dates ${t.dates[0]} to ${t.dates[1]}` : "";
      lines.push(`- ${t.table} (${cols}${dates})`);
    }
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return null;
  return { name: BRIEF_NAME, text: `${BRIEF_HEADER}\n\n${sections.join("\n\n")}` };
}

/** A file's brief KIND label from its extension. KEEP IN SYNC with vault_brief.rs::file_kind. */
export function fileKind(name: string): string | undefined {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return undefined;
  return name.slice(i + 1).toUpperCase();
}
