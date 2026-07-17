import { create } from "zustand";
import type { View } from "@/contracts";
import { ragService } from "@/contracts";

/**
 * Engine-backed shaped-views list (openspec: add-shaped-views §4), shared by
 * the Library nav. The ENGINE owns the records — `.rag-vault/views.json` via
 * the RagService view methods — this store is only the session cache of the
 * last `listViews()` read, refreshed after every nav mutation and on the
 * `lighthouse:views-changed` DOM event so a view saved from anywhere (the
 * chat's Save-as-view chip, the shaping dialog) still lands in the nav.
 *
 * Mirrors useInvestigationsStore: single-flight refresh, quiet degradation, an
 * ensureLoaded() safe to call from every mount.
 *
 * Effective-local-only is NOT on the raw `View` record — it needs vault state
 * only the engine resolves (a view is local-only when ANY transitive source
 * file is). The nav wants a lock badge per row, so the store hydrates it
 * lazily: one `inspectView()` per view id, cached in `localOnlyById`,
 * best-effort. The inspector stays the authoritative local-only surface.
 */
interface ViewsStore {
  /** Every saved view, engine creation order. */
  views: View[];
  /** True once a load has succeeded (an empty vault is a real, loaded state). */
  loaded: boolean;
  /** Effective-local-only per view id, hydrated lazily from `inspectView`. */
  localOnlyById: Record<string, boolean>;
  /** Re-read the list from the engine. */
  refresh: () => Promise<void>;
  /** Load once; safe to call from every mount (no-op after first success). */
  ensureLoaded: () => void;
  /** Fetch + cache effective-local-only for any not-yet-known ids (best-effort). */
  hydrateLocalOnly: (ids: string[]) => void;
}

export const useViewsStore = create<ViewsStore>((set, get) => {
  // Single-flight guard: several ViewsNav instances (main + explorer windows)
  // ensureLoaded() on mount; only one fetch should go out.
  let inflight: Promise<void> | null = null;
  return {
    views: [],
    loaded: false,
    localOnlyById: {},

    refresh: async () => {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const views = await ragService.listViews();
          set({ views, loaded: true });
        } catch {
          // Quiet degradation: keep the last known list; `loaded` stays false
          // on a first-load failure so ensureLoaded() retries later.
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    ensureLoaded: () => {
      if (!get().loaded) void get().refresh();
    },

    hydrateLocalOnly: (ids) => {
      const known = get().localOnlyById;
      // Only the uncached ids — the badge is stored state, so once resolved it
      // holds until the next reload; the inspector re-fetches on open regardless.
      const missing = ids.filter((id) => !(id in known));
      for (const id of missing) {
        ragService
          .inspectView(id)
          .then((v) => {
            if (typeof v.localOnly === "boolean") {
              const flag = v.localOnly;
              set((s) => ({ localOnlyById: { ...s.localOnlyById, [id]: flag } }));
            }
          })
          .catch(() => {
            /* best-effort: a missing badge is fine, the inspector is authoritative */
          });
      }
    },
  };
});
