import { create } from "zustand";
import type { DataSource, FileNode } from "@/contracts";
import { ragService } from "@/contracts";

/**
 * Shared RAG selection state. The explorer writes to it (toggling inclusion);
 * chat reads `includedFileIds` to scope retrieval. This store is the live wire
 * between the explorer and chat features.
 */
interface RagStore {
  sources: DataSource[];
  nodes: FileNode[];
  /** True while the explorer is in rapid highlight/unhighlight mode. */
  selectionMode: boolean;

  load: () => Promise<void>;
  setSelectionMode: (on: boolean) => void;
  toggleIncluded: (nodeId: string) => Promise<void>;
  toggleSourceAvailable: (sourceId: string) => Promise<void>;

  /** Ids of every included file (leaf) node - what chat retrieves against. */
  includedFileIds: () => string[];
}

export const useRagStore = create<RagStore>((set, get) => ({
  sources: [],
  nodes: [],
  selectionMode: false,

  load: async () => {
    const [sources, nodes] = await Promise.all([
      ragService.listSources(),
      ragService.listNodes(),
    ]);
    set({ sources, nodes });
  },

  setSelectionMode: (on) => set({ selectionMode: on }),

  toggleIncluded: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    await ragService.setIncluded(nodeId, !node.ragIncluded);
    set({ nodes: await ragService.listNodes() });
  },

  toggleSourceAvailable: async (sourceId) => {
    const source = get().sources.find((s) => s.id === sourceId);
    if (!source) return;
    await ragService.setSourceAvailable(sourceId, !source.available);
    const [sources, nodes] = await Promise.all([
      ragService.listSources(),
      ragService.listNodes(),
    ]);
    set({ sources, nodes });
  },

  includedFileIds: () =>
    get()
      .nodes.filter((n) => n.kind === "file" && n.ragIncluded)
      .map((n) => n.id),
}));
