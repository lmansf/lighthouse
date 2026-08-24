import type { RagService, ReportSummary, ReportTemplate } from "../services";
import type {
  Attachment,
  FileInspection,
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
import { SEED_ATTACHMENTS } from "./files";

/**
 * In-memory RagService. Holds a seed conversation's attachments and
 * "retrieves" references by naive keyword overlap against them. A real
 * implementation swaps the storage + search internals while keeping this exact
 * surface. Since 0.15.0 there is no tree, no inclusion gate and no curation
 * layer to mock — attaching a file to a chat is the whole decision.
 */
class MockRagService implements RagService {

  /** Seeded per conversation on first touch, so any chat id has a corpus. */
  private byConversation = new Map<string, Attachment[]>();

  private files(conversationId: string): Attachment[] {
    let list = this.byConversation.get(conversationId);
    if (!list) {
      list = SEED_ATTACHMENTS.map((a) => ({ ...a }));
      this.byConversation.set(conversationId, list);
    }
    return list;
  }

  async listAttachments(conversationId: string): Promise<Attachment[]> {
    return this.files(conversationId).map((a) => ({ ...a }));
  }

  async detach(conversationId: string, fileId: string): Promise<void> {
    this.byConversation.set(
      conversationId,
      this.files(conversationId).filter((a) => a.id !== fileId),
    );
  }

  async search(
    conversationId: string,
    query: string,
    attachmentIds: string[] = [],
  ): Promise<RagReference[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scope = new Set(attachmentIds);
    return this.files(conversationId)
      .filter((n) => scope.size === 0 || scope.has(n.id))
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

  async inspect(
    conversationId: string,
    fileId: string,
    query?: string,
  ): Promise<FileInspection> {
    const node = this.files(conversationId).find((n) => n.id === fileId);
    if (!node) return {};
    const tabular = /\.(csv|tsv|xlsx?|xlsm|parquet)$/i.test(node.name);
    // PARITY: the mock mirrors the web twin — shared fields only, Rust-engine-only
    // fields (fromOcr, chunkCount, columns, indexedAt, fresh) omitted, not faked.
    const out: FileInspection = {
      name: node.name,
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
    _conversationId: string,
    sql: string,
    _fileIds: string[],
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
      // The CSV comes BACK for the save dialog (0.15.0), so the chip round-trips
      // offline exactly as it does against the real engine.
      ...(saveAs
        ? {
            savedName: `${saveAs}.csv`,
            content: "region,total\nNE,150\nNW,200\n",
            rows: 2,
          }
        : {}),
    };
  }

  async exportChat(
    title: string,
    markdown: string,
    options?: { ext?: "md" | "html" },
  ): Promise<{ savedName?: string; content?: string; error?: string }> {
    await new Promise((r) => setTimeout(r, 150));
    if (!markdown.trim()) return { error: "markdown required" };
    // Mirror the engines' strict allowlist so a bad caller fails offline too.
    const ext = options?.ext ?? "md";
    if (ext !== "md" && ext !== "html") return { error: 'ext must be "md" or "html"' };
    return { savedName: `${title.trim() || "Chat"}.${ext}`, content: markdown };
  }

  // In-memory pins so the pin chip, dialog, and banner are exercisable
  // offline. The mock "primes" a canned summary; rechecks report no changes.





  async suggestedAsks(
    _conversationId: string,
    includedFileIds: string[],
  ): Promise<{ label: string; question: string }[]> {
    // The mock has no column catalog; surface canned asks for the first
    // included tabular file so the empty-state chips are exercisable offline.
    const scope = new Set(includedFileIds);
    const sheet = this.files(_conversationId).find(
      (n) =>
        (scope.size === 0 || scope.has(n.id)) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
    );
    if (!sheet) return [];
    return [
      { label: "Total amount by region", question: `Total amount by region in ${sheet.name}` },
      { label: "Monthly trend of amount", question: `Monthly trend of amount in ${sheet.name}` },
    ];
  }

  async applicableRecipes(
    _conversationId: string,
    includedFileIds: string[],
  ): Promise<RecipeCard[]> {
    // The mock has no column catalog; surface a plausible file-derived subset for
    // the first included tabular file so the gallery + chips are exercisable
    // offline. The data-quality audit needs nothing, so it always applies; the
    // others are canned as if the sheet had a date/numeric/group column.
    // Summaries are byte-identical to the recipes.rs built-ins (rule 2). [] when
    // nothing tabular is included — the same no-tabular-files behavior as the
    // engine's file-derived subset.
    const scope = new Set(includedFileIds);
    const sheet = this.files(_conversationId).find(
      (n) =>
        (scope.size === 0 || scope.has(n.id)) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
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

  async capabilityMap(_conversationId: string, includedFileIds: string[]): Promise<CapabilityMap> {
    // A small deterministic fixture so the capability gallery renders offline.
    // Reuses the applicableRecipes mock's "first included tabular sheet" choice,
    // plus a date+numeric column set (⇒ investigable), one metric, one ask, and
    // one "Investigate {table}" suggestion. Empty everywhere when nothing tabular
    // is included. PARITY: the real web dev twin returns an EMPTY map (analytics
    // is Rust-only), so under `npm run dev` the panel shows the empty state.
    const scope = new Set(includedFileIds);
    const sheet = this.files(_conversationId).find(
      (n) =>
        (scope.size === 0 || scope.has(n.id)) && /\.(csv|tsv|xlsx?|parquet)$/i.test(n.name),
    );
    if (!sheet) {
      return { tables: [], recipes: [], suggestedAsks: [], suggestedInvestigations: [] };
    }
    const recipes = await this.applicableRecipes(_conversationId, includedFileIds);
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

  async auditExport(): Promise<{ savedName?: string; content?: string; error?: string }> {
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

}

export const ragService: RagService = new MockRagService();
