/** Real RagService — talks to the local `/api/rag` route (filesystem-backed). */
import type { PlatformKind, RagService, ReportTemplate } from "../services";
// Relative (not "@/") so the node test loader can resolve this file — the
// contracts barrel is imported by engine-level suites without webpack aliases.
import { rememberPlatform } from "../../shell/desktopBridge";
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
  InsightFinding,
  InsightsScan,
  Investigation,
  InvestigationCreateInput,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
  RagReference,
  RecipeCard,
  CapabilityMap,
  RestoreToken,
  SemanticCards,
  SemanticMetric,
  MetricCreateInput,
  DefineMetricResult,
  Synonym,
  ShapeProposal,
  ShapeViewResult,
  View,
  ViewCreateInput,
  ViewInspection,
  SigninPoll,
  SigninStart,
  SigninStatus,
} from "../types";

async function getTree(): Promise<{
  sources: DataSource[];
  nodes: FileNode[];
  desktop: boolean;
  platform?: PlatformKind;
}> {
  const r = await fetch("/api/rag", { cache: "no-store" });
  if (!r.ok) throw new Error(`GET /api/rag ${r.status}`);
  const t = await r.json();
  // Prime the ambient platform helper (§1) from the earliest payload every
  // window fetches; absent field (older engine) ⇒ helper stays "desktop".
  rememberPlatform(t.platform);
  return t;
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

  async applicableRecipes(includedFileIds: string[]): Promise<RecipeCard[]> {
    const res = await post({ op: "applicableRecipes", includedFileIds });
    return Array.isArray(res.recipes) ? (res.recipes as RecipeCard[]) : [];
  }

  async insights(): Promise<InsightsScan> {
    // No args — the engine scans its own catalog (bounded by a hard cap). The
    // wire returns `{ insights: { findings, tablesScanned, tablesAvailable } }`;
    // PARITY: the dev twin answers an empty scan (analytics is Rust-only), so
    // the panel shows the honest "nothing stands out" empty state under dev.
    const res = await post({ op: "insights" });
    const scan = res.insights as Partial<InsightsScan> | undefined;
    return {
      findings: Array.isArray(scan?.findings) ? (scan.findings as InsightFinding[]) : [],
      tablesScanned: typeof scan?.tablesScanned === "number" ? scan.tablesScanned : 0,
      tablesAvailable: typeof scan?.tablesAvailable === "number" ? scan.tablesAvailable : 0,
    };
  }

  async capabilityMap(includedFileIds: string[]): Promise<CapabilityMap> {
    // The wire returns `{ map: CapabilityMap }`; PARITY: the dev twin answers an
    // empty map (analytics is Rust-only), so the panel shows the honest empty
    // state under dev. Every field defaults to [] so a partial wire never throws.
    const res = await post({ op: "capabilityMap", includedFileIds });
    const map = res.map as Partial<CapabilityMap> | undefined;
    return {
      tables: Array.isArray(map?.tables) ? map.tables : [],
      recipes: Array.isArray(map?.recipes) ? map.recipes : [],
      metrics: Array.isArray(map?.metrics) ? map.metrics : [],
      suggestedAsks: Array.isArray(map?.suggestedAsks) ? map.suggestedAsks : [],
      suggestedInvestigations: Array.isArray(map?.suggestedInvestigations)
        ? map.suggestedInvestigations
        : [],
    };
  }

  async investigate(
    table: string,
    investigationId?: string,
    template?: ReportTemplate,
  ): Promise<{ savedId: string; savedName: string }> {
    // Runs the recipe battery + writes the report note in the Rust engine.
    // PARITY: the dev twin answers `{available:false}` (analytics is Rust-only);
    // a write failure rides back as `{error}`. Either surfaces as an honest throw
    // so the caller shows the error, never a fake saved note. `template` prescribes
    // a structured shape (add-report-templates); omitted ⇒ the Standard report.
    const res = await post({ op: "investigate", table, investigationId, template });
    if (res.available === false || res.error || !res.savedId) {
      throw new Error(
        (res.reason as string) ||
          (res.error as string) ||
          "deep analysis is unavailable on this engine",
      );
    }
    return { savedId: res.savedId as string, savedName: (res.savedName as string) ?? "" };
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

  async capabilities(): Promise<{ desktop: boolean; platform: PlatformKind }> {
    const t = await getTree();
    return { desktop: t.desktop, platform: t.platform ?? "desktop" };
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

  async forkInvestigation(
    id: string,
    name: string,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    return this.investigationsOp({ action: "fork", id, name });
  }

  async exportInvestigation(
    id: string,
    title?: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    // The export op returns {savedId, savedName} or {error} (400 on a bad id /
    // unusable folder, 200 {error} on a write failure — like exportChat); read
    // the body regardless of status so the reason surfaces inline.
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "investigations",
        action: "export",
        id,
        ...(title ? { title } : {}),
      }),
    });
    const data = (await r.json().catch(() => ({}))) as {
      savedId?: string;
      savedName?: string;
      error?: string;
    };
    if (!r.ok) return { error: data.error ?? `POST /api/rag ${r.status}` };
    return data;
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

  /**
   * Views sub-ops (openspec: add-shaped-views) return refusals as 400 +
   * {error}; unlike boards, the service surface THROWS the engine's reason
   * (the dialogs catch and show it verbatim — the engine owns the rules).
   */
  private async viewsOp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "views", ...body }),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      throw new Error(
        typeof data.error === "string" && data.error ? data.error : `POST /api/rag ${r.status}`,
      );
    }
    return data;
  }

  async listViews(): Promise<View[]> {
    const res = await this.viewsOp({ action: "list" });
    return Array.isArray(res.views) ? (res.views as View[]) : [];
  }

  async createView(input: ViewCreateInput): Promise<View> {
    // The summary rides FLATTENED on the wire; the engine builds the labeled
    // record and owns every validation rule.
    const res = await this.viewsOp({
      action: "create",
      name: input.name,
      sql: input.sql,
      summaryText: input.summaryText,
      summarySource: input.summarySource,
      fileIds: input.fileIds,
    });
    return res.view as View;
  }

  async renameView(id: string, name: string): Promise<View> {
    const res = await this.viewsOp({ action: "rename", id, name });
    return res.view as View;
  }

  async deleteView(id: string, cascade?: boolean): Promise<string[]> {
    // `cascade` rides only when true — the privacy-shaped absent-means-no
    // default every other optional wire flag uses.
    const res = await this.viewsOp({ action: "delete", id, ...(cascade ? { cascade: true } : {}) });
    return Array.isArray(res.deletedIds) ? (res.deletedIds as string[]) : [];
  }

  async viewDependents(id: string): Promise<{ dependents: string[]; transitive: string[] }> {
    const res = await this.viewsOp({ action: "dependents", id });
    return {
      dependents: Array.isArray(res.dependents) ? (res.dependents as string[]) : [],
      transitive: Array.isArray(res.transitive) ? (res.transitive as string[]) : [],
    };
  }

  async inspectView(id: string): Promise<ViewInspection> {
    // Stored-state read: the engine returns `{inspection}`; an unknown id
    // yields `{}` (the FileInspection precedent). The twin computes the
    // identical shape from the stored record (no execution — PARITY).
    const res = await this.viewsOp({ action: "inspect", id });
    return (res.inspection ?? {}) as ViewInspection;
  }

  async shapeView(
    source: string,
    instruction: string,
    fileIds: string[],
  ): Promise<ShapeViewResult> {
    // Refusals (unknown source, guard rejection, the model's own refusal)
    // come back 400 + {error} and THROW so the dialog shows the reason;
    // {available:false} is a normal answer (extractive provider / dev twin).
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "shapeView", source, instruction, fileIds }),
    });
    const data = (await r.json().catch(() => ({}))) as {
      proposal?: ShapeProposal;
      available?: boolean;
      reason?: string;
      error?: string;
    };
    if (!r.ok) {
      throw new Error(data.error ?? `POST /api/rag ${r.status}`);
    }
    if (data.available === false) {
      return {
        available: false,
        reason:
          typeof data.reason === "string" && data.reason ? data.reason : "shaping is unavailable",
      };
    }
    const p = data.proposal;
    return {
      available: true,
      sql: typeof p?.sql === "string" ? p.sql : "",
      before: typeof p?.before === "string" ? p.before : "",
      after: typeof p?.after === "string" ? p.after : "",
      summary: typeof p?.summary === "string" ? p.summary : "",
    };
  }

  /**
   * Semantic-layer sub-ops (openspec: add-semantic-layer §6). Like viewsOp, the
   * create/rename/delete surface THROWS the engine's reason (the dialogs catch
   * and show it verbatim — the engine owns the rules).
   */
  private async semanticOp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "semantic", ...body }),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      throw new Error(
        typeof data.error === "string" && data.error ? data.error : `POST /api/rag ${r.status}`,
      );
    }
    return data;
  }

  async applicableSemantics(includedFileIds: string[]): Promise<SemanticCards> {
    const res = await this.semanticOp({ action: "list", includedFileIds });
    const cards = res.semantic as Partial<SemanticCards> | undefined;
    return {
      metrics: Array.isArray(cards?.metrics) ? cards.metrics : [],
      synonyms: Array.isArray(cards?.synonyms) ? cards.synonyms : [],
      // §3.4 auto-derived proposals — present from the Rust engine, empty from
      // the dev twin (catalog + SQL mining are Rust-only).
      suggestedSynonyms: Array.isArray(cards?.suggestedSynonyms) ? cards.suggestedSynonyms : [],
      suggestedMetrics: Array.isArray(cards?.suggestedMetrics) ? cards.suggestedMetrics : [],
    };
  }

  async createMetric(input: MetricCreateInput): Promise<SemanticMetric> {
    // The summary rides FLATTENED on the wire; the engine builds the labeled
    // record and owns every validation rule.
    const res = await this.semanticOp({
      action: "create-metric",
      name: input.name,
      expression: input.expression,
      description: input.description,
      entity: input.entity,
      summaryText: input.summaryText,
      summarySource: input.summarySource,
      fileIds: input.fileIds,
    });
    return res.metric as SemanticMetric;
  }

  async createSynonym(term: string, canonical: string): Promise<Synonym> {
    const res = await this.semanticOp({ action: "create-synonym", term, canonical });
    return res.synonym as Synonym;
  }

  async renameMetric(id: string, name: string): Promise<SemanticMetric> {
    const res = await this.semanticOp({ action: "rename", id, name });
    return res.metric as SemanticMetric;
  }

  async deleteMetric(id: string, cascade?: boolean): Promise<string> {
    // `cascade` rides only when true (the privacy-shaped absent-means-no default).
    const res = await this.semanticOp({ action: "delete", id, ...(cascade ? { cascade: true } : {}) });
    return typeof res.deletedId === "string" ? res.deletedId : "";
  }

  async deleteSynonym(term: string): Promise<void> {
    await this.semanticOp({ action: "delete", term });
  }

  async defineMetric(sql: string, fileIds: string[]): Promise<DefineMetricResult> {
    // {available:false} is a normal answer (no aggregate to define / dev twin);
    // a real refusal would ride back as 400 + {error}, so surface that too.
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "defineMetric", sql, fileIds }),
    });
    const data = (await r.json().catch(() => ({}))) as {
      available?: boolean;
      expression?: string;
      entity?: string;
      reason?: string;
      error?: string;
    };
    if (!r.ok) {
      throw new Error(data.error ?? `POST /api/rag ${r.status}`);
    }
    if (data.available === true && typeof data.expression === "string" && typeof data.entity === "string") {
      return { available: true, expression: data.expression, entity: data.entity };
    }
    return {
      available: false,
      reason:
        typeof data.reason === "string" && data.reason
          ? data.reason
          : "no metric could be defined from this answer",
    };
  }
  // Provider sign-in (0.12.1 §3): the generic, registration-gated device
  // flow. Every op answers 200 (fail-closed availability + flow errors ride
  // in the body — the pinAsk idiom), so these never throw on a stock build.

  async providerAuthStatus(): Promise<SigninStatus> {
    const res = await post({ op: "providerAuth", action: "status" });
    return {
      available: res.available === true,
      signedIn: res.signedIn === true,
      method: res.method === "signin" ? "signin" : "key",
      ...(typeof res.accountHint === "string" && res.accountHint
        ? { accountHint: res.accountHint }
        : {}),
      ...(typeof res.expiresMs === "number" ? { expiresMs: res.expiresMs } : {}),
      ...(typeof res.reason === "string" && res.reason ? { reason: res.reason } : {}),
    };
  }

  async providerAuthStart(): Promise<{ start?: SigninStart; error?: string }> {
    const res = await post({ op: "providerAuth", action: "start" });
    if (typeof res.userCode === "string" && res.userCode) {
      return {
        start: {
          userCode: res.userCode,
          verificationUri: typeof res.verificationUri === "string" ? res.verificationUri : "",
          intervalMs: typeof res.intervalMs === "number" ? res.intervalMs : 5000,
          ...(typeof res.expiresInMs === "number" ? { expiresInMs: res.expiresInMs } : {}),
        },
      };
    }
    const reason =
      typeof res.error === "string" && res.error
        ? res.error
        : typeof res.reason === "string" && res.reason
          ? res.reason
          : "sign-in is unavailable";
    return { error: reason };
  }

  async providerAuthPoll(): Promise<SigninPoll> {
    const res = await post({ op: "providerAuth", action: "poll" });
    if (typeof res.error === "string" && res.error) {
      return { status: "idle", error: res.error };
    }
    if (typeof res.reason === "string" && res.reason && res.available === false) {
      return { status: "idle", error: res.reason };
    }
    const status =
      res.status === "pending" || res.status === "complete" ? res.status : "idle";
    return {
      status,
      ...(typeof res.intervalMs === "number" ? { intervalMs: res.intervalMs } : {}),
      ...(typeof res.accountHint === "string" && res.accountHint
        ? { accountHint: res.accountHint }
        : {}),
    };
  }

  async providerAuthSignout(): Promise<void> {
    await post({ op: "providerAuth", action: "signout" });
  }

  async providerAuthSetMethod(
    method: "key" | "signin",
  ): Promise<{ ok?: boolean; error?: string }> {
    const res = await post({ op: "providerAuth", action: "setMethod", method });
    if (res.ok === true) return { ok: true };
    const reason =
      typeof res.reason === "string" && res.reason
        ? res.reason
        : typeof res.error === "string" && res.error
          ? res.error
          : "couldn't save the choice";
    return { error: reason };
  }
}

export const ragService: RagService = new RealRagService();
