/**
 * Source registry — the seam that lets the explorer and API stay source-agnostic.
 *
 * The local vault is always present and is the fallback owner for bare node ids.
 * Cloud connectors (SharePoint first) register here later, owning ids prefixed
 * `${sourceId}::`, and the registry routes each curation op to the owning source
 * and aggregates listings across all of them.
 */
import type { DataSource, FileNode } from "@/contracts";
import { retrieve as vaultRetrieve, type Retrieved } from "../vault";
import { localVault } from "./local";
import { sharepoint } from "./sharepoint";
import type { SourceConnector } from "./types";

// Local vault is kept LAST so it acts as the fallback owner (cloud connectors,
// which match by id prefix, are consulted first).
const connectors: SourceConnector[] = [sharepoint, localVault];

/** The connector that owns a node id — a cloud connector by id prefix, else local. */
function connectorFor(id: string): SourceConnector {
  for (const c of connectors) {
    if (c !== localVault && c.ownsId(id)) return c;
  }
  return localVault;
}

/** Connectors that should currently surface (a cloud source hides until connected). */
async function presentConnectors(): Promise<SourceConnector[]> {
  const flags = await Promise.all(
    connectors.map((c) => (c.isPresent ? c.isPresent() : Promise.resolve(true))),
  );
  return connectors.filter((_, i) => flags[i]);
}

export async function listSources(): Promise<DataSource[]> {
  const present = await presentConnectors();
  return Promise.all(present.map((c) => c.source()));
}

export async function listNodes(): Promise<FileNode[]> {
  const present = await presentConnectors();
  const trees = await Promise.all(present.map((c) => c.listNodes()));
  return trees.flat();
}

export async function setIncluded(nodeId: string, included: boolean): Promise<void> {
  await connectorFor(nodeId).setIncluded(nodeId, included);
}

export async function setSourceAvailable(
  available: boolean,
  sourceId: string = localVault.sourceId,
): Promise<void> {
  const c = connectors.find((x) => x.sourceId === sourceId) ?? localVault;
  await c.setAvailable(available);
}

export async function addReference(path: string): Promise<{ id: string; kind: "file" | "folder" }> {
  if (!localVault.addReference) throw new Error("references are unsupported for this source");
  return localVault.addReference(path);
}

export async function removeReference(refId: string): Promise<void> {
  const c = connectorFor(refId);
  if (!c.removeReference) throw new Error("references are unsupported for this source");
  await c.removeReference(refId);
}

export async function moveNode(
  fromId: string,
  toParentId: string | null,
): Promise<{ newId: string }> {
  const c = connectorFor(fromId);
  if (!c.moveNode) throw new Error("move is unsupported for this source");
  return c.moveNode(fromId, toParentId);
}

export async function removeFromVault(nodeId: string): Promise<void> {
  const c = connectorFor(nodeId);
  if (!c.remove) throw new Error("remove is unsupported for this source");
  await c.remove(nodeId);
}

/**
 * Retrieval across the included set. Today it delegates to the local vault's
 * engine; when a cloud connector lands, this is where each source's mirrored
 * text is gathered and ranked together (the ranking math is already source-
 * agnostic — it operates on { id, name, text }).
 */
export async function retrieve(
  query: string,
  includedFileIds: string[],
  attachmentIds: string[] = [],
  k = 5,
): Promise<Retrieved> {
  // When the question is scoped to explicit attachments, retrieve only from those
  // vault files and skip cloud mirroring (attachments are vault files here).
  // Otherwise gather mirrored content from any cloud connector for its enabled
  // files and rank it together with vault files in the source-agnostic engine.
  const external = attachmentIds.length
    ? []
    : (
        await Promise.all(
          connectors.filter((c) => c.retrievalItems).map((c) => c.retrievalItems!(includedFileIds)),
        )
      ).flat();
  return vaultRetrieve(query, includedFileIds, k, external, attachmentIds);
}
