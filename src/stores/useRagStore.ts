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
  /** Upload files into the vault; they land excluded by default. Returns any skipped files. */
  upload: (files: File[], dir?: string | null) => Promise<{ name: string; reason: string }[]>;
  /** Link a file/folder by its real path instead of copying (desktop-only). */
  addReference: (path: string) => Promise<void>;
  /** Remove a reference (unlink); real files are left in place. */
  removeReference: (refId: string) => Promise<void>;

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

  upload: async (files, dir = null) => {
    if (files.length === 0) return [];
    const fd = new FormData();
    if (dir) fd.append("dir", dir);
    for (const f of files) {
      fd.append("files", f);
      // For a folder drop/pick the browser sets webkitRelativePath (e.g.
      // "docs/2024/q1.md"); send it so the server recreates the structure.
      fd.append("paths", f.webkitRelativePath || "");
    }
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const skipped: { name: string; reason: string }[] = res.ok
      ? ((await res.json().catch(() => ({}))).skipped ?? [])
      : files.map((f) => ({ name: f.name, reason: "upload request failed" }));
    await get().load();
    return skipped;
  },

  addReference: async (path) => {
    await ragService.addReference(path);
    await get().load();
  },

  removeReference: async (refId) => {
    await ragService.removeReference(refId);
    await get().load();
  },

  includedFileIds: () =>
    get()
      .nodes.filter((n) => n.kind === "file" && n.ragIncluded)
      .map((n) => n.id),
}));
