import type { RagService } from "../services";
import type { DataSource, FileNode, RagReference, RestoreToken } from "../types";
import { SEED_NODES, SEED_SOURCES } from "./files";

/**
 * In-memory RagService. Holds the seed tree, applies hierarchical include/
 * exclude, and "retrieves" references by naive keyword overlap against the
 * included set. A real implementation swaps the storage + search internals
 * while keeping this exact surface.
 */
class MockRagService implements RagService {
  private sources: DataSource[] = SEED_SOURCES.map((s) => ({ ...s }));
  private nodes: FileNode[] = SEED_NODES.map((n) => ({ ...n }));

  async listSources(): Promise<DataSource[]> {
    return this.sources.map((s) => ({ ...s }));
  }

  async listNodes(parentId?: string | null): Promise<FileNode[]> {
    if (parentId === undefined) return this.nodes.map((n) => ({ ...n }));
    return this.nodes.filter((n) => n.parentId === parentId).map((n) => ({ ...n }));
  }

  async setIncluded(nodeId: string, included: boolean): Promise<void> {
    const ids = this.descendantIds(nodeId);
    this.nodes = this.nodes.map((n) =>
      ids.has(n.id) ? { ...n, ragIncluded: included } : n,
    );
  }

  async setSourceAvailable(sourceId: string, available: boolean): Promise<void> {
    this.sources = this.sources.map((s) =>
      s.id === sourceId ? { ...s, available } : s,
    );
    if (!available) {
      this.nodes = this.nodes.map((n) =>
        n.sourceId === sourceId ? { ...n, ragIncluded: false } : n,
      );
    }
  }

  async search(query: string, includedFileIds: string[]): Promise<RagReference[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const included = new Set(includedFileIds);
    return this.nodes
      .filter((n) => n.kind === "file" && included.has(n.id))
      .map((n) => {
        const haystack = n.name.toLowerCase();
        const overlap = terms.filter((t) => haystack.includes(t)).length;
        const score = Math.min(1, 0.4 + overlap * 0.2);
        return {
          fileId: n.id,
          name: n.name,
          snippet: `…relevant passage from ${n.name}…`,
          score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }

  async addReference(path: string): Promise<{ id: string; kind: "file" | "folder" }> {
    // The mock has no filesystem; surface a referenced node so the surface is
    // exercised. A real implementation links the true path on disk.
    const id = `ext-${this.nodes.length}`;
    const name = path.split(/[/\\]/).pop() || path;
    this.nodes.push({
      id, parentId: null, sourceId: this.sources[0]?.id ?? "vault",
      name, kind: "file", ragIncluded: false, external: true,
    });
    return { id, kind: "file" };
  }

  async removeReference(refId: string): Promise<void> {
    this.nodes = this.nodes.filter((n) => n.id !== refId && !n.id.startsWith(`${refId}/`));
  }

  async moveNode(fromId: string, toParentId: string | null): Promise<{ newId: string }> {
    const node = this.nodes.find((n) => n.id === fromId);
    if (!node) throw new Error("source not found");
    if (toParentId !== null) {
      // A folder can't be moved into itself or one of its own descendants.
      if (this.descendantIds(fromId).has(toParentId)) {
        throw new Error("cannot move a folder into itself");
      }
      const parent = this.nodes.find((n) => n.id === toParentId);
      if (!parent || parent.kind === "file") throw new Error("destination is not a folder");
    }
    // The mock keeps arbitrary (non-path) ids, so a reparent is just a
    // parent/source swap — descendants reference this node by id, unchanged, so
    // the whole subtree follows. The real engine rewrites path-derived ids.
    const sourceId =
      toParentId === null
        ? node.sourceId
        : this.nodes.find((n) => n.id === toParentId)?.sourceId ?? node.sourceId;
    this.nodes = this.nodes.map((n) =>
      n.id === fromId ? { ...n, parentId: toParentId, sourceId } : n,
    );
    return { newId: fromId };
  }

  async removeFromVault(nodeId: string): Promise<RestoreToken> {
    const ids = this.descendantIds(nodeId);
    // Stash the removed nodes in the token so restore can re-insert them.
    const removed = this.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n }));
    this.nodes = this.nodes.filter((n) => !ids.has(n.id));
    return { kind: "mock", nodes: removed };
  }

  async restoreFromVault(token: RestoreToken): Promise<void> {
    const nodes = (token as { nodes?: FileNode[] }).nodes ?? [];
    const have = new Set(this.nodes.map((n) => n.id));
    this.nodes.push(...nodes.filter((n) => !have.has(n.id)).map((n) => ({ ...n })));
  }

  async capabilities(): Promise<{ desktop: boolean }> {
    return { desktop: false };
  }

  /** A node plus all of its descendants (so toggling a folder cascades). */
  private descendantIds(rootId: string): Set<string> {
    const out = new Set<string>([rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const n of this.nodes) {
        if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
          out.add(n.id);
          added = true;
        }
      }
    }
    return out;
  }
}

export const ragService: RagService = new MockRagService();
