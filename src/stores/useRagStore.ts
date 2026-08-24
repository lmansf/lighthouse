import { create } from "zustand";
import type { EgressSnapshot, PolicySnapshot } from "@/contracts";
import { setManagedLocks } from "./managedLocks";
import { ragService } from "@/contracts";

/**
 * Shared engine state that isn't per-conversation: what this build can do, the
 * managed-policy locks, the session egress figure, and the progress of an
 * in-flight add.
 *
 * Until 0.15.0 this store WAS the vault: a file tree, per-node inclusion and
 * local-only flags with optimistic paints and epoch reconciliation, curation
 * rules, move/rename/create/remove/restore, and the `includedFileIds` chat
 * retrieved against. All of it went with the vault (openspec:
 * refocus-chat-attachments) — a conversation's attachments are chat state now,
 * held next to the chat that owns them.
 */
interface RagStore {
  /**
   * Human-readable failure from the last write. The UI surfaces it in a notice
   * banner, then clears it.
   */
  lastError: string | null;
  clearLastError: () => void;
  /**
   * True only on the desktop build, where filesystem-backed actions (opening a
   * cited file natively) work. The web deployment reports false so the UI can
   * hide affordances the server would refuse.
   */
  desktop: boolean;
  /**
   * The managed-policy snapshot (openspec: add-managed-policy), fetched once
   * per session. null until the first load; components render locked
   * ("Managed by your organization") controls from `policy.locks`, and the
   * chat store consults it before persisting history.
   */
  policy: PolicySnapshot | null;
  /**
   * Session egress snapshot (S3), refreshed every poll: what has left this
   * machine this session. `null` until first load; the header shield renders
   * "All local" (total 0) or "N requests to <host>" from it.
   */
  egress: EgressSnapshot | null;
  /**
   * Progress of an in-flight add; null when idle. The composer renders it as a
   * processing overlay so a big drop never reads as a frozen app.
   */
  processing: { done: number; total: number; label: string } | null;

  load: () => Promise<void>;
  /**
   * Send files to the engine as `conversationId`'s ATTACHMENTS (openspec:
   * refocus-chat-attachments) — the engine mints `att-` ids, enforces the
   * 10-file cap, and starts ingestion at once. `addedIds` are those attachment
   * ids, in upload order; `skipped` carries the engine's per-file reason.
   */
  upload: (
    files: File[],
    conversationId: string,
  ) => Promise<{ addedIds: string[]; skipped: { name: string; reason: string }[] }>;
}

export const useRagStore = create<RagStore>((set, get) => ({
  lastError: null,
  desktop: false,
  policy: null,
  egress: null,
  processing: null,

  clearLastError: () => set({ lastError: null }),

  load: async () => {
    // Managed policy changes only across restarts — fetch once, not on every
    // background poll. Every lock surface (Preferences, AI models, chat-history
    // store) reads this one cached snapshot.
    const wantPolicy = get().policy === null;
    // Egress, unlike policy, changes intra-session — fetch it every tick so the
    // header shield stays live off the poll both windows already share.
    const [caps, policy, egress] = await Promise.all([
      ragService.capabilities(),
      wantPolicy ? ragService.policy().catch(() => null) : Promise.resolve(get().policy),
      ragService.egress().catch(() => null),
    ]);
    if (wantPolicy && policy) {
      set({ policy });
      // Publish to the dependency-free signal the chat store reads (see
      // managedLocks.ts).
      setManagedLocks({ chatHistoryOff: policy.locks.chatHistoryOff });
    }
    // Only write what actually moved: this runs on a background poll every few
    // seconds, and a new-but-equal value would re-render every subscriber on
    // each idle tick forever.
    const cur = get();
    const patch: Partial<Pick<RagStore, "desktop" | "egress">> = {};
    if (cur.desktop !== caps.desktop) patch.desktop = caps.desktop;
    // Only re-set egress when its total moved — a same-count poll must not
    // re-render the shield (the perf-poll no-op-diff discipline).
    if (egress && egress.total !== (cur.egress?.total ?? -1)) patch.egress = egress;
    if (patch.desktop !== undefined || patch.egress) set(patch);
  },

  upload: async (files, conversationId) => {
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
        fd.append("conversationId", conversationId);
        for (const f of b) fd.append("files", f);
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
    return { addedIds, skipped };
  },
}));

