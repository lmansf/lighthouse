/**
 * The SQL table-naming pipeline a vault file registers under — shared by the
 * server twin (`src/server/views.ts`, which re-exports these) AND client code
 * that must predict a file's table name without touching the server bundle
 * (e.g. the Reports composer resolving a just-made-visible spreadsheet). Pure,
 * dependency-free, so it is safe to import from a "use client" component.
 *
 * KEEP IN SYNC with analytics.rs::sanitize_table_name / unique_table_name — the
 * naming must be byte-identical across the Rust engine, the TS twin, and this
 * client mirror, or a predicted table name won't match the one the engine
 * registered.
 */

/** Lowercased stem, non-alphanumerics folded to `_`, digit-safe. KEEP IN SYNC
 *  with analytics.rs::sanitize_table_name. */
export function sanitizeTableName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = (dot >= 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
  let out = "";
  let lastUs = true; // also trims leading underscores
  for (const ch of stem) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastUs = false;
    } else if (!lastUs) {
      out += "_";
      lastUs = true;
    }
  }
  out = out.replace(/_+$/, "");
  if (!out) out = "table";
  return /^[0-9]/.test(out) ? `t_${out}` : out;
}

/** A table name not already in `used`: the base, else base_2, base_3, … until
 *  free. KEEP IN SYNC with analytics.rs::unique_table_name. */
export function uniqueTableName(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}_${n}`;
    if (!used.includes(cand)) return cand;
  }
}
