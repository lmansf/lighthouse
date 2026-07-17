import { create } from "zustand";
import type { Investigation } from "@/contracts";
import { ragService } from "@/contracts";

/**
 * Engine-backed investigations list (openspec: add-investigations §4), shared
 * between the sidebar nav (create/rename/archive) and the chat panel (current
 * investigation's name, scope, and provider policy). The ENGINE owns the data
 * — `.rag-vault/investigations.json` via the RagService methods — this store
 * is only the session cache of the last `listInvestigations()` read, so a
 * rename in the nav updates the chat header without a second fetch.
 *
 * Mutations live with their surfaces (the nav calls the service directly);
 * they call `refresh()` afterwards so every subscriber sees the new truth.
 */
interface InvestigationsStore {
  /** Every record, creation order, ARCHIVED INCLUDED — callers filter. */
  investigations: Investigation[];
  /** True once a load has succeeded (an empty vault is a real, loaded state). */
  loaded: boolean;
  /** Re-read the list from the engine. */
  refresh: () => Promise<void>;
  /** Load once; safe to call from every mount (no-op after first success). */
  ensureLoaded: () => void;
}

export const useInvestigationsStore = create<InvestigationsStore>((set, get) => {
  // Single-flight guard: the nav and the chat panel both ensureLoaded() on
  // mount; only one fetch should go out.
  let inflight: Promise<void> | null = null;
  return {
    investigations: [],
    loaded: false,

    refresh: async () => {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const investigations = await ragService.listInvestigations();
          set({ investigations, loaded: true });
        } catch {
          // Quiet degradation: keep whatever we last knew; `loaded` stays
          // false on a first-load failure so ensureLoaded() retries later.
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    ensureLoaded: () => {
      if (!get().loaded) void get().refresh();
    },
  };
});
