/** Real RagService — talks to the local `/api/rag` route (filesystem-backed). */
import type { PlatformKind, RagService, ReportSummary, ReportTemplate } from "../services";
import { ragTransport } from "./ragTransport";
// Relative (not "@/") so the node test loader can resolve this file — the
// contracts barrel is imported by engine-level suites without webpack aliases.
import { rememberPlatform } from "../../shell/desktopBridge";
import type {
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
  InsightFinding,
  InsightsScan,
  InvestigationCreateInput,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
  RagReference,
  RecipeCard,
  CapabilityMap,
  RestoreToken,
  SigninPoll,
  SigninStart,
  SigninStatus,
} from "../types";

async function getTree() {
  const t = await ragTransport.getTree();
  // Prime the ambient platform helper (§1) from the earliest payload every
  // window fetches; absent field (older engine) ⇒ helper stays "desktop".
  rememberPlatform(t.platform);
  return t;
}

const post = (body: unknown) => ragTransport.post(body);

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
    const result = await ragTransport.postResult<{ rule?: CurationRule; error?: string }>({
      op: "rules",
      action: "add",
      rule,
    });
    const data = result.body;
    if (!result.ok) return { error: data.error ?? `POST /api/rag ${result.status}` };
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

  async readNote(id: string): Promise<{ markdown: string; name: string }> {
    // §49: full-markdown read of a saved report note for the in-app reader.
    // The engine returns `{name, markdown}` (or `{error}` for an unknown id);
    // surface an empty read rather than throwing, so the reader shows an honest
    // empty state instead of an error overlay.
    const res = await post({ op: "readNote", id });
    return {
      markdown: (res.markdown as string) ?? "",
      name: (res.name as string) ?? "",
    };
  }

  async listReports(): Promise<ReportSummary[]> {
    // §49 §4: the saved-report library for the Reports home. The engine returns
    // `{ reports: [...] }`, newest-first; an old engine without the op (or a
    // transport hiccup) yields no array — surface an empty library, never throw.
    const res = await post({ op: "listReports" });
    const rows = Array.isArray(res.reports) ? (res.reports as Record<string, unknown>[]) : [];
    return rows.map((r) => ({
      id: (r.id as string) ?? "",
      name: (r.name as string) ?? "",
      folder: (r.folder as string) ?? "",
      generatedAtMs: typeof r.generatedAtMs === "number" ? r.generatedAtMs : 0,
    }));
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
      suggestedAsks: Array.isArray(map?.suggestedAsks) ? map.suggestedAsks : [],
      suggestedInvestigations: Array.isArray(map?.suggestedInvestigations)
        ? map.suggestedInvestigations
        : [],
    };
  }

  async investigate(
    table: string,
    template?: ReportTemplate,
    hypothesis?: string,
  ): Promise<{ savedId: string; savedName: string }> {
    // Runs the recipe battery + writes the report note in the Rust engine.
    // PARITY: the dev twin answers `{available:false}` (analytics is Rust-only);
    // a write failure rides back as `{error}`. Either surfaces as an honest throw
    // so the caller shows the error, never a fake saved note. `template` prescribes
    // a structured shape (add-report-templates); omitted ⇒ the Standard report.
    // §46: `hypothesis` seeds the template framing's angle only (never a figure).
    const res = await post({ op: "investigate", table, template, hypothesis });
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
