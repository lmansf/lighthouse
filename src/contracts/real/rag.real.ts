/** Real RagService — talks to the local `/api/rag` route (filesystem-backed). */
import type { RagService } from "../services";
import type {
  ChangedPin,
  DataSource,
  FileNode,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  RagReference,
  RestoreToken,
} from "../types";

async function getTree(): Promise<{ sources: DataSource[]; nodes: FileNode[]; desktop: boolean }> {
  const r = await fetch("/api/rag", { cache: "no-store" });
  if (!r.ok) throw new Error(`GET /api/rag ${r.status}`);
  return r.json();
}

async function post(body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch("/api/rag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST /api/rag ${r.status}`);
  return r.json();
}

class RealRagService implements RagService {
  async listSources(): Promise<DataSource[]> {
    return (await getTree()).sources;
  }

  async listNodes(parentId?: string | null): Promise<FileNode[]> {
    const { nodes } = await getTree();
    if (parentId === undefined) return nodes;
    return nodes.filter((n) => n.parentId === parentId);
  }

  async setIncluded(nodeId: string, included: boolean): Promise<void> {
    await post({ op: "include", nodeId, included });
  }

  async setSourceAvailable(sourceId: string, available: boolean): Promise<void> {
    // sourceId MUST ride along: the route routes the toggle by it, defaulting
    // to the local vault when absent — dropping it toggled the wrong source
    // (e.g. hid the local vault when the user disabled a cloud source).
    await post({ op: "source", sourceId, available });
  }

  async search(query: string, includedFileIds: string[]): Promise<RagReference[]> {
    const res = await post({ op: "search", query, includedFileIds });
    return (res.references as RagReference[]) ?? [];
  }

  async analyticsSql(
    sql: string,
    fileIds: string[],
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
    return (await post({
      op: "analyticsSql",
      sql,
      fileIds,
      ...(saveAs ? { saveAs } : {}),
    })) as {
      markdown?: string;
      chart?: string | null;
      footer?: string;
      error?: string;
      savedId?: string;
      savedName?: string;
      rows?: number;
    };
  }

  async exportChat(
    title: string,
    markdown: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return (await post({ op: "exportChat", title, markdown })) as {
      savedId?: string;
      savedName?: string;
      error?: string;
    };
  }

  async pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
  ): Promise<{ pin?: Pin; error?: string }> {
    return (await post({ op: "pinAsk", question, sql, fileIds })) as {
      pin?: Pin;
      error?: string;
    };
  }

  async unpinAsk(id: string): Promise<void> {
    await post({ op: "unpinAsk", id });
  }

  async listPins(): Promise<Pin[]> {
    const res = await post({ op: "listPins" });
    return Array.isArray(res.pins) ? (res.pins as Pin[]) : [];
  }

  async recheckPins(): Promise<{ changed: ChangedPin[]; pins: Pin[] }> {
    const res = await post({ op: "recheckPins" });
    return {
      changed: Array.isArray(res.changed) ? (res.changed as ChangedPin[]) : [],
      pins: Array.isArray(res.pins) ? (res.pins as Pin[]) : [],
    };
  }

  async suggestedAsks(includedFileIds: string[]): Promise<{ label: string; question: string }[]> {
    const res = await post({ op: "suggestedAsks", includedFileIds });
    return Array.isArray(res.asks) ? (res.asks as { label: string; question: string }[]) : [];
  }

  async addReference(path: string): Promise<{ id: string; kind: "file" | "folder" }> {
    const res = await post({ op: "addReference", path });
    return res as { id: string; kind: "file" | "folder" };
  }

  async removeReference(refId: string): Promise<void> {
    await post({ op: "removeReference", refId });
  }

  async moveNode(fromId: string, toParentId: string | null): Promise<{ newId: string }> {
    const res = await post({ op: "move", from: fromId, toParentId });
    return res as { newId: string };
  }

  async renameNode(id: string, newName: string): Promise<{ newId: string }> {
    const res = await post({ op: "rename", id, name: newName });
    return res as { newId: string };
  }

  async createFolder(parentId: string | null, name: string): Promise<{ newId: string }> {
    const res = await post({ op: "newFolder", parentId, name });
    return res as { newId: string };
  }

  async removeFromVault(nodeId: string): Promise<RestoreToken> {
    const res = await post({ op: "remove", nodeId });
    return (res.restore ?? {}) as RestoreToken;
  }

  async restoreFromVault(token: RestoreToken): Promise<void> {
    await post({ op: "restore", token });
  }

  async capabilities(): Promise<{ desktop: boolean }> {
    return { desktop: (await getTree()).desktop };
  }

  async policy(): Promise<PolicySnapshot> {
    return (await post({ op: "policy" })) as unknown as PolicySnapshot;
  }

  async egress(): Promise<EgressSnapshot> {
    return (await post({ op: "egress" })) as unknown as EgressSnapshot;
  }
}

export const ragService: RagService = new RealRagService();
