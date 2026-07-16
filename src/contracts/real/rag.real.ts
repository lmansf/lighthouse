/** Real RagService — talks to the local `/api/rag` route (filesystem-backed). */
import type { RagService } from "../services";
import type {
  Board,
  BoardCardRef,
  BoardCardRefresh,
  Briefing,
  BriefingReport,
  Cadence,
  ChangedPin,
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
  Investigation,
  InvestigationCreateInput,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
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

  async setLocalOnly(nodeId: string, localOnly: boolean): Promise<void> {
    await post({ op: "localOnly", nodeId, localOnly });
  }

  async listRules(): Promise<CurationRule[]> {
    const res = await post({ op: "rules", action: "list" });
    return Array.isArray(res.rules) ? (res.rules as CurationRule[]) : [];
  }

  async addRule(rule: CurationRuleInput): Promise<{ rule?: CurationRule; error?: string }> {
    // Add-time validation failures come back as 400 + {error}; read the body
    // instead of throwing so the create form can show the engine's reason.
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "rules", action: "add", rule }),
    });
    const data = (await r.json().catch(() => ({}))) as { rule?: CurationRule; error?: string };
    if (!r.ok) return { error: data.error ?? `POST /api/rag ${r.status}` };
    return data;
  }

  async removeRule(id: string): Promise<void> {
    await post({ op: "rules", action: "remove", id });
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

  async inspect(fileId: string, query?: string): Promise<FileInspection> {
    return (await post({
      op: "inspect",
      fileId,
      ...(query ? { query } : {}),
    })) as unknown as FileInspection;
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
    options?: {
      subdir?: "Lighthouse Notes" | "Lighthouse Results";
      ext?: "md" | "html";
      investigationId?: string;
    },
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    // Absent fields keep the original markdown-note wire shape byte-for-byte;
    // the evidence pack adds subdir/ext (engine-side strict allowlist), and an
    // investigation ask adds investigationId — the engine resolves the notes
    // folder from its store (openspec: add-investigations).
    return (await post({
      op: "exportChat",
      title,
      markdown,
      ...(options?.subdir ? { subdir: options.subdir } : {}),
      ...(options?.ext ? { ext: options.ext } : {}),
      ...(options?.investigationId ? { investigationId: options.investigationId } : {}),
    })) as {
      savedId?: string;
      savedName?: string;
      error?: string;
    };
  }

  async exportConversationNote(
    conversationId: string,
    title: string,
    markdown: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return (await post({
      op: "exportConversationNote",
      conversationId,
      title,
      markdown,
    })) as { savedId?: string; savedName?: string; error?: string };
  }

  async purgeConversationNotes(): Promise<{ ok?: boolean; error?: string }> {
    return (await post({ op: "purgeConversationNotes" })) as {
      ok?: boolean;
      error?: string;
    };
  }

  async pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
    investigationId?: string,
  ): Promise<{ pin?: Pin; error?: string }> {
    // Absent investigationId keeps the original wire shape byte-for-byte —
    // a global-context pin stays uncategorized (openspec: add-investigations).
    return (await post({
      op: "pinAsk",
      question,
      sql,
      fileIds,
      ...(investigationId ? { investigationId } : {}),
    })) as {
      pin?: Pin;
      error?: string;
    };
  }

  async unpinAsk(id: string): Promise<void> {
    await post({ op: "unpinAsk", id });
  }

  async listPins(investigationId?: string): Promise<Pin[]> {
    const res = await post({
      op: "listPins",
      ...(investigationId ? { investigationId } : {}),
    });
    return Array.isArray(res.pins) ? (res.pins as Pin[]) : [];
  }

  async recheckPins(): Promise<{ changed: ChangedPin[]; pins: Pin[] }> {
    const res = await post({ op: "recheckPins" });
    return {
      changed: Array.isArray(res.changed) ? (res.changed as ChangedPin[]) : [],
      pins: Array.isArray(res.pins) ? (res.pins as Pin[]) : [],
    };
  }

  async listBriefings(): Promise<Briefing[]> {
    const res = await post({ op: "listBriefings" });
    return Array.isArray(res.briefings) ? (res.briefings as Briefing[]) : [];
  }

  async saveBriefing(
    title: string,
    pinIds: string[],
    cadence: Cadence,
  ): Promise<{ briefing?: Briefing; error?: string }> {
    return (await post({ op: "saveBriefing", title, pinIds, cadence })) as {
      briefing?: Briefing;
      error?: string;
    };
  }

  async removeBriefing(id: string): Promise<void> {
    await post({ op: "removeBriefing", id });
  }

  async runBriefing(id: string): Promise<BriefingReport | undefined> {
    const res = await post({ op: "runBriefing", id });
    return (res.report as BriefingReport | undefined) ?? undefined;
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

  async audit(limit?: number): Promise<AuditSnapshot> {
    return (await post({ op: "auditList", limit })) as unknown as AuditSnapshot;
  }

  async auditVerify(): Promise<AuditVerdict> {
    return (await post({ op: "auditVerify" })) as unknown as AuditVerdict;
  }

  async auditExport(): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return (await post({ op: "auditExport" })) as unknown as {
      savedId?: string;
      savedName?: string;
      error?: string;
    };
  }

  async refreshBriefingNote(): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return (await post({ op: "refreshBriefingNote" })) as unknown as {
      savedId?: string;
      savedName?: string;
      error?: string;
    };
  }

  /**
   * Mutating investigations sub-ops return validation failures as 400 +
   * {error} (like addRule); read the body instead of throwing so the UI can
   * surface the engine's reason inline.
   */
  private async investigationsOp(
    body: Record<string, unknown>,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "investigations", ...body }),
    });
    const data = (await r.json().catch(() => ({}))) as {
      investigation?: Investigation;
      error?: string;
    };
    if (!r.ok) return { error: data.error ?? `POST /api/rag ${r.status}` };
    return data;
  }

  async listInvestigations(): Promise<Investigation[]> {
    const res = await post({ op: "investigations", action: "list" });
    return Array.isArray(res.investigations) ? (res.investigations as Investigation[]) : [];
  }

  async createInvestigation(
    input: InvestigationCreateInput,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    return this.investigationsOp({
      action: "create",
      name: input.name,
      scopeFileIds: input.scopeFileIds ?? [],
      providerPolicy: input.providerPolicy ?? "default",
    });
  }

  async renameInvestigation(
    id: string,
    name: string,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    return this.investigationsOp({ action: "rename", id, name });
  }

  async setInvestigationArchived(
    id: string,
    archived: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    return this.investigationsOp({ action: "setArchived", id, archived });
  }

  async addInvestigationConversationRef(
    id: string,
    conversationId: string,
    persistAllowed: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    return this.investigationsOp({
      action: "addConversationRef",
      id,
      conversationId,
      persistAllowed,
    });
  }

  /**
   * Mutating boards sub-ops (openspec: add-boards) return validation
   * failures as 400 + {error} (like investigations); read the body instead
   * of throwing so the UI can surface the engine's reason inline.
   */
  private async boardsOp(
    body: Record<string, unknown>,
  ): Promise<{ board?: Board; ok?: boolean; error?: string }> {
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "boards", ...body }),
    });
    const data = (await r.json().catch(() => ({}))) as {
      board?: Board;
      ok?: boolean;
      error?: string;
    };
    if (!r.ok) return { error: data.error ?? `POST /api/rag ${r.status}` };
    return data;
  }

  async listBoards(investigationId?: string): Promise<Board[]> {
    const res = await post({
      op: "boards",
      action: "list",
      ...(investigationId ? { investigationId } : {}),
    });
    return Array.isArray(res.boards) ? (res.boards as Board[]) : [];
  }

  async createBoard(
    name: string,
    investigationId?: string,
  ): Promise<{ board?: Board; error?: string }> {
    return this.boardsOp({
      action: "create",
      name,
      ...(investigationId ? { investigationId } : {}),
    });
  }

  async renameBoard(id: string, name: string): Promise<{ board?: Board; error?: string }> {
    return this.boardsOp({ action: "rename", id, name });
  }

  async deleteBoard(id: string): Promise<{ ok?: boolean; error?: string }> {
    return this.boardsOp({ action: "delete", id });
  }

  async setBoardCards(
    id: string,
    cards: BoardCardRef[],
  ): Promise<{ board?: Board; error?: string }> {
    return this.boardsOp({ action: "setCards", id, cards });
  }

  async refreshBoardCards(pinIds: string[]): Promise<BoardCardRefresh[]> {
    const res = await post({ op: "boards", action: "refreshCards", pinIds });
    return Array.isArray(res.cards) ? (res.cards as BoardCardRefresh[]) : [];
  }
}

export const ragService: RagService = new RealRagService();
