/**
 * §22.3: deterministic eligibility for the canned analytics refinement chips
 * (Top 10 · Monthly · As %). A chip that cannot succeed must not render —
 * "Monthly" on an undated result, "Top 10" on a 4-row result, and "As %" on a
 * single row were the reported invalid-suggestion class. Pure computation over
 * the answer's OWN parsed result table (the data the refinement would refine);
 * no service call, no model.
 *
 * Conservative by design: when the answer carries no parseable table at all
 * (a prose-only analytics narration), every chip stays available — the table
 * shape is unknown, not known-bad, and hiding a workable refinement is the
 * worse failure. Tested in test/refineChips.test.mjs.
 */
import { looksTemporal, type TableLike } from "./chartFromTable";

export interface RefineEligibility {
  /** "Top 10": only meaningful when MORE than 10 data rows exist to rank. */
  topN: boolean;
  /** "Monthly": needs a temporal axis — a date-ish label column — to bucket. */
  monthly: boolean;
  /** "As %": share-of-total needs at least two rows to apportion. */
  asPercent: boolean;
}

const ALL_ELIGIBLE: RefineEligibility = { topN: true, monthly: true, asPercent: true };

/** Share of label cells that must read as temporal for "Monthly" to apply —
 *  matches the engine's own line-vs-bar axis heuristic tolerance. */
const TEMPORAL_MAJORITY = 0.6;

export function refineEligibility(table: TableLike | null): RefineEligibility {
  if (!table || table.rows.length === 0) return ALL_ELIGIBLE;
  const labels = table.rows.map((r) => r[0] ?? "").filter((l) => l.trim() !== "");
  const temporalShare =
    labels.length === 0 ? 0 : labels.filter((l) => looksTemporal(l)).length / labels.length;
  return {
    topN: table.rows.length > 10,
    // A result ALREADY bucketed by month (or any date axis) can still re-bucket
    // ("same thing but monthly" over a daily axis) — what "Monthly" cannot do
    // is conjure time out of a categorical axis.
    monthly: temporalShare >= TEMPORAL_MAJORITY,
    asPercent: table.rows.length >= 2,
  };
}
