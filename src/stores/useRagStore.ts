import { create } from "zustand";
import type { DataSource, FileNode } from "@/contracts";
import { ragService } from "@/contracts";

/** SharePoint device-code sign-in: dialog visibility + flow phase. */
export interface SharePointConnect {
  open: boolean;
  phase: "idle" | "starting" | "waiting" | "connected" | "expired" | "error";
  /** Short code the user types at the verification URL. */
  userCode?: string;
  verificationUri?: string;
  /** Microsoft's human-readable instruction string. */
  message?: string;
  error?: string;
}

/**
 * Shared RAG selection state. The explorer writes to it (toggling inclusion);
 * chat reads `includedFileIds` to scope retrieval. This store is the live wire
 * between the explorer and chat features.
 */
interface RagStore {
  sources: DataSource[];
  nodes: FileNode[];
  /**
   * True only on the desktop build, where filesystem-backed actions (opening a
   * cited file natively) work. The web deployment reports false so the UI can
   * hide affordances the server would refuse.
   */
  desktop: boolean;
  /**
   * Selection mode: clicking a row picks it (multi-select) instead of toggling
   * its RAG inclusion, so the user can select several files and then apply one
   * action — "make visible" (include) or "remove" (exclude) — to all of them.
   */
  selectionMode: boolean;
  /** Ids picked while in selection mode. */
  selectedIds: string[];

  load: () => Promise<void>;
  setSelectionMode: (on: boolean) => void;
  toggleSelected: (nodeId: string) => void;
  clearSelection: () => void;
  /**
   * Apply include (true) / exclude (false) to every selected node. The selection
   * is kept so a stateful "Visible to AI" toggle reflects the result.
   */
  applySelection: (include: boolean) => Promise<void>;
  toggleIncluded: (nodeId: string) => Promise<void>;
  toggleSourceAvailable: (sourceId: string) => Promise<void>;
  /**
   * Upload files into the vault; they land excluded by default. Returns the new
   * node ids (`addedIds`, in upload order) and any `skipped` files. The ids let
   * callers act on the fresh uploads — e.g. chat attaches an OS-dropped file.
   */
  upload: (
    files: File[],
    dir?: string | null,
  ) => Promise<{ addedIds: string[]; skipped: { name: string; reason: string }[] }>;
  /** Link a file/folder by its real path instead of copying (desktop-only). */
  addReference: (path: string) => Promise<void>;
  /** Remove a reference (unlink); real files are left in place. */
  removeReference: (refId: string) => Promise<void>;
  /**
   * Remove nodes from the vault (non-destructive: linked items unlink, vault
   * items move to a recoverable trash). Clears successfully-removed ids from the
   * selection and rejects if any removal failed.
   */
  removeFromVault: (nodeIds: string[]) => Promise<void>;

  /** SharePoint connection flow state (device-code dialog + polling). */
  sharepoint: SharePointConnect;
  /** Begin the SharePoint device-code sign-in; opens the dialog and polls. */
  connectSharePoint: () => Promise<void>;
  /** Dismiss the connect dialog and stop polling. */
  closeSharePointDialog: () => void;
  /** Sign out of SharePoint, dropping tokens and mirrored content. */
  disconnectSharePoint: () => Promise<void>;

  /** Ids of every included file (leaf) node - what chat retrieves against. */
  includedFileIds: () => string[];
}

export const useRagStore = create<RagStore>((set, get) => ({
  sources: [],
  nodes: [],
  desktop: false,
  selectionMode: false,
  selectedIds: [],

  load: async () => {
    const [sources, nodes, caps] = await Promise.all([
      ragService.listSources(),
      ragService.listNodes(),
      ragService.capabilities(),
    ]);
    set({ sources, nodes, desktop: caps.desktop });
  },

  // Leaving selection mode clears the pending picks so they don't linger.
  setSelectionMode: (on) => set({ selectionMode: on, selectedIds: on ? get().selectedIds : [] }),

  toggleSelected: (nodeId) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(nodeId)
        ? s.selectedIds.filter((id) => id !== nodeId)
        : [...s.selectedIds, nodeId],
    })),

  clearSelection: () => set({ selectedIds: [] }),

  applySelection: async (include) => {
    const ids = get().selectedIds;
    // setIncluded cascades to a folder's descendants, so picking a folder works.
    for (const id of ids) await ragService.setIncluded(id, include);
    // Keep the selection so the "Visible to AI" toggle reflects the new state.
    set({ nodes: await ragService.listNodes() });
  },

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
    if (files.length === 0) return { addedIds: [], skipped: [] };
    const fd = new FormData();
    if (dir) fd.append("dir", dir);
    for (const f of files) {
      fd.append("files", f);
      // For a folder drop/pick the browser sets webkitRelativePath (e.g.
      // "docs/2024/q1.md"); send it so the server recreates the structure.
      fd.append("paths", f.webkitRelativePath || "");
    }
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data: { added?: { newId: string }[]; skipped?: { name: string; reason: string }[] } =
      res.ok ? await res.json().catch(() => ({})) : {};
    const addedIds = (data.added ?? []).map((a) => a.newId);
    const skipped = res.ok
      ? (data.skipped ?? [])
      : files.map((f) => ({ name: f.name, reason: "upload request failed" }));
    await get().load();
    return { addedIds, skipped };
  },

  addReference: async (path) => {
    await ragService.addReference(path);
    await get().load();
  },

  removeReference: async (refId) => {
    await ragService.removeReference(refId);
    await get().load();
  },

  removeFromVault: async (nodeIds) => {
    const failed: string[] = [];
    for (const nodeId of nodeIds) {
      try {
        await ragService.removeFromVault(nodeId);
      } catch {
        failed.push(nodeId);
      }
    }
    // Keep whatever failed selected so the user can retry; drop the rest.
    set({ selectedIds: failed });
    await get().load();
    if (failed.length) {
      throw new Error(`Failed to remove ${failed.length} of ${nodeIds.length} item(s)`);
    }
  },

  sharepoint: { open: false, phase: "idle" },

  connectSharePoint: async () => {
    set({ sharepoint: { open: true, phase: "starting" } });
    const post = (op: string) =>
      fetch("/api/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op }),
      });
    try {
      const res = await post("start");
      const data: { userCode?: string; verificationUri?: string; message?: string; interval?: number; error?: string } =
        await res.json();
      if (!res.ok) throw new Error(data.error || "could not start sign-in");
      set({
        sharepoint: {
          open: true,
          phase: "waiting",
          userCode: data.userCode,
          verificationUri: data.verificationUri,
          message: data.message,
        },
      });
      const interval = Math.max(2, Number(data.interval) || 5);
      const poll = async () => {
        const cur = get().sharepoint;
        if (!cur.open || cur.phase !== "waiting") return; // dialog closed / done
        let pres: { status?: string } = { status: "pending" };
        try {
          pres = await (await post("poll")).json();
        } catch {
          pres = { status: "pending" };
        }
        const now = get().sharepoint;
        if (!now.open || now.phase !== "waiting") return;
        if (pres.status === "connected") {
          set((s) => ({ sharepoint: { ...s.sharepoint, phase: "connected" } }));
          await get().load();
          return;
        }
        if (pres.status === "expired") {
          set((s) => ({ sharepoint: { ...s.sharepoint, phase: "expired" } }));
          return;
        }
        setTimeout(() => void poll(), interval * 1000);
      };
      setTimeout(() => void poll(), interval * 1000);
    } catch (err) {
      set({
        sharepoint: {
          open: true,
          phase: "error",
          error: err instanceof Error ? err.message : "connection error",
        },
      });
    }
  },

  closeSharePointDialog: () => set({ sharepoint: { open: false, phase: "idle" } }),

  disconnectSharePoint: async () => {
    await fetch("/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "disconnect" }),
    }).catch(() => {});
    await get().load();
  },

  includedFileIds: () =>
    get()
      .nodes.filter((n) => n.kind === "file" && n.ragIncluded)
      .map((n) => n.id),
}));
