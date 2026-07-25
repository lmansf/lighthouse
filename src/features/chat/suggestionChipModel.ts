/**
 * §48 §1: ONE combined suggestion cap. The hero (and, §2, the ongoing
 * conversation) used to render three independent chip groups — asks (capped 4),
 * recipe chips (uncapped), and report chips (capped 3) — so the row could reach
 * 7+. This pure helper concatenates all three into a SINGLE ordered,
 * de-duplicated list and caps the TOTAL at 3, priority asks > report > recipe.
 * A pure fn (inputs in, list out) so the ≤3 invariant is a table the test pins,
 * not control flow scattered through the render.
 *
 * UI-only (no server twin): the engine ops it consumes (suggestedAsks /
 * applicableRecipes / capabilityMap) are the parity surface, not this cap.
 */
import type { RecipeCard } from "@/contracts/types";

export interface AskChip {
  label: string;
  question: string;
}

/** A rendered suggestion chip, discriminated by kind so the row renders each
 *  by its own affordance (ask/recipe submit a question; report opens a menu). */
export type SuggestionChip =
  | { kind: "ask"; label: string; question: string }
  | { kind: "report"; table: string }
  | { kind: "recipe"; recipe: RecipeCard };

/** The total cap across ALL chip types — the §48 "calm to ~3 steady chips". */
export const SUGGESTION_CAP = 3;

/**
 * Merge the three validated sources into the single capped, de-duplicated,
 * priority-ordered list the row renders. Order is asks > report > recipe
 * (insertion order); a stable key de-dupes so the same chip never appears
 * twice; the whole list is sliced to `SUGGESTION_CAP`. Every input is already
 * engine-validated (a chip present will succeed) — this only orders and caps.
 */
export function mergeSuggestionChips(
  asks: AskChip[],
  reportTables: string[],
  recipes: RecipeCard[],
): SuggestionChip[] {
  const out: SuggestionChip[] = [];
  const seen = new Set<string>();
  const push = (chip: SuggestionChip, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(chip);
  };
  for (const a of asks) push({ kind: "ask", label: a.label, question: a.question }, `ask:${a.label}`);
  for (const t of reportTables) push({ kind: "report", table: t }, `report:${t}`);
  for (const r of recipes) push({ kind: "recipe", recipe: r }, `recipe:${r.id}:${r.table}`);
  return out.slice(0, SUGGESTION_CAP);
}
