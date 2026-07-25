"use client";

/**
 * §48 §1/§2: render the SINGLE combined, ≤3, priority-ordered suggestion list
 * (suggestionChips). Ask and recipe chips submit their question immediately; a
 * report chip opens the template menu (ReportChip). Renders nothing when the
 * list is empty — no calm-breaking empty row. Reused in the hero AND above the
 * ongoing-conversation composer (§2), so suggestions live beyond the empty
 * hero. UI-only; the validation lives in the engine ops behind the chips.
 */
import { Button } from "@fluentui/react-components";
import { runRecipeQuestion } from "@/contracts/types";
import type { SuggestionChip } from "./suggestionChips";
import { ReportChip } from "./ReportChip";

export function SuggestionChips({
  chips,
  onAsk,
}: {
  chips: SuggestionChip[];
  onAsk: (question: string) => void;
}) {
  return (
    <>
      {chips.map((c) => {
        if (c.kind === "ask") {
          return (
            <Button
              key={`ask:${c.label}`}
              appearance="secondary"
              size="small"
              shape="circular"
              onClick={() => onAsk(c.question)}
            >
              {c.label}
            </Button>
          );
        }
        if (c.kind === "recipe") {
          return (
            <Button
              key={`recipe:${c.recipe.id}:${c.recipe.table}`}
              appearance="secondary"
              size="small"
              shape="circular"
              title={c.recipe.summary}
              onClick={() => onAsk(runRecipeQuestion(c.recipe.id, c.recipe.table))}
            >
              {c.recipe.name}
            </Button>
          );
        }
        return <ReportChip key={`report:${c.table}`} table={c.table} />;
      })}
    </>
  );
}
