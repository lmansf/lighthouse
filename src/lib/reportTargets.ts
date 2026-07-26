/**
 * Pure decision logic for the Reports composer's "build a report from a hidden
 * spreadsheet" path (§49, make-visible-and-keep). The component owns the side
 * effects — make the sheet visible, re-read the capability map — and delegates
 * the "so which table do we analyze, if any?" question here, where it can be
 * unit-tested without a React/engine harness.
 */
import { sanitizeTableName } from "./tableName";

/** Spreadsheet extensions the engine can analyze — mirrors
 *  analytics.rs::is_tabular (and `RICH_EXT` in the extractors). A hidden file
 *  with one of these can back a report once it's made visible to the AI. */
export const SHEET_EXTS = [".csv", ".tsv", ".parquet", ".xlsx", ".xlsm", ".xls"];

/** Does this filename look like a spreadsheet the engine can analyze? */
export function isSheetName(name: string): boolean {
  const n = name.toLowerCase();
  return SHEET_EXTS.some((e) => n.endsWith(e));
}

/** One capability-map table, trimmed to what the resolver needs. */
export interface CapTable {
  name: string;
  investigable: boolean;
}

/**
 * Given the capability map computed AFTER a hidden sheet was made visible,
 * decide which SQL table a deep-analysis report should run over:
 *  - `{ table }`     — analyze this table (the sheet's own, or the union family
 *                      it joined; a report is guaranteed non-empty).
 *  - `{ none: true }`— the engine profiled the sheet but it has no dated numeric
 *                      series; an honest "nothing to analyze yet", never an empty
 *                      saved report.
 *  - `{ unknown: true }` — the engine returned no tables at all (the web dev
 *                      twin, which can't analyze); let the caller fall through to
 *                      `investigate`'s own honest throw instead of a misleading
 *                      "no columns" note.
 *
 * `prevInvestigable` is the set of investigable table names BEFORE the sheet was
 * made visible, so a union/dedup rename (no table named for the file) still
 * resolves to whatever investigable table the newly-visible sheet added.
 */
export function resolveSheetTable(
  sheetName: string,
  mapTables: CapTable[],
  prevInvestigable: string[],
): { table: string } | { none: true } | { unknown: true } {
  const want = sanitizeTableName(sheetName);
  const exact = mapTables.find((t) => t.name === want);
  if (exact) return exact.investigable ? { table: exact.name } : { none: true };
  const before = new Set(prevInvestigable);
  const fresh = mapTables.find((t) => t.investigable && !before.has(t.name));
  if (fresh) return { table: fresh.name };
  return mapTables.length > 0 ? { none: true } : { unknown: true };
}
