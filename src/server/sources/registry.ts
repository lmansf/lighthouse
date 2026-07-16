/**
 * Source registry — the seam that lets the explorer and API stay source-agnostic.
 *
 * The local vault is always present and is the fallback owner for bare node ids.
 * Cloud connectors (SharePoint first) register here later, owning ids prefixed
 * `${sourceId}::`, and the registry routes each curation op to the owning source
 * and aggregates listings across all of them.
 */
import type { DataSource, FileInspection, FileNode } from "@/contracts";
import {
  addRule as vaultAddRule,
  enrichRule as vaultEnrichRule,
  removeRule as vaultRemoveRule,
  retrieve as vaultRetrieve,
  restoreFromVault as vaultRestoreFromVault,
  rulesListing as vaultRulesListing,
  setLocalOnly as vaultSetLocalOnly,
  type Retrieved,
  type RestoreDescriptor,
  type RuleListing,
} from "../vault";
import { inspect as vaultInspect } from "../inspect";
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

/**
 * Mark/unmark a node "Private — this device only". Unlike inclusion, local-only
 * is a pure gate flag with no content-mirroring side effect, and its marks live
 * in the vault state keyed by node id for ANY source — so this routes straight
 * to the vault engine regardless of which source owns the id. KEEP IN SYNC with
 * lighthouse-core sources::set_local_only.
 */
export async function setLocalOnly(nodeId: string, value: boolean): Promise<void> {
  vaultSetLocalOnly(nodeId, value);
}

/**
 * Bulk curation rules (openspec: add-curation-rules). Like local-only marks,
 * rules live in the vault state and resolve by node id, so they route straight
 * to the vault engine regardless of the owning source. KEEP IN SYNC with
 * lighthouse-core sources::rules_listing / add_rule / remove_rule.
 */
export async function rulesListing(): Promise<RuleListing[]> {
  return vaultRulesListing();
}

/** Validate + add a rule (engine-minted id); returns the enriched rule. */
export async function addRule(input: {
  scope: string;
  kind?: string;
  ext?: string[];
  glob?: string;
  action: string;
}): Promise<RuleListing> {
  return vaultEnrichRule(vaultAddRule(input));
}

/** Remove a rule (idempotent). */
export async function removeRule(id: string): Promise<void> {
  vaultRemoveRule(id);
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

export async function renameNode(id: string, newName: string): Promise<{ newId: string }> {
  const c = connectorFor(id);
  if (!c.rename) throw new Error("rename is unsupported for this source");
  return c.rename(id, newName);
}

export async function createFolder(
  parentId: string | null,
  name: string,
): Promise<{ newId: string }> {
  // A null parent means the vault root; otherwise route to the owning source.
  const c = parentId ? connectorFor(parentId) : localVault;
  if (!c.createFolder) throw new Error("new folders are unsupported for this source");
  return c.createFolder(parentId, name);
}

export async function removeFromVault(nodeId: string): Promise<RestoreDescriptor> {
  const c = connectorFor(nodeId);
  if (!c.remove) throw new Error("remove is unsupported for this source");
  return c.remove(nodeId);
}

/** Undo a removeFromVault from its descriptor. Restore is a vault-only op — the
 *  token encodes what to reverse, so it routes straight to the vault engine. */
export async function restoreFromVault(
  desc: RestoreDescriptor,
): Promise<{ id?: string; ok?: boolean }> {
  return vaultRestoreFromVault(desc);
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
  isCloud = false,
  preferredConversationIds: string[] = [],
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
  // `isCloud` narrows the candidate + external sets to the shareable ones inside
  // vaultRetrieve, so a marked file's content never reaches the vendor.
  // `preferredConversationIds` rides through to the recall preference
  // (openspec: add-investigations); empty = no preference.
  return vaultRetrieve(
    query,
    includedFileIds,
    k,
    external,
    attachmentIds,
    isCloud,
    preferredConversationIds,
  );
}

/**
 * Read-only per-file inspection ("What the AI sees", openspec:
 * add-file-inspector). Like local-only marks it is keyed by node id and served
 * by the vault/inspect engine regardless of the owning source. KEEP IN SYNC
 * with lighthouse-core sources::inspect.
 */
export async function inspect(fileId: string, query?: string): Promise<FileInspection> {
  return vaultInspect(fileId, query);
}
