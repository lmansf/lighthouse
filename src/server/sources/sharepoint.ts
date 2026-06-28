/**
 * SharePoint / OneDrive source connector (Microsoft Graph).
 *
 * Model: once the user signs in, the connector caches a names-only placeholder
 * tree (no content downloaded). Enabling a file "mirrors" just that file's bytes
 * into a local mirror dir, where the normal retrieval pipeline — including the
 * PDF/Word/Excel extractor — reads it like any vault file. Disabling removes the
 * mirror. Node ids are namespaced `sharepoint::<driveId>::<itemId>` so the
 * registry routes ops here.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SHAREPOINT_SOURCE_ID } from "../config";
import type { DataSource, FileNode } from "@/contracts";
import type { SourceConnector } from "./types";
import {
  loadState,
  saveState,
  isConnected,
  mirrorDir,
  type SpNode,
  type MsState,
} from "./microsoft/auth";
import { listTree, downloadItem } from "./microsoft/graph";

const ownsId = (id: string) => id.startsWith(`${SHAREPOINT_SOURCE_ID}::`);

function nodeMap(nodes: SpNode[]): Map<string, SpNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Effective inclusion: the node's own flag, or any ancestor folder's flag. */
function effectivelyIncluded(id: string, state: MsState, byId: Map<string, SpNode>): boolean {
  const inc = state.included ?? {};
  let cur: string | null = id;
  while (cur) {
    if (inc[cur]) return true;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Local mirror path for a node, preserving its extension so the extractor dispatches. */
function mirrorPathFor(node: SpNode): string {
  const ext = path.extname(node.name);
  return path.join(mirrorDir(), crypto.createHash("sha1").update(node.id).digest("hex") + ext);
}

/** All descendant file nodes of a folder (inclusive of a file passed directly). */
function descendantFiles(id: string, nodes: SpNode[]): SpNode[] {
  const byParent = new Map<string | null, SpNode[]>();
  for (const n of nodes) {
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  const out: SpNode[] = [];
  const stack = [id];
  const self = nodes.find((n) => n.id === id);
  if (self && self.kind === "file") return [self];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of byParent.get(cur) ?? []) {
      if (child.kind === "file") out.push(child);
      else stack.push(child.id);
    }
  }
  return out;
}

async function mirror(node: SpNode): Promise<void> {
  const dest = mirrorPathFor(node);
  if (fs.existsSync(dest)) return; // already mirrored
  try {
    await downloadItem(node.driveId, node.itemId, dest);
  } catch (err) {
    console.warn(`[sharepoint] could not mirror ${node.name}: ${(err as Error).message}`);
  }
}

function unmirror(node: SpNode): void {
  try {
    fs.rmSync(mirrorPathFor(node), { force: true });
  } catch {
    // best-effort
  }
}

/** Refresh the cached placeholder tree from Graph (after connect / on demand). */
export async function refreshListing(): Promise<number> {
  const nodes = await listTree();
  const s = loadState();
  s.nodes = nodes;
  saveState(s);
  return nodes.length;
}

export const sharepoint: SourceConnector = {
  sourceId: SHAREPOINT_SOURCE_ID,
  ownsId,

  // Only surfaces as a source once the user has connected.
  async isPresent() {
    return isConnected();
  },

  async source(): Promise<DataSource> {
    const s = loadState();
    const email = s.account?.email;
    return {
      id: SHAREPOINT_SOURCE_ID,
      name: email ? `SharePoint · ${email}` : "SharePoint",
      kind: "folder",
      available: s.available ?? true,
    };
  },

  async listNodes(): Promise<FileNode[]> {
    const s = loadState();
    if (!isConnected()) return [];
    const byId = nodeMap(s.nodes ?? []);
    return (s.nodes ?? []).map((n) => ({
      id: n.id,
      parentId: n.parentId,
      sourceId: SHAREPOINT_SOURCE_ID,
      name: n.name,
      kind: n.kind,
      mimeType: n.mimeType,
      size: n.size,
      ragIncluded: effectivelyIncluded(n.id, s, byId),
      external: true, // content lives remotely until mirrored — reuse external styling
    }));
  },

  async setIncluded(nodeId, included) {
    const s = loadState();
    s.included = s.included ?? {};
    const node = (s.nodes ?? []).find((n) => n.id === nodeId);
    if (!node) return;
    if (included) s.included[nodeId] = true;
    else delete s.included[nodeId];
    saveState(s);

    // Mirror (or drop) the affected files so retrieval has their content.
    const files = descendantFiles(nodeId, s.nodes ?? []);
    if (included) {
      for (const f of files) await mirror(f);
    } else {
      const byId = nodeMap(s.nodes ?? []);
      for (const f of files) {
        if (!effectivelyIncluded(f.id, s, byId)) unmirror(f);
      }
    }
  },

  async setAvailable(available) {
    const s = loadState();
    s.available = available;
    saveState(s);
  },

  /** Mirrored content for the connector's enabled files, for the ranker. */
  async retrievalItems(includedIds: string[]): Promise<{ id: string; name: string; abs: string }[]> {
    const s = loadState();
    if (!isConnected() || s.available === false) return [];
    const byId = nodeMap(s.nodes ?? []);
    const out: { id: string; name: string; abs: string }[] = [];
    for (const id of includedIds) {
      if (!ownsId(id)) continue;
      const node = byId.get(id);
      if (!node || node.kind !== "file") continue;
      const abs = mirrorPathFor(node);
      if (fs.existsSync(abs)) out.push({ id, name: node.name, abs });
    }
    return out;
  },
};
