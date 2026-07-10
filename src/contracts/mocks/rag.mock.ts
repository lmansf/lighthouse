import type { RagService } from "../services";
import type {
  ChangedPin,
  DataSource,
  FileNode,
  Pin,
  RagReference,
  RestoreToken,
} from "../types";
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

  async analyticsSql(
    sql: string,
    _fileIds: string[],
    saveAs?: string,
  ): Promise<{
    markdown?: string;
    chart?: string | null;
    footer?: string;
    error?: string;
    savedId?: string;
    savedName?: string;
    rows?: number;
  }> {
    // Deterministic mock: SELECTs "succeed" with a canned table so the Edit
    // SQL dialog is fully exercisable offline; anything else is rejected the
    // way the real guard would phrase it.
    await new Promise((r) => setTimeout(r, 200));
    if (!/^\s*(select|with)\b/i.test(sql)) {
      return { error: "only SELECT queries are allowed" };
    }
    return {
      markdown: "| region | total |\n| --- | --- |\n| NE | 150 |\n| NW | 200 |",
      chart: null,
      footer: `*Query used:*\n\`\`\`sql\n${sql}\n\`\`\`\n*Computed from:* “sales.csv” (saved just now)`,
      // Pretend save so the Save-as-CSV chip round-trips offline.
      ...(saveAs ? { savedId: `Lighthouse Results/${saveAs}.csv`, savedName: `${saveAs}.csv`, rows: 2 } : {}),
    };
  }

  async exportChat(
    title: string,
    markdown: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    await new Promise((r) => setTimeout(r, 150));
    if (!markdown.trim()) return { error: "markdown required" };
    const name = `${title.trim() || "Chat"}.md`;
    return { savedId: `Lighthouse Notes/${name}`, savedName: name };
  }

  // In-memory pins so the pin chip, dialog, and banner are exercisable
  // offline. The mock "primes" a canned summary; rechecks report no changes.
  private pins: Pin[] = [];

  async pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
  ): Promise<{ pin?: Pin; error?: string }> {
    if (!question.trim() || !sql.trim()) return { error: "a pin needs the question and its SQL" };
    const id = `pin-${sql.length}-${sql.slice(0, 8).replace(/\W/g, "")}`;
    this.pins = this.pins.filter((p) => p.id !== id);
    if (this.pins.length >= 20) return { error: "pin limit reached (20) — remove one in the pins dialog first" };
    const pin: Pin = {
      id,
      question: question.trim(),
      sql: sql.trim(),
      fileIds,
      createdMs: Date.now(),
      lastRunMs: Date.now(),
      lastSummary: "NE 150 · NW 200",
    };
    this.pins.push(pin);
    return { pin: { ...pin } };
  }

  async unpinAsk(id: string): Promise<void> {
    this.pins = this.pins.filter((p) => p.id !== id);
  }

  async listPins(): Promise<Pin[]> {
    return this.pins.map((p) => ({ ...p }));
  }

  async recheckPins(): Promise<{ changed: ChangedPin[]; pins: Pin[] }> {
    const now = Date.now();
    this.pins = this.pins.map((p) => ({ ...p, lastRunMs: now }));
    return { changed: [], pins: this.pins.map((p) => ({ ...p })) };
  }

  async suggestedAsks(includedFileIds: string[]): Promise<{ label: string; question: string }[]> {
    // The mock has no column catalog; surface canned asks for the first
    // included tabular file so the empty-state chips are exercisable offline.
    const included = new Set(includedFileIds);
    const sheet = this.nodes.find(
      (n) => n.kind === "file" && included.has(n.id) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
    );
    if (!sheet) return [];
    return [
      { label: "Total amount by region", question: `Total amount by region in ${sheet.name}` },
      { label: "Monthly trend of amount", question: `Monthly trend of amount in ${sheet.name}` },
    ];
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

  async renameNode(id: string, newName: string): Promise<{ newId: string }> {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error("source not found");
    const slash = id.lastIndexOf("/");
    const newId = slash >= 0 ? `${id.slice(0, slash)}/${newName}` : newName;
    if (newId !== id && this.nodes.some((n) => n.id === newId)) {
      throw new Error("destination already exists");
    }
    // Remap every node's id + parentId onto the new prefix so descendants follow.
    const remap = (x: string) =>
      x === id ? newId : x.startsWith(`${id}/`) ? newId + x.slice(id.length) : x;
    this.nodes = this.nodes.map((n) => ({
      ...n,
      id: remap(n.id),
      parentId: n.parentId === null ? null : remap(n.parentId),
      name: n.id === id ? newName : n.name,
    }));
    return { newId };
  }

  async createFolder(parentId: string | null, name: string): Promise<{ newId: string }> {
    const newId = parentId ? `${parentId}/${name}` : name;
    if (this.nodes.some((n) => n.id === newId)) throw new Error("already exists");
    const sourceId = parentId
      ? this.nodes.find((n) => n.id === parentId)?.sourceId ?? "vault"
      : this.sources[0]?.id ?? "vault";
    this.nodes.push({ id: newId, parentId, sourceId, name, kind: "folder", ragIncluded: false });
    return { newId };
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
