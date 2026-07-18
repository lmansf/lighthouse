"use client";

/**
 * [TEAM: recipes] The sidebar's Recipes gallery (openspec: add-recipes §3.1) —
 * the built-in analyses applicable to the current included set, the ViewsNav
 * Library sibling. One row per RecipeCard: the recipe name plus a subdued
 * "runnable on {table}" line (the file display name / view name the engine
 * resolved it against). Clicking a row RUNS the recipe by seeding the chat with
 * the recipe-cued question (`runRecipeQuestion`) through the EXISTING
 * `lighthouse:ask-question` ask seam — the SAME event ViewsNav's "Ask about
 * this view" dispatches and the ChatPanel empty-state chips submit; synth.rs
 * detects the cue BEFORE the model gate and plans the recipe deterministically.
 * No new event, no new streaming op.
 *
 * The ENGINE owns applicability — this nav only renders what the engine's
 * applicableRecipes returns, consumed through the SHARED useValidatedChips
 * hook (§22.3): one preloaded, stale-while-revalidate cache with the
 * ChatPanel's empty-state chips, re-keyed on the included set, the provider,
 * the investigation, and the `lighthouse:views-changed` signal (a saved view
 * is a table too, so it can add or drop a recipe). PARITY: the web dev twin
 * returns the file-derived subset it can compute statically, or [] — the
 * gallery renders that honest subset and never crashes on [].
 *
 * Beam treatment: Fluent tokens only (the ViewsNav/InvestigationsNav palette),
 * both light + dark themes free; no hand-picked colors.
 */

import { useMemo } from "react";
import { Text, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import type { RecipeCard } from "@/contracts";
import { runRecipeQuestion } from "@/contracts";
import { useValidatedChips } from "@/features/chat/useValidatedChips";
import { useRagStore } from "@/stores/useRagStore";

const useStyles = makeStyles({
  // The Library-sibling section chrome: hairline below, breathing room — the
  // exact ViewsNav/InvestigationsNav treatment, no new tokens.
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalXXS,
  },
  headerLabel: { color: tokens.colorNeutralForeground3 },
  // A two-line clickable row (the InvestigationsNav rowMain pattern): the whole
  // row is the run affordance — no menu, no dialog.
  row: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    width: "100%",
    textAlign: "left",
    ...shorthands.border("none"),
    backgroundColor: "transparent",
    color: "inherit",
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    minHeight: "32px",
    ":hover": { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowMain: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rowCaption: { color: tokens.colorNeutralForeground3 },
  // Quiet inline empty-state explainer — the ViewsNav `note` treatment.
  note: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding("2px", tokens.spacingHorizontalS),
  },
});

/** Run a recipe through the existing ask seam (the ViewsNav askAbout idiom):
 *  seed the chat with the recipe-cued question; synth.rs runs it model-free
 *  BEFORE the model gate — a plain NL question never carries the cue. */
function runRecipe(r: RecipeCard): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("lighthouse:ask-question", {
      detail: { question: runRecipeQuestion(r.id, r.table) },
    }),
  );
}

export function RecipesNav() {
  const styles = useStyles();
  // Session store + subscribe (the InvestigationsNav idiom): the included set
  // drives applicability, so the nav re-reads it from the live vault nodes.
  const nodes = useRagStore((s) => s.nodes);
  const includedFileIds = useMemo(
    () => nodes.filter((n) => n.kind === "file" && n.ragIncluded).map((n) => n.id),
    [nodes],
  );
  // §22.3: the shared validated-chips source — the hook keys by VALUE
  // internally (the vault poll's no-op `nodes` rebuilds cost nothing), listens
  // to `lighthouse:views-changed` itself, and serves the module-cached set
  // instantly while revalidating, so this gallery and the chat's empty-state
  // chips can never disagree.
  const { recipes } = useValidatedChips(includedFileIds);

  return (
    <nav aria-label="Recipes" className={styles.section}>
      <div className={styles.header}>
        <Text size={200} weight="semibold" className={styles.headerLabel}>
          Recipes
        </Text>
      </div>

      {recipes.map((r) => (
        <button
          key={`${r.id}:${r.table}`}
          type="button"
          className={styles.row}
          title={r.summary}
          onClick={() => runRecipe(r)}
        >
          <div className={styles.rowMain}>
            <Text size={300} className={styles.rowName}>
              {r.name}
            </Text>
            <Text size={200} className={styles.rowCaption}>
              runnable on {r.table}
            </Text>
          </div>
        </button>
      ))}

      {/* The hook exposes no in-flight flag (it serves the cache instantly and
          revalidates behind it), so the note gates on the list alone — its
          copy is forward-looking either way, and a first-visit revalidation
          replaces it the moment recipes land. */}
      {recipes.length === 0 && (
        <Text size={200} className={styles.note}>
          Recipes appear here when your files have the right columns — a date, a number, a category.
        </Text>
      )}
    </nav>
  );
}
