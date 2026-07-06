import { create } from "zustand";
import type { DataSource, FileNode } from "@/contracts";
import { ragService } from "@/contracts";
import { logEvent } from "@/lib/logEvent";

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
   * Human-readable failure from the last visibility change (optimistic toggles
   * reconcile against the server; when the POST fails we reload and put the
   * reason here). The explorer surfaces it in its notice banner, then clears it.
   */
  lastError: string | null;
  clearLastError: () => void;
  /**
   * Bumped on every optimistic visibility write. `load()` captures it before
   * fetching and discards a snapshot that raced with a newer optimistic flip —
   * otherwise the background poll could overwrite a just-toggled eye with
   * stale server state and the row would flicker wrong until the next poll.
   */
  mutationEpoch: number;
  /** Visibility POSTs still in flight — load() holds snapshots while > 0. */
  pendingWrites: number;
  /**
   * True only on the desktop build, where filesystem-backed actions (opening a
   * cited file natively) work. The web deployment reports false so the UI can
   * hide affordances the server would refuse.
   */
  desktop: boolean;
  /**
   * Selection mode: clicking a row picks it (multi-select) instead of its
   * navigation action, so the user can select several files and then apply one
   * action — "make visible" (include) or "remove" (exclude) — to all of them.
   */
  selectionMode: boolean;
  /** Ids picked while in selection mode. */
  selectedIds: string[];
  /**
   * Progress of an in-flight add (linking or uploading); null when idle. The
   * explorer renders it as a processing overlay so a big add never reads as a
   * frozen app.
   */
  processing: { done: number; total: number; label: string } | null;

  load: () => Promise<void>;
  setSelectionMode: (on: boolean) => void;
  toggleSelected: (nodeId: string) => void;
  /** Replace the selection wholesale (the explorer's "Select all"); turns
   *  selection mode on so the action bar is there to act on it. */
  selectAll: (nodeIds: string[]) => void;
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
  /**
   * Link several files/folders in place by absolute path (desktop-only),
   * tracking `processing`. Returns the linked nodes (so a caller can e.g.
   * attach them to a question) and any per-path failures (e.g. a path that
   * overlaps an existing link) for the caller to surface.
   */
  linkPaths: (paths: string[]) => Promise<{
    linked: { id: string; name: string; kind: "file" | "folder" }[];
    failed: { path: string; reason: string }[];
  }>;
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

/**
 * Collect the given ids plus every descendant id — the client-side mirror of
 * the server's setIncluded cascade, so optimistic visibility flips paint the
 * same rows the server will actually change.
 */
function withDescendants(nodes: FileNode[], rootIds: string[]): Set<string> {
  const childIds = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const arr = childIds.get(n.parentId);
    if (arr) arr.push(n.id);
    else childIds.set(n.parentId, [n.id]);
  }
  const ids = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of childIds.get(id) ?? []) stack.push(child);
  }
  return ids;
}

export const useRagStore = create<RagStore>((set, get) => ({
  sources: [],
  nodes: [],
  lastError: null,
  mutationEpoch: 0,
  pendingWrites: 0,
  desktop: false,
  selectionMode: false,
  selectedIds: [],
  processing: null,

  clearLastError: () => set({ lastError: null }),

  load: async () => {
    const epoch = get().mutationEpoch;
    const [sources, nodes, caps] = await Promise.all([
      ragService.listSources(),
      ragService.listNodes(),
      ragService.capabilities(),
    ]);
    // A visibility flip landed while this snapshot was in flight (epoch moved),
    // or one is still being written (pendingWrites) — either way the snapshot
    // is stale or mixed, and applying it would undo the optimistic state.
    // Drop it; each write reconciles with a fresh load() when it settles.
    if (get().mutationEpoch !== epoch || get().pendingWrites > 0) return;
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

  selectAll: (nodeIds) => set({ selectionMode: true, selectedIds: nodeIds }),

  clearSelection: () => set({ selectedIds: [] }),

  applySelection: async (include) => {
    const ids = get().selectedIds;
    if (ids.length === 0) return;
    // Optimistic: paint the whole selection (and each folder's descendants,
    // mirroring the server cascade) before the POSTs so the bulk switch
    // responds instantly. The selection is kept so the stateful "Visible to
    // AI" toggle reflects the result.
    const affected = withDescendants(get().nodes, ids);
    set((s) => ({
      mutationEpoch: s.mutationEpoch + 1,
      pendingWrites: s.pendingWrites + 1,
      nodes: s.nodes.map((n) =>
        affected.has(n.id) ? { ...n, ragIncluded: include } : n,
      ),
    }));
    try {
      // setIncluded cascades to a folder's descendants, so picking a folder works.
      for (const id of ids) await ragService.setIncluded(id, include);
    } catch (err) {
      set({
        lastError: `Could not change AI visibility: ${
          err instanceof Error && err.message ? err.message : "request failed"
        }`,
      });
    } finally {
      // Reconcile with the server's truth on success AND failure: the engine
      // can veto part of a change (e.g. re-including a file under an excluded
      // ancestor), so the optimistic paint is a prediction, not the record.
      set((s) => ({
        pendingWrites: s.pendingWrites - 1,
        mutationEpoch: s.mutationEpoch + 1,
      }));
      if (get().pendingWrites === 0) await get().load().catch(() => {});
    }
  },

  toggleIncluded: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const included = !node.ragIncluded;
    // Optimistic: flip locally first (folders flip all descendants, mirroring
    // the server cascade) so the eye toggle feels instant even when the vault
    // is slow; reconcile against the server only on failure.
    const affected = withDescendants(get().nodes, [nodeId]);
    set((s) => ({
      mutationEpoch: s.mutationEpoch + 1,
      pendingWrites: s.pendingWrites + 1,
      nodes: s.nodes.map((n) =>
        affected.has(n.id) ? { ...n, ragIncluded: included } : n,
      ),
    }));
    try {
      await ragService.setIncluded(nodeId, included);
    } catch (err) {
      set({
        lastError: `Could not change AI visibility: ${
          err instanceof Error && err.message ? err.message : "request failed"
        }`,
      });
    } finally {
      // Reconcile with the server's truth on success AND failure (see
      // applySelection) — and only when the last in-flight write settles, so
      // rapid toggles don't fetch a mixed snapshot mid-batch.
      set((s) => ({
        pendingWrites: s.pendingWrites - 1,
        mutationEpoch: s.mutationEpoch + 1,
      }));
      if (get().pendingWrites === 0) await get().load().catch(() => {});
    }
  },

  toggleSourceAvailable: async (sourceId) => {
    const source = get().sources.find((s) => s.id === sourceId);
    if (!source) return;
    // Privacy-safe availability telemetry at the source/database level: one event
    // per toggle (not the files it cascades over), coarse scope only.
    logEvent(source.available ? "file_made_unavailable" : "file_made_available", {
      scope: "source",
    });
    await ragService.setSourceAvailable(sourceId, !source.available);
    const [sources, nodes] = await Promise.all([
      ragService.listSources(),
      ragService.listNodes(),
    ]);
    set({ sources, nodes });
  },

  upload: async (files, dir = null) => {
    if (files.length === 0) return { addedIds: [], skipped: [] };
    // One giant multipart POST gave no feedback until the entire body had
    // uploaded - a big drop read as a frozen app. Send bounded batches and
    // advance `processing` between them so the overlay shows real progress.
    const MAX_BATCH_FILES = 25;
    const MAX_BATCH_BYTES = 64 * 1024 * 1024;
    const batches: File[][] = [];
    let batch: File[] = [];
    let batchBytes = 0;
    for (const f of files) {
      if (batch.length > 0 && (batch.length >= MAX_BATCH_FILES || batchBytes + f.size > MAX_BATCH_BYTES)) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(f);
      batchBytes += f.size;
    }
    if (batch.length > 0) batches.push(batch);

    set({ processing: { done: 0, total: files.length, label: "Adding" } });
    const addedIds: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    try {
      for (const b of batches) {
        const fd = new FormData();
        if (dir) fd.append("dir", dir);
        for (const f of b) {
          fd.append("files", f);
          // For a folder drop/pick the browser sets webkitRelativePath (e.g.
          // "docs/2024/q1.md"); send it so the server recreates the structure.
          fd.append("paths", f.webkitRelativePath || "");
        }
        try {
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          const data: { added?: { newId: string }[]; skipped?: { name: string; reason: string }[] } =
            res.ok ? await res.json().catch(() => ({})) : {};
          if (res.ok) {
            addedIds.push(...(data.added ?? []).map((a) => a.newId));
            skipped.push(...(data.skipped ?? []));
          } else {
            skipped.push(...b.map((f) => ({ name: f.name, reason: "upload request failed" })));
          }
        } catch {
          // e.g. an unreadable directory entry in the FileList aborts the fetch
          skipped.push(...b.map((f) => ({ name: f.name, reason: "could not be read" })));
        }
        set((s) => ({
          processing: s.processing && { ...s.processing, done: s.processing.done + b.length },
        }));
      }
    } finally {
      set({ processing: null });
    }
    await get().load();
    return { addedIds, skipped };
  },

  linkPaths: async (paths) => {
    if (paths.length === 0) return { linked: [], failed: [] };
    set({ processing: { done: 0, total: paths.length, label: "Linking" } });
    const linked: { id: string; name: string; kind: "file" | "folder" }[] = [];
    const failed: { path: string; reason: string }[] = [];
    try {
      for (const p of paths) {
        try {
          const { id, kind } = await ragService.addReference(p);
          // Reference names are the path's basename (see server addReference).
          const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
          linked.push({ id, name, kind });
        } catch (err) {
          failed.push({ path: p, reason: err instanceof Error ? err.message : "could not be linked" });
        }
        set((s) => ({
          processing: s.processing && { ...s.processing, done: s.processing.done + 1 },
        }));
      }
    } finally {
      set({ processing: null });
    }
    await get().load();
    return { linked, failed };
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
