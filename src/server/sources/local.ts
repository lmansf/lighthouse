/**
 * The local filesystem vault as a SourceConnector. A thin adapter over the
 * existing `vault.ts` engine — it's the default source and the fallback owner
 * for any node id not claimed by a cloud connector, so existing (un-prefixed)
 * node ids and inclusion state keep working unchanged.
 */
import { VAULT_SOURCE_ID } from "../config";
import {
  listSources as vaultListSources,
  listNodes as vaultListNodes,
  setIncluded as vaultSetIncluded,
  setSourceAvailable as vaultSetSourceAvailable,
  addReference as vaultAddReference,
  removeReference as vaultRemoveReference,
  removeFromVault as vaultRemoveFromVault,
  moveNode as vaultMoveNode,
} from "../vault";
import type { DataSource, FileNode } from "@/contracts";
import type { SourceConnector } from "./types";

export const localVault: SourceConnector = {
  sourceId: VAULT_SOURCE_ID,
  // Fallback owner: the registry consults cloud connectors first, then routes
  // anything left (the bare vault-relative ids) here.
  ownsId: () => true,
  async source(): Promise<DataSource> {
    return vaultListSources()[0];
  },
  async listNodes(): Promise<FileNode[]> {
    return vaultListNodes();
  },
  async setIncluded(nodeId, included) {
    vaultSetIncluded(nodeId, included);
  },
  async setAvailable(available) {
    vaultSetSourceAvailable(available);
  },
  async addReference(path) {
    return vaultAddReference(path);
  },
  async removeReference(refId) {
    vaultRemoveReference(refId);
  },
  async moveNode(fromId, toParentId) {
    return vaultMoveNode(fromId, toParentId);
  },
  async remove(nodeId) {
    return vaultRemoveFromVault(nodeId);
  },
};
