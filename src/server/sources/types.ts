/**
 * Source connectors.
 *
 * A "Source" is a top-level origin of documents behind the explorer. The local
 * filesystem vault is the first implementation; cloud connectors (SharePoint,
 * S3, Snowflake, …) implement the same surface — listing names-only placeholders
 * and mirroring an item's content into a local mirror dir only when it's enabled.
 *
 * Curation ops are async so a connector can reach the network. Each connector
 * owns a `sourceId`; cloud connectors namespace their node ids as
 * `${sourceId}::<path>` so the registry can route an op to the right source,
 * while the local vault keeps bare ids (and acts as the fallback owner).
 */
import type { DataSource, FileNode } from "@/contracts";
import type { RestoreDescriptor } from "../vault";

export interface SourceConnector {
  /** Stable id; also the `${sourceId}::…` prefix for this source's node ids. */
  readonly sourceId: string;
  /** Whether this connector owns / routes the given node id. */
  ownsId(id: string): boolean;
  /** This source as a DataSource (id, name, kind, availability). */
  source(): Promise<DataSource>;
  /** The source's node tree (names/structure only — placeholders, for cloud). */
  listNodes(): Promise<FileNode[]>;
  /** Include/exclude a node (and, for folders, its descendants). */
  setIncluded(nodeId: string, included: boolean): Promise<void>;
  /** Toggle whether the whole source is available to retrieval. */
  setAvailable(available: boolean): Promise<void>;

  // --- optional capabilities ---
  /**
   * Whether this source should currently appear at all. A cloud connector
   * returns false until the user has connected it, so it stays hidden (and out
   * of listings) rather than showing an empty placeholder. Absent ⇒ always present.
   */
  isPresent?(): Promise<boolean>;
  /**
   * For a cloud connector: the locally-mirrored content for whichever of
   * `includedIds` this source owns and has enabled, as `{ id, name, abs }` so
   * the registry can rank it alongside vault files. Absent ⇒ contributes none.
   */
  retrievalItems?(includedIds: string[]): Promise<{ id: string; name: string; abs: string }[]>;

  // --- optional, local-only capabilities ---
  /** Link a real path in place (desktop local vault only). */
  addReference?(path: string): Promise<{ id: string; kind: "file" | "folder" }>;
  /** Drop a reference (unlink); real files are left in place. */
  removeReference?(refId: string): Promise<void>;
  /** Move a node within the source, preserving inclusion. */
  moveNode?(fromId: string, toParentId: string | null): Promise<{ newId: string }>;
  /** Rename a node in place (same parent, new name), preserving inclusion. */
  rename?(id: string, newName: string): Promise<{ newId: string }>;
  /** Create an empty folder under a parent (or the source root, null). */
  createFolder?(parentId: string | null, name: string): Promise<{ newId: string }>;
  /** Remove a node from the source (non-destructive: linked items unlink, vault
   *  items move to a recoverable trash). Returns a descriptor that
   *  `restoreFromVault` can replay to undo the removal. */
  remove?(nodeId: string): Promise<RestoreDescriptor>;
}
