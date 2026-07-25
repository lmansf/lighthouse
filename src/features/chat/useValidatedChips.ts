/**
 * §22.3: one validated, PRELOADED source for the empty-state suggestion chips
 * (suggested asks + applicable recipes). The engine ops are already
 * posture-gated and applicability-checked (meta.rs: suggested_asks_resolved /
 * applicable_recipes both take `is_cloud` and read the catalog), so a chip the
 * engine returns can succeed — the CLIENT's job is to never show a stale set.
 *
 * Staleness was the reported bug's source: chips were fetched on vault change
 * only, so a provider switch (local ⇄ cloud — which changes which files are
 * shareable and therefore which chips are valid) or an investigation switch
 * kept serving the previous posture's suggestions. This hook re-keys on ALL of
 * it — included set, provider, investigation, and the shared views nonce — and
 * serves stale-while-revalidate from a module cache so the empty state renders
 * chips instantly on return visits (the "preload" half of §22.3).
 */
import { useEffect, useState } from "react";
import { ragService } from "@/contracts";
import type { RecipeCard } from "@/contracts/types";
import { useAuthStore } from "@/stores/useAuthStore";
import { useChatStore } from "@/stores/useChatStore";

export interface ValidatedChips {
  asks: { label: string; question: string }[];
  recipes: RecipeCard[];
  // §48 §1: the investigable tables that back the "Report on <table>" chips —
  // fetched HERE (one place) so the combined ≤3 cap sees all three chip counts
  // at once. Engine-validated like the rest: capabilityMap only reports a table
  // investigable when a real report can run over it (empty on the web twin).
  reportTables: string[];
}

const EMPTY: ValidatedChips = { asks: [], recipes: [], reportTables: [] };

/** Bounded module cache — key → last validated chip set. Insertion-ordered
 *  (Map), oldest evicted past the cap; a session touches a handful of keys. */
const cache = new Map<string, ValidatedChips>();
const CACHE_CAP = 12;

function remember(key: string, value: ValidatedChips) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function useValidatedChips(includedFileIds: string[]): ValidatedChips {
  const providerId = useAuthStore((s) => s.onboarding?.providerId ?? "none");
  const investigationId = useChatStore((s) => s.currentInvestigationId ?? "");
  // A saved/renamed/deleted view changes which tables (and so which chips)
  // exist — the same shared signal RecipesNav already listens to.
  const [viewsNonce, setViewsNonce] = useState(0);
  useEffect(() => {
    const onChanged = () => setViewsNonce((n) => n + 1);
    window.addEventListener("lighthouse:views-changed", onChanged);
    return () => window.removeEventListener("lighthouse:views-changed", onChanged);
  }, []);

  const key = `${includedFileIds.join("\x00")}|${providerId}|${investigationId}|${viewsNonce}`;
  const [chips, setChips] = useState<ValidatedChips>(() => cache.get(key) ?? EMPTY);

  useEffect(() => {
    let alive = true;
    // Instant render from the preloaded set for this exact posture…
    const hit = cache.get(key);
    setChips(hit ?? EMPTY);
    // …then revalidate in the background; the engine re-checks files, columns,
    // and applicability against the CURRENT posture on every call.
    Promise.all([
      ragService.suggestedAsks(includedFileIds),
      ragService.applicableRecipes(includedFileIds),
      ragService.capabilityMap(includedFileIds),
    ])
      .then(([asks, recipes, map]) => {
        const reportTables = (map?.tables ?? [])
          .filter((t) => t.investigable)
          .map((t) => t.name);
        const next: ValidatedChips = { asks, recipes, reportTables };
        remember(key, next);
        if (alive) setChips(next);
      })
      .catch(() => {
        // Best-effort: a failed refresh keeps whatever was shown (possibly
        // EMPTY) — chips are suggestions, never worth an error state.
      });
    return () => {
      alive = false;
    };
    // includedFileIds' identity is folded into `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return chips;
}
