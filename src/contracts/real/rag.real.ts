/** Real RagService — talks to the local `/api/rag` route (filesystem-backed). */
import type { RagService } from "../services";
import type { DataSource, FileNode, RagReference } from "../types";

async function getTree(): Promise<{ sources: DataSource[]; nodes: FileNode[] }> {
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

  async setSourceAvailable(_sourceId: string, available: boolean): Promise<void> {
    await post({ op: "source", available });
  }

  async search(query: string, includedFileIds: string[]): Promise<RagReference[]> {
    const res = await post({ op: "search", query, includedFileIds });
    return (res.references as RagReference[]) ?? [];
  }
}

export const ragService: RagService = new RealRagService();
