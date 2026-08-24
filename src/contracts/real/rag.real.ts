/** Real RagService — talks to the local `/api/rag` route (engine-backed). */
import type { PlatformKind, RagService, ReportSummary, ReportTemplate } from "../services";
import { ragTransport } from "./ragTransport";
// Relative (not "@/") so the node test loader can resolve this file — the
// contracts barrel is imported by engine-level suites without webpack aliases.
import { rememberPlatform } from "../../shell/desktopBridge";
import type {
  Attachment,
  FileInspection,
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
  SigninPoll,
  SigninStart,
  SigninStatus,
} from "../types";

async function getCapabilities() {
  const t = await ragTransport.getCapabilities();
  // Prime the ambient platform helper (§1) from the earliest payload every
  // window fetches; absent field (older engine) ⇒ helper stays "desktop".
  rememberPlatform(t.platform);
  return t;
}

const post = (body: unknown) => ragTransport.post(body);

class RealRagService implements RagService {
  async listAttachments(conversationId: string): Promise<Attachment[]> {
    const res = await post({ op: "listAttachments", conversationId });
    return Array.isArray(res.files) ? (res.files as Attachment[]) : [];
  }

  async detach(conversationId: string, fileId: string): Promise<void> {
    await post({ op: "detach", conversationId, fileId });
  }

  async search(
    conversationId: string,
    query: string,
    attachmentIds: string[] = [],
  ): Promise<RagReference[]> {
    const res = await post({ op: "search", conversationId, query, attachmentFileIds: attachmentIds });
    return (res.references as RagReference[]) ?? [];
  }

  async inspect(
    conversationId: string,
    fileId: string,
    query?: string,
  ): Promise<FileInspection> {
    return (await post({
      op: "inspect",
      conversationId,
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
    conversationId: string,
    sql: string,
    fileIds: string[],
    saveAs?: string,
  ): Promise<{
    markdown?: string;
    chart?: string | null;
    footer?: string;
    error?: string;
    savedName?: string;
    content?: string;
    rows?: number;
  }> {
    return (await post({
      op: "analyticsSql",
      conversationId,
      sql,
      fileIds,
      ...(saveAs ? { saveAs } : {}),
    })) as {
      markdown?: string;
      chart?: string | null;
      footer?: string;
      error?: string;
      savedName?: string;
      content?: string;
      rows?: number;
    };
  }

  async exportChat(
    title: string,
    markdown: string,
    options?: { ext?: "md" | "html" },
  ): Promise<{ savedName?: string; content?: string; error?: string }> {
    // 0.15.0: the artifact comes BACK for the OS save dialog; the engine writes
    // nothing. `ext` stays an engine-side strict allowlist.
    return (await post({
      op: "exportChat",
      title,
      markdown,
      ...(options?.ext ? { ext: options.ext } : {}),
    })) as { savedName?: string; content?: string; error?: string };
  }

  async suggestedAsks(
    conversationId: string,
    attachmentIds: string[],
  ): Promise<{ label: string; question: string }[]> {
    const res = await post({ op: "suggestedAsks", conversationId, includedFileIds: attachmentIds });
    return Array.isArray(res.asks) ? (res.asks as { label: string; question: string }[]) : [];
  }

  async applicableRecipes(conversationId: string, attachmentIds: string[]): Promise<RecipeCard[]> {
    const res = await post({ op: "applicableRecipes", conversationId, includedFileIds: attachmentIds });
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

  async capabilityMap(conversationId: string, attachmentIds: string[]): Promise<CapabilityMap> {
    // The wire returns `{ map: CapabilityMap }`; PARITY: the dev twin answers an
    // empty map (analytics is Rust-only), so the panel shows the honest empty
    // state under dev. Every field defaults to [] so a partial wire never throws.
    const res = await post({ op: "capabilityMap", conversationId, includedFileIds: attachmentIds });
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

  async capabilities(): Promise<{ desktop: boolean; platform: PlatformKind }> {
    const t = await getCapabilities();
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

  async auditExport(): Promise<{ savedName?: string; content?: string; error?: string }> {
    return (await post({ op: "auditExport" })) as unknown as {
      savedName?: string;
      content?: string;
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
