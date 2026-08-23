import type { RagService, ReportSummary, ReportTemplate } from "../services";
import type {
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
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

  async setLocalOnly(nodeId: string, localOnly: boolean): Promise<void> {
    // Ancestor-wins: marking a folder privatizes its subtree, so paint the
    // target + descendants' EFFECTIVE flag for display (the engine stores only
    // the target's own flag; resolution covers the rest).
    const ids = this.descendantIds(nodeId);
    this.nodes = this.nodes.map((n) =>
      ids.has(n.id) ? { ...n, localOnly } : n,
    );
  }

  // In-memory curation rules (openspec: add-curation-rules) so the folder
  // dialog and the Preferences list are exercisable offline. The mock stores
  // and lists; it does NOT re-resolve the seed tree (the engines own
  // resolution semantics — the mock's nodes keep their seeded flags).
  private rules: CurationRule[] = [];

  async listRules(): Promise<CurationRule[]> {
    return this.rules.map((r) => ({ ...r }));
  }

  async addRule(rule: CurationRuleInput): Promise<{ rule?: CurationRule; error?: string }> {
    // Mirror the engines' add-time validation so a bad caller fails offline too.
    if (!["include", "exclude", "local-only", "clear"].includes(rule.action)) {
      return { error: "action must be include, exclude, local-only, or clear" };
    }
    const picked =
      Number(rule.kind !== undefined) + Number(rule.ext !== undefined) + Number(rule.glob !== undefined);
    if (picked !== 1) return { error: "exactly one of kind, ext, or glob is required" };
    if (rule.kind !== undefined && !["tabular", "document", "image"].includes(rule.kind)) {
      return { error: "kind must be tabular, document, or image" };
    }
    const ext = rule.ext
      ?.map((e) => e.trim().replace(/^\.+/, "").toLowerCase())
      .filter(Boolean);
    if (ext !== undefined && ext.length === 0) return { error: "ext needs at least one extension" };
    // Display name derivation mirrors the engines' ruleDisplayName.
    const predicate =
      rule.kind === "tabular"
        ? "spreadsheets"
        : rule.kind === "document"
          ? "documents"
          : rule.kind === "image"
            ? "images"
            : ext !== undefined
              ? `${ext.map((e) => `.${e}`).join("/")} files`
              : `files matching ${rule.glob}`;
    const created: CurationRule = {
      ...rule,
      ...(ext !== undefined ? { ext } : {}),
      id: `r${(this.rules.length + 1).toString(16).padStart(8, "0")}`,
      name: `${predicate} in ${rule.scope === "" ? "the vault" : `/${rule.scope}`}`,
      scopeLabel: rule.scope === "" ? "Vault" : rule.scope,
      orphaned: rule.scope !== "" && !this.nodes.some((n) => n.id === rule.scope && n.kind === "folder"),
    };
    this.rules.push(created);
    return { rule: { ...created } };
  }

  async removeRule(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id);
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

  async inspect(fileId: string, query?: string): Promise<FileInspection> {
    const node = this.nodes.find((n) => n.kind === "file" && n.id === fileId);
    if (!node) return {};
    const tabular = /\.(csv|tsv|xlsx?|xlsm|parquet)$/i.test(node.name);
    // PARITY: the mock mirrors the web twin — shared fields only, Rust-engine-only
    // fields (fromOcr, chunkCount, columns, indexedAt, fresh) omitted, not faked.
    const out: FileInspection = {
      name: node.name,
      included: node.ragIncluded,
      localOnly: node.localOnly === true,
      chunkMode: tabular ? "tabular" : "prose",
      extractPreview: `…extracted text preview for ${node.name}…`,
    };
    // CSV/TSV also carry a small parsed table preview (shared field) so the
    // inspector renders its table shape end to end offline.
    if (/\.(csv|tsv)$/i.test(node.name)) {
      out.previewTable = {
        header: ["month", "region", "revenue"],
        rows: [
          ["Jan", "West", "48200"],
          ["Feb", "West", "51330"],
          ["Mar", "East", "44190"],
        ],
        truncated: true,
      };
    }
    // Like the twin (src/server/inspect.ts): no OCR in this engine, reported
    // honestly for the files OCR could apply to (images + PDFs).
    if (/\.(png|jpe?g|webp|bmp|tiff?|pdf)$/i.test(node.name)) out.ocrAvailability = "unsupported";
    const q = query?.trim();
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = node.name.toLowerCase();
      const overlap = terms.filter((t) => hay.includes(t)).length;
      out.testSearch = [
        { text: `…relevant passage from ${node.name}…`, score: Math.min(1, 0.4 + overlap * 0.2) },
      ];
    }
    return out;
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
    options?: {
      subdir?: "Lighthouse Notes" | "Lighthouse Results";
      ext?: "md" | "html";
      investigationId?: string;
    },
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    await new Promise((r) => setTimeout(r, 150));
    if (!markdown.trim()) return { error: "markdown required" };
    // Mirror the engines' strict allowlist so a bad caller fails offline too.
    let subdir: string = options?.subdir ?? "Lighthouse Notes";
    const ext = options?.ext ?? "md";
    if (subdir !== "Lighthouse Notes" && subdir !== "Lighthouse Results") {
      return { error: 'subdir must be "Lighthouse Notes" or "Lighthouse Results"' };
    }
    if (ext !== "md" && ext !== "html") return { error: 'ext must be "md" or "html"' };
    const name = `${title.trim() || "Chat"}.${ext}`;
    return { savedId: `${subdir}/${name}`, savedName: name };
  }

  async exportConversationNote(
    conversationId: string,
    title: string,
    markdown: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    await new Promise((r) => setTimeout(r, 50));
    if (!conversationId.trim() || !markdown.trim()) {
      return { error: "conversationId and markdown required" };
    }
    const name = `${title.trim() || "Conversation"} [mock].md`;
    return { savedId: `Lighthouse Notes/Chats/${name}`, savedName: name };
  }

  async purgeConversationNotes(): Promise<{ ok?: boolean; error?: string }> {
    return { ok: true };
  }

  // In-memory pins so the pin chip, dialog, and banner are exercisable
  // offline. The mock "primes" a canned summary; rechecks report no changes.





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

  async applicableRecipes(includedFileIds: string[]): Promise<RecipeCard[]> {
    // The mock has no column catalog; surface a plausible file-derived subset for
    // the first included tabular file so the gallery + chips are exercisable
    // offline. The data-quality audit needs nothing, so it always applies; the
    // others are canned as if the sheet had a date/numeric/group column.
    // Summaries are byte-identical to the recipes.rs built-ins (rule 2). [] when
    // nothing tabular is included — the same no-tabular-files behavior as the
    // engine's file-derived subset.
    const included = new Set(includedFileIds);
    const sheet = this.nodes.find(
      (n) => n.kind === "file" && included.has(n.id) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
    );
    if (!sheet) return [];
    return [
      {
        id: "variance-vs-last-period",
        name: "Variance vs last period",
        summary: "How the latest month's total moved versus the prior month.",
        table: sheet.name,
      },
      {
        id: "cohort-breakdown",
        name: "Cohort breakdown",
        summary: "The metric split by group, ranked, with each group's share of the total.",
        table: sheet.name,
      },
      {
        id: "data-quality-audit",
        name: "Data-quality audit",
        summary: "Per-column null counts, distinct/duplicate counts, and numeric IQR outliers.",
        table: sheet.name,
      },
    ];
  }

  async capabilityMap(includedFileIds: string[]): Promise<CapabilityMap> {
    // A small deterministic fixture so the capability gallery renders offline.
    // Reuses the applicableRecipes mock's "first included tabular sheet" choice,
    // plus a date+numeric column set (⇒ investigable), one metric, one ask, and
    // one "Investigate {table}" suggestion. Empty everywhere when nothing tabular
    // is included. PARITY: the real web dev twin returns an EMPTY map (analytics
    // is Rust-only), so under `npm run dev` the panel shows the empty state.
    const included = new Set(includedFileIds);
    const sheet = this.nodes.find(
      (n) => n.kind === "file" && included.has(n.id) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
    );
    if (!sheet) {
      return { tables: [], recipes: [], suggestedAsks: [], suggestedInvestigations: [] };
    }
    const recipes = await this.applicableRecipes(includedFileIds);
    return {
      tables: [
        {
          name: sheet.name,
          columns: [
            { name: "date", kind: "date" },
            { name: "region", kind: "text" },
            { name: "amount", kind: "numeric" },
          ],
          investigable: true,
        },
      ],
      recipes,
      suggestedAsks: [
        { label: "Total amount by region", question: `Total amount by region in ${sheet.name}` },
      ],
      suggestedInvestigations: [{ label: `Investigate ${sheet.name}`, table: sheet.name }],
    };
  }

  async investigate(
    table: string,
    _investigationId?: string,
    template?: ReportTemplate,
    _hypothesis?: string,
  ): Promise<{ savedId: string; savedName: string }> {
    // A fake saved report so the gallery's Investigate affordance is
    // exercisable offline. PARITY: the real web dev twin throws (deep analysis
    // is Rust-only); the desktop engine saves the real report in its reports
    // directory. The name mirrors the Rust `ReportTemplate::title_suffix` so a
    // templated mock shows the same title the desktop engine would write.
    const suffix =
      template === "imrad"
        ? " — Scientific method"
        : template === "bluf"
          ? " — Business report"
          : "";
    const name = `Investigate ${table}${suffix}.md`;
    // An id IS the bare filename since 0.15.0 (refocus-chat-attachments §1.7).
    return { savedId: name, savedName: name };
  }

  async readNote(id: string): Promise<{ markdown: string; name: string }> {
    // §49: a believable saved-report markdown so the in-app report reader
    // renders end to end offline — a heading, a summary, a ```lighthouse-chart
    // fence (so the key chart draws), a section table, and caveats. PARITY: the
    // desktop engine returns the ACTUAL saved report; this mock is what the
    // offline/test flow drives against. The id IS the filename.
    const name = id || "Report.md";
    const title = name.replace(/\.md$/, "");
    const markdown = [
      `# ${title}`,
      "",
      "_Generated just now — every figure computed by Lighthouse._",
      "",
      "## Summary",
      "",
      "- Revenue rose 18% in the latest month.",
      "",
      "```lighthouse-chart",
      '{"kind":"bar","x":["Q1","Q2","Q3"],"series":[{"name":"revenue","values":[120,150,177]}]}',
      "```",
      "",
      "## By quarter",
      "",
      "What does revenue by quarter show?",
      "",
      "| quarter | revenue |",
      "| --- | --- |",
      "| Q1 | 120 |",
      "| Q2 | 150 |",
      "| Q3 | 177 |",
      "",
      "## Caveats",
      "",
      "- The most recent quarter may be partial.",
      "",
    ].join("\n");
    return { markdown, name };
  }

  async listReports(): Promise<ReportSummary[]> {
    // §49 §4: a small, believable library so the Reports home renders offline —
    // a standalone report plus an investigation report, newest-first. PARITY: the
    // desktop engine lists the ACTUAL saved notes (mtime-ordered); this mock is
    // what the offline/test flow drives against. Each id feeds the mock
    // readNote() above (any id yields a believable note), so the row → reader
    // path works end to end. Fixed timestamps keep the order deterministic.
    return [
      {
        id: "Investigate Sales.md",
        name: "Investigate Sales.md",
        generatedAtMs: 1_720_000_200_000,
      },
      {
        id: "Investigate Signups — Scientific method.md",
        name: "Investigate Signups — Scientific method.md",
        generatedAtMs: 1_720_000_100_000,
      },
    ];
  }

  async insights(): Promise<InsightsScan> {
    // A small fixed sample so the proactive "What stands out" panel renders in
    // the offline/mock flow. The findings arrive pre-ranked (most notable first)
    // with engine-shaped headlines the panel renders VERBATIM, one per kind, and
    // tablesScanned < tablesAvailable exercises the "scanned N of M" disclosure.
    // PARITY: the real web dev twin answers an EMPTY scan (analytics is
    // Rust-only), so under `npm run dev` the panel shows the honest empty state —
    // this mock is what the offline/test flow drives against.
    // Pre-ranked (most notable first) by magnitude — the order the panel renders
    // in, mirroring the engine's ranked, bounded output.
    return {
      findings: [
        {
          table: "sales.csv",
          kind: "mover",
          headline: "sales.csv: South is up +400% vs last month",
          magnitude: 4,
          sql: "SELECT region, SUM(amount) AS total FROM sales GROUP BY region",
        },
        {
          table: "sales.csv",
          kind: "anomaly",
          headline: "sales.csv: 2024-10 is a +2.85σ anomaly",
          magnitude: 2.85,
          sql: "SELECT month, SUM(amount) AS total FROM sales GROUP BY month",
        },
        {
          table: "signups.csv",
          kind: "changepoint",
          headline: "signups.csv: level shift up at 2024-08 (+1.9σ)",
          magnitude: 1.9,
          sql: "SELECT month, SUM(count) AS total FROM signups GROUP BY month",
        },
      ],
      tablesScanned: 3,
      tablesAvailable: 5,
    };
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

  async capabilities(): Promise<{ desktop: boolean; platform: "desktop" }> {
    // The mock is the plain-web deployment: not an embedded shell, computer
    // form factor.
    return { desktop: false, platform: "desktop" };
  }

  async policy(): Promise<PolicySnapshot> {
    // The mock is never managed: all-permissive locks so the settings UI
    // renders every control editable (no "Managed by your organization").
    return {
      present: false,
      error: false,
      locks: {
        allowedProviders: null,
        telemetryOff: false,
        chatHistoryOff: false,
        widgetHotkeysOff: false,
        ocrOff: false,
        notificationsOff: false,
        auditLogOn: false,
        vaultRoots: null,
      },
    };
  }

  async egress(): Promise<EgressSnapshot> {
    // The mock never dials out — always "All local".
    return { total: 0, destinations: [] };
  }

  async audit(_limit?: number): Promise<AuditSnapshot> {
    // The mock never writes an audit log — disabled and empty.
    return { enabled: false, intact: true, records: [] };
  }

  async auditVerify(): Promise<AuditVerdict> {
    return { intact: true, breakAt: -1, count: 0 };
  }

  async auditExport(): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return { error: "audit log is disabled" };
  }

  // Provider sign-in (0.12.1 §3): a scripted device flow so the AI-models
  // dialog is exercisable offline. The mock simulates a CONFIGURED build
  // (available: true) — the real engines are available:false until a
  // maintainer registers with the vendor, and fail-closed invisibility is
  // proven against that real gate, not this script. Script: start → canned
  // code; two pending polls → complete; status flips; signout clears.
  private signinMethod: "key" | "signin" = "key";
  private signinSignedIn = false;
  /** Polls remaining before the scripted flow completes; -1 = no flow. */
  private signinPollsLeft = -1;
  private static readonly SIGNIN_ACCOUNT = "mock@example.com";

  async providerAuthStatus(): Promise<SigninStatus> {
    return {
      available: true,
      signedIn: this.signinSignedIn,
      method: this.signinMethod,
      ...(this.signinSignedIn
        ? {
            accountHint: MockRagService.SIGNIN_ACCOUNT,
            expiresMs: Date.now() + 3_600_000,
          }
        : {}),
    };
  }

  async providerAuthStart(): Promise<{ start?: SigninStart; error?: string }> {
    this.signinPollsLeft = 2;
    return {
      start: {
        userCode: "MOCK-0421",
        verificationUri: "https://signin.example/device",
        intervalMs: 10,
        expiresInMs: 600_000,
      },
    };
  }

  async providerAuthPoll(): Promise<SigninPoll> {
    if (this.signinPollsLeft < 0) {
      return this.signinSignedIn
        ? { status: "complete", accountHint: MockRagService.SIGNIN_ACCOUNT }
        : { status: "idle" };
    }
    if (this.signinPollsLeft > 0) {
      this.signinPollsLeft -= 1;
      return { status: "pending", intervalMs: 10 };
    }
    this.signinPollsLeft = -1;
    this.signinSignedIn = true;
    return { status: "complete", accountHint: MockRagService.SIGNIN_ACCOUNT };
  }

  async providerAuthSignout(): Promise<void> {
    this.signinSignedIn = false;
    this.signinPollsLeft = -1;
  }

  async providerAuthSetMethod(
    method: "key" | "signin",
  ): Promise<{ ok?: boolean; error?: string }> {
    this.signinMethod = method;
    return { ok: true };
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
