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
  ShapeViewResult,
  View,
  ViewCreateInput,
  ViewInspection,
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
    // Investigation notes (openspec: add-investigations §3), mirroring the
    // engines: a non-empty investigationId routes the NOTES destination to
    // the investigation's own folder (resolved from the record — the caller
    // never names it); "Lighthouse Results" is unaffected; unknown → error.
    const investigationId = options?.investigationId?.trim();
    let noteInvestigation: Investigation | undefined;
    if (investigationId && subdir === "Lighthouse Notes") {
      noteInvestigation = this.investigations.find((i) => i.id === investigationId);
      if (!noteInvestigation) return { error: "investigation not found" };
      subdir = `Lighthouse Notes/${noteInvestigation.folderName}`;
    }
    const name = `${title.trim() || "Chat"}.${ext}`;
    const savedId = `${subdir}/${name}`;
    if (noteInvestigation) {
      // Membership = location: remember the note so the view derives it.
      const notes = this.noteIdsByInvestigation.get(noteInvestigation.id) ?? [];
      if (!notes.includes(savedId)) notes.push(savedId);
      this.noteIdsByInvestigation.set(noteInvestigation.id, notes);
    }
    return { savedId, savedName: name };
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
  private pins: Pin[] = [];

  async pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
    investigationId?: string,
  ): Promise<{ pin?: Pin; error?: string }> {
    if (!question.trim() || !sql.trim()) return { error: "a pin needs the question and its SQL" };
    const id = `pin-${sql.length}-${sql.slice(0, 8).replace(/\W/g, "")}`;
    this.pins = this.pins.filter((p) => p.id !== id);
    if (this.pins.length >= 20) return { error: "pin limit reached (20) — remove one in the pins dialog first" };
    const inv = investigationId?.trim();
    const pin: Pin = {
      id,
      question: question.trim(),
      sql: sql.trim(),
      fileIds,
      createdMs: Date.now(),
      lastRunMs: Date.now(),
      lastSummary: "NE 150 · NW 200",
      // The pin's membership (openspec: add-investigations) — absent stays
      // uncategorized, mirroring the engines.
      ...(inv ? { investigationId: inv } : {}),
    };
    this.pins.push(pin);
    return { pin: { ...pin } };
  }

  async unpinAsk(id: string): Promise<void> {
    this.pins = this.pins.filter((p) => p.id !== id);
  }

  async listPins(investigationId?: string): Promise<Pin[]> {
    // Optional investigation filter (openspec: add-investigations); absent
    // keeps the original "all pins" behavior — mirroring the engines.
    const pins =
      investigationId === undefined
        ? this.pins
        : this.pins.filter((p) => p.investigationId === investigationId);
    return pins.map((p) => ({ ...p }));
  }

  async recheckPins(): Promise<{ changed: ChangedPin[]; pins: Pin[] }> {
    const now = Date.now();
    this.pins = this.pins.map((p) => ({ ...p, lastRunMs: now }));
    return { changed: [], pins: this.pins.map((p) => ({ ...p })) };
  }

  // In-memory briefings so the briefings dialog is exercisable offline.
  private briefings: Briefing[] = [];

  async listBriefings(): Promise<Briefing[]> {
    return this.briefings.map((b) => ({ ...b }));
  }

  async saveBriefing(
    title: string,
    pinIds: string[],
    cadence: Cadence,
  ): Promise<{ briefing?: Briefing; error?: string }> {
    if (!title.trim()) return { error: "a briefing needs a title" };
    if (pinIds.length === 0) return { error: "a briefing needs at least one pinned question" };
    const id = `brief-${title.trim().toLowerCase().replace(/\W/g, "").slice(0, 12)}`;
    const existing = this.briefings.find((b) => b.id === id);
    this.briefings = this.briefings.filter((b) => b.id !== id);
    if (this.briefings.length >= 20) return { error: "briefing limit reached (20) — remove one first" };
    const briefing: Briefing = {
      id,
      title: title.trim(),
      pinIds,
      cadence,
      createdMs: existing?.createdMs ?? Date.now(),
    };
    this.briefings.push(briefing);
    return { briefing: { ...briefing } };
  }

  async removeBriefing(id: string): Promise<void> {
    this.briefings = this.briefings.filter((b) => b.id !== id);
  }

  async runBriefing(id: string): Promise<BriefingReport | undefined> {
    const briefing = this.briefings.find((b) => b.id === id);
    if (!briefing) return undefined;
    const sections = briefing.pinIds.map((pid) => {
      const pin = this.pins.find((p) => p.id === pid);
      return pin
        ? { question: pin.question, markdown: pin.lastSummary ?? "" }
        : { question: `(removed pin ${pid})`, markdown: "", error: "this pinned question was removed" };
    });
    return { id: briefing.id, title: briefing.title, generatedMs: Date.now(), sections };
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
      return { tables: [], recipes: [], metrics: [], suggestedAsks: [], suggestedInvestigations: [] };
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
      metrics: [
        {
          id: "metric-revenue",
          name: "revenue",
          expression: "SUM(amount)",
          description: "Total sales amount.",
          entity: sheet.name,
          localOnly: false,
        },
      ],
      suggestedAsks: [
        { label: "Total amount by region", question: `Total amount by region in ${sheet.name}` },
      ],
      suggestedInvestigations: [{ label: `Investigate ${sheet.name}`, table: sheet.name }],
    };
  }

  async investigate(table: string): Promise<{ savedId: string; savedName: string }> {
    // A fake saved note so the gallery's Investigate affordance is exercisable
    // offline. PARITY: the real web dev twin throws (deep analysis is Rust-only);
    // the desktop engine writes the real report under Lighthouse Reports/.
    const name = `Investigate ${table}.md`;
    return { savedId: `Lighthouse Reports/${name}`, savedName: name };
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

  async refreshBriefingNote(): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    return {
      savedId: "Lighthouse Notes/Lighthouse Briefing.md",
      savedName: "Lighthouse Briefing.md",
    };
  }

  // In-memory investigations (openspec: add-investigations) so the nav is
  // exercisable offline. Mirrors the engines' validation (non-empty name,
  // case-insensitive uniqueness across archived records, traversal-safe
  // folder name fixed at creation); ids are mock-simple counters, not the
  // engines' sha mint. pinRefs/noteRefs are DERIVED at read time exactly
  // like the engines (§3): pins carrying the id; notes exported into the
  // investigation's folder this session.
  private investigations: Investigation[] = [];

  /** Note ids exported per investigation — the mock's "folder" (no real walk). */
  private noteIdsByInvestigation = new Map<string, string[]>();

  /** Mirror of the engines' read-time view derivation (§3). */
  private investigationViewOf(rec: Investigation): Investigation {
    return {
      ...rec,
      pinRefs: this.pins.filter((p) => p.investigationId === rec.id).map((p) => p.id),
      noteRefs: [...(this.noteIdsByInvestigation.get(rec.id) ?? [])],
    };
  }

  /** Mirror of the engines' sanitizeFolderName (traversal-safe). */
  private sanitizeFolderName(name: string): string {
    const collapsed = name
      .replace(/[/\\]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (!collapsed || /^\.+$/.test(collapsed)) return "Investigation";
    return collapsed;
  }

  private investigationNameTaken(name: string, excludingId?: string): boolean {
    const wanted = name.toLowerCase();
    return this.investigations.some(
      (i) => i.id !== excludingId && i.name.toLowerCase() === wanted,
    );
  }

  async listInvestigations(): Promise<Investigation[]> {
    return this.investigations.map((i) => this.investigationViewOf(i));
  }

  async createInvestigation(
    input: InvestigationCreateInput,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const name = input.name.trim();
    if (!name) return { error: "an investigation needs a name" };
    if (this.investigationNameTaken(name)) {
      return { error: `an investigation named "${name}" already exists` };
    }
    const investigation: Investigation = {
      id: `inv-${(this.investigations.length + 1).toString(16).padStart(12, "0")}`,
      name,
      createdMs: Date.now(),
      archived: false,
      scopeFileIds: (input.scopeFileIds ?? []).filter((s) => s.trim() !== ""),
      providerPolicy: input.providerPolicy ?? "default",
      conversationRefs: [],
      folderName: this.sanitizeFolderName(name),
      pinRefs: [],
      noteRefs: [],
    };
    this.investigations.push(investigation);
    return { investigation: this.investigationViewOf(investigation) };
  }

  async renameInvestigation(
    id: string,
    name: string,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { error: "an investigation needs a name" };
    if (this.investigationNameTaken(trimmed, id)) {
      return { error: `an investigation named "${trimmed}" already exists` };
    }
    const rec = this.investigations.find((i) => i.id === id);
    if (!rec) return { error: "investigation not found" };
    rec.name = trimmed; // folderName deliberately unchanged (rename moves nothing)
    return { investigation: this.investigationViewOf(rec) };
  }

  async setInvestigationArchived(
    id: string,
    archived: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const rec = this.investigations.find((i) => i.id === id);
    if (!rec) return { error: "investigation not found" };
    rec.archived = archived; // a visibility flag only — nothing cascades
    return { investigation: this.investigationViewOf(rec) };
  }

  async addInvestigationConversationRef(
    id: string,
    conversationId: string,
    persistAllowed: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const ref = conversationId.trim();
    if (!ref) return { error: "conversationId required" };
    const rec = this.investigations.find((i) => i.id === id);
    if (!rec) return { error: "investigation not found" };
    // The mock is never managed (policy() reports history unlocked), so the
    // engines' gate — persistAllowed AND historyAllowed — reduces to the
    // client's verdict. Either false ⇒ silent no-op; refs dedupe.
    if (persistAllowed && !rec.conversationRefs.includes(ref)) {
      rec.conversationRefs.push(ref);
    }
    return { investigation: this.investigationViewOf(rec) };
  }

  async forkInvestigation(
    id: string,
    name: string,
  ): Promise<{ investigation?: Investigation; error?: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { error: "an investigation needs a name" };
    const parent = this.investigations.find((i) => i.id === id);
    if (!parent) return { error: "investigation not found" };
    if (this.investigationNameTaken(trimmed)) {
      return { error: `an investigation named "${trimmed}" already exists` };
    }
    const investigation: Investigation = {
      id: `inv-${(this.investigations.length + 1).toString(16).padStart(12, "0")}`,
      name: trimmed,
      createdMs: Date.now(),
      archived: false,
      // Structure only — derived membership (pins/notes) is NOT duplicated.
      scopeFileIds: [...parent.scopeFileIds],
      providerPolicy: parent.providerPolicy,
      conversationRefs: [...parent.conversationRefs],
      folderName: this.sanitizeFolderName(trimmed),
      pinRefs: [],
      noteRefs: [],
    };
    this.investigations.push(investigation);
    return { investigation: this.investigationViewOf(investigation) };
  }

  async exportInvestigation(
    id: string,
    _title?: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    const rec = this.investigations.find((i) => i.id === id);
    if (!rec) return { error: "investigation not found" };
    // A plausible in-vault note under the investigation's folder (no real
    // walk — the mock records the id so investigationViewOf derives it).
    const savedName = `${rec.name}.md`;
    const savedId = `Lighthouse Notes/${rec.folderName}/${savedName}`;
    const notes = this.noteIdsByInvestigation.get(id) ?? [];
    if (!notes.includes(savedId)) notes.push(savedId);
    this.noteIdsByInvestigation.set(id, notes);
    return { savedId, savedName };
  }

  // In-memory boards (openspec: add-boards) so the board panel is
  // exercisable offline. Mirrors the engines' validation and lazy defaults:
  // per-scope case-insensitive name uniqueness, S|M|L size whitelist,
  // tombstone-tolerant pin refs, and virtual defaults under deterministic
  // ids ("default-global" / "default-<invId>") that materialize on first
  // mutation. refreshCards answers from the mock's stored pins (live:
  // false), so cards render like the twin's last-known snapshots.
  private boards: Board[] = [];

  private cloneBoard(b: Board): Board {
    return { ...b, cards: b.cards.map((c) => ({ ...c })) };
  }

  private boardNameTaken(name: string, scope: string | undefined, excludingId?: string): boolean {
    const wanted = name.toLowerCase();
    return this.boards.some(
      (b) =>
        b.id !== excludingId && b.investigationId === scope && b.name.toLowerCase() === wanted,
    );
  }

  /** The scope + default name a never-persisted default id names, or null. */
  private virtualBoardScope(id: string): { scope?: string; name: string } | null {
    if (id === "default-global") return { name: "My board" };
    if (!id.startsWith("default-")) return null;
    const inv = this.investigations.find((i) => i.id === id.slice("default-".length));
    return inv ? { scope: inv.id, name: inv.name } : null;
  }

  private virtualBoard(scope: string | undefined, name: string): Board {
    return {
      id: scope ? `default-${scope}` : "default-global",
      name,
      ...(scope ? { investigationId: scope } : {}),
      cards: [],
      createdMs: 0,
    };
  }

  /** Mirrors the engines' card validation, byte-identical reasons. */
  private validateBoardCards(cards: BoardCardRef[]): string | null {
    for (const c of cards) {
      if (!c.pinId.trim()) return "every card needs a pinId";
      if (c.size !== "S" && c.size !== "M" && c.size !== "L") {
        return 'card size must be "S", "M", or "L"';
      }
    }
    return null;
  }

  async listBoards(investigationId?: string): Promise<Board[]> {
    if (investigationId) {
      const out = this.boards
        .filter((b) => b.investigationId === investigationId)
        .map((b) => this.cloneBoard(b));
      if (out.length === 0) {
        const inv = this.investigations.find((i) => i.id === investigationId);
        if (inv) out.push(this.virtualBoard(inv.id, inv.name));
      }
      return out;
    }
    const out = this.boards.map((b) => this.cloneBoard(b));
    if (!this.boards.some((b) => b.investigationId === undefined)) {
      out.push(this.virtualBoard(undefined, "My board"));
    }
    for (const inv of this.investigations) {
      if (!this.boards.some((b) => b.investigationId === inv.id)) {
        out.push(this.virtualBoard(inv.id, inv.name));
      }
    }
    return out;
  }

  async createBoard(
    name: string,
    investigationId?: string,
  ): Promise<{ board?: Board; error?: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { error: "a board needs a name" };
    const scope = investigationId?.trim() || undefined;
    if (this.boardNameTaken(trimmed, scope)) {
      return { error: `a board named "${trimmed}" already exists` };
    }
    const board: Board = {
      id: `board-${(this.boards.length + 1).toString(16).padStart(12, "0")}`,
      name: trimmed,
      ...(scope ? { investigationId: scope } : {}),
      cards: [],
      createdMs: Date.now(),
    };
    this.boards.push(board);
    return { board: this.cloneBoard(board) };
  }

  async renameBoard(id: string, name: string): Promise<{ board?: Board; error?: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { error: "a board needs a name" };
    const rec = this.boards.find((b) => b.id === id);
    if (rec) {
      if (this.boardNameTaken(trimmed, rec.investigationId, id)) {
        return { error: `a board named "${trimmed}" already exists` };
      }
      rec.name = trimmed;
      return { board: this.cloneBoard(rec) };
    }
    // First mutation of a virtual default materializes it under the new
    // name, keeping the deterministic id (mirroring the engines).
    const virtual = this.virtualBoardScope(id);
    if (!virtual) return { error: "board not found" };
    if (this.boardNameTaken(trimmed, virtual.scope)) {
      return { error: `a board named "${trimmed}" already exists` };
    }
    const board: Board = {
      id,
      name: trimmed,
      ...(virtual.scope ? { investigationId: virtual.scope } : {}),
      cards: [],
      createdMs: Date.now(),
    };
    this.boards.push(board);
    return { board: this.cloneBoard(board) };
  }

  async deleteBoard(id: string): Promise<{ ok?: boolean; error?: string }> {
    const before = this.boards.length;
    this.boards = this.boards.filter((b) => b.id !== id);
    if (this.boards.length !== before) return { ok: true };
    // A never-persisted virtual default is an Ok no-op (deleting a default
    // is always effectively a reset — it relists empty either way).
    if (this.virtualBoardScope(id)) return { ok: true };
    return { error: "board not found" };
  }

  async setBoardCards(
    id: string,
    cards: BoardCardRef[],
  ): Promise<{ board?: Board; error?: string }> {
    const invalid = this.validateBoardCards(cards);
    if (invalid) return { error: invalid };
    const rec = this.boards.find((b) => b.id === id);
    if (rec) {
      rec.cards = cards.map((c) => ({ ...c }));
      return { board: this.cloneBoard(rec) };
    }
    const virtual = this.virtualBoardScope(id);
    if (!virtual) return { error: "board not found" };
    if (this.boardNameTaken(virtual.name, virtual.scope)) {
      return { error: `a board named "${virtual.name}" already exists` };
    }
    const board: Board = {
      id,
      name: virtual.name,
      ...(virtual.scope ? { investigationId: virtual.scope } : {}),
      cards: cards.map((c) => ({ ...c })),
      createdMs: Date.now(),
    };
    this.boards.push(board);
    return { board: this.cloneBoard(board) };
  }

  async refreshBoardCards(pinIds: string[]): Promise<BoardCardRefresh[]> {
    // Stored-state answers (the twin posture) so cards render offline: the
    // mock never computes results, it replays each pin's last-known state.
    return pinIds.map((pinId) => {
      const pin = this.pins.find((p) => p.id === pinId);
      if (!pin) return { pinId, live: false, tombstone: true };
      return {
        pinId,
        live: false,
        question: pin.question,
        ...(pin.lastRunMs !== undefined ? { lastRunMs: pin.lastRunMs } : {}),
        ...(pin.lastSummary !== undefined ? { lastSummary: pin.lastSummary } : {}),
        ...(pin.lastDigest !== undefined ? { lastDigest: pin.lastDigest } : {}),
        ...(pin.staleReason !== undefined ? { staleReason: pin.staleReason } : {}),
      };
    });
  }

  // In-memory shaped views (openspec: add-shaped-views) so the Save-as-view
  // and shaping dialogs are exercisable offline. Mirrors the service surface:
  // refusals THROW with a human-readable reason (the engines own the full
  // rules — the mock checks just enough that a bad caller fails offline too),
  // and shapeView answers a CANNED proposal so UI tests can drive the dialog
  // through propose → review → save without a model.
  private views: View[] = [];

  private cloneView(v: View): View {
    return {
      ...v,
      reads: { files: v.reads.files.map((f) => ({ ...f })), views: [...v.reads.views] },
      summary: { ...v.summary },
    };
  }

  /** The engines' name normalization, abridged (lowercase [a-z0-9_]). */
  private normalizeViewName(raw: string): string {
    let name = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (/^[0-9]/.test(name)) name = `t_${name}`;
    return name.slice(0, 64).replace(/_+$/, "");
  }

  async listViews(): Promise<View[]> {
    return this.views.map((v) => this.cloneView(v));
  }

  async createView(input: ViewCreateInput): Promise<View> {
    const name = this.normalizeViewName(input.name);
    if (!name) throw new Error("a view needs a name");
    if (this.views.some((v) => v.name === name)) {
      throw new Error(`a view named "${name}" already exists`);
    }
    if (!input.sql.trim()) throw new Error("only SELECT queries are allowed");
    const view: View = {
      id: `view-${(this.views.length + 1).toString(16).padStart(12, "0")}`,
      name,
      sql: input.sql,
      // Reads derivation is engine work (AST walk / textual scan); the mock
      // pins a naive binding so the record shape round-trips.
      reads: {
        files: input.fileIds.map((fileId) => ({ fileId, tableName: fileId })),
        views: [],
      },
      summary: { text: input.summaryText, source: input.summarySource },
      createdMs: Date.now(),
    };
    this.views.push(view);
    return this.cloneView(view);
  }

  async renameView(id: string, name: string): Promise<View> {
    const rec = this.views.find((v) => v.id === id);
    if (!rec) throw new Error("view not found");
    const dependents = this.views.filter((v) => v.reads.views.includes(id));
    if (dependents.length > 0) {
      throw new Error(
        `"${rec.name}" can't be renamed while other views read it: ${dependents
          .map((d) => d.name)
          .join(", ")}`,
      );
    }
    const normalized = this.normalizeViewName(name);
    if (!normalized) throw new Error("a view needs a name");
    if (this.views.some((v) => v.id !== id && v.name === normalized)) {
      throw new Error(`a view named "${normalized}" already exists`);
    }
    rec.name = normalized;
    return this.cloneView(rec);
  }

  async deleteView(id: string, cascade?: boolean): Promise<string[]> {
    const target = this.views.find((v) => v.id === id);
    if (!target) throw new Error("view not found");
    // Transitive dependents, grow-until-fixed (the engines' walk).
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const v of this.views) {
        if (!doomed.has(v.id) && v.reads.views.some((p) => doomed.has(p))) {
          doomed.add(v.id);
          grew = true;
        }
      }
    }
    const dependents = this.views.filter((v) => v.id !== id && doomed.has(v.id));
    if (dependents.length > 0 && !cascade) {
      throw new Error(
        `"${target.name}" can't be deleted while other views read it: ${dependents
          .map((d) => d.name)
          .join(", ")}`,
      );
    }
    const deleted = this.views.filter((v) => doomed.has(v.id)).map((v) => v.id);
    this.views = this.views.filter((v) => !doomed.has(v.id));
    return deleted;
  }

  async viewDependents(id: string): Promise<{ dependents: string[]; transitive: string[] }> {
    const direct = this.views.filter((v) => v.reads.views.includes(id)).map((v) => v.name);
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const v of this.views) {
        if (!doomed.has(v.id) && v.reads.views.some((p) => doomed.has(p))) {
          doomed.add(v.id);
          grew = true;
        }
      }
    }
    const transitive = this.views
      .filter((v) => v.id !== id && doomed.has(v.id))
      .map((v) => v.name);
    return { dependents: direct, transitive };
  }

  async inspectView(id: string): Promise<ViewInspection> {
    // Believable stored-state inspection so the UI agent can build the
    // inspector offline: the definition SQL, the labeled summary, the source
    // names from the stored reads (walked transitively through reads.views),
    // and the dependent lists — everything the engines return without
    // executing SQL. Unknown id → {} (the FileInspection precedent).
    const rec = this.views.find((v) => v.id === id);
    if (!rec) return {};
    // Transitive source files: own reads.files then every parent view's,
    // deduped in reads order (mirrors the engines' accumulation).
    const files: { fileId: string; tableName: string }[] = [];
    const seenViews = new Set<string>([id]);
    const walk = (v: View) => {
      for (const f of v.reads.files) {
        if (!files.some((k) => k.fileId === f.fileId)) files.push(f);
      }
      for (const pid of v.reads.views) {
        if (seenViews.has(pid)) continue;
        seenViews.add(pid);
        const parent = this.views.find((r) => r.id === pid);
        if (parent) walk(parent);
      }
    };
    walk(rec);
    const direct = this.views.filter((v) => v.reads.views.includes(id)).map((v) => v.name);
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const v of this.views) {
        if (!doomed.has(v.id) && v.reads.views.some((p) => doomed.has(p))) {
          doomed.add(v.id);
          grew = true;
        }
      }
    }
    const transitive = this.views.filter((v) => v.id !== id && doomed.has(v.id)).map((v) => v.name);
    return {
      id: rec.id,
      name: rec.name,
      sql: rec.sql,
      summary: rec.summary.text,
      summarySource: rec.summary.source,
      // The mock pins the fileId as the table name (see createView); a
      // believable inspection reflects it with a saved-age placeholder so the
      // inspector renders end to end offline.
      sources: files.map((f) => ({ fileId: f.fileId, name: f.tableName, savedAge: "just now" })),
      readsViews: rec.reads.views
        .map((vid) => this.views.find((r) => r.id === vid)?.name)
        .filter((n): n is string => !!n),
      localOnly: false,
      dependents: direct,
      transitiveDependents: transitive,
      createdMs: rec.createdMs,
    };
  }

  async shapeView(
    source: string,
    instruction: string,
    _fileIds: string[],
  ): Promise<ShapeViewResult> {
    // A canned proposal in the engine's exact shape (SQL + markdown sample
    // tables + a model-stated summary) — nothing is persisted here on ANY
    // implementation; saving goes through createView on the explicit Save.
    if (!source.trim()) throw new Error("a source table or view is required");
    if (!instruction.trim()) throw new Error("an instruction is required");
    return {
      available: true,
      sql: `SELECT * FROM ${source} WHERE amount IS NOT NULL`,
      before: "| region | amount |\n| --- | --- |\n| north | $3 |\n| south | $7 |",
      after: "| region | amount |\n| --- | --- |\n| north | 3 |\n| south | 7 |",
      summary: `${source} shaped — ${instruction}`.slice(0, 120),
    };
  }

  // Semantic layer (openspec: add-semantic-layer §6): a believable in-memory
  // metric/synonym store so the SemanticNav + Define-as-metric dialog drive
  // offline, mirroring the views mock's rules (name normalize, dup refusal,
  // dependent-synonym refusal/cascade). defineMetric answers {available:false}
  // to match the twin (SQL parsing is Rust-only — PARITY).
  private metrics: SemanticMetric[] = [];
  private synonyms: Synonym[] = [];

  private dependentSynonymTerms(metricName: string): string[] {
    return this.synonyms
      .filter((s) => s.canonical.toLowerCase() === metricName.toLowerCase())
      .map((s) => s.term);
  }

  async applicableSemantics(includedFileIds: string[]): Promise<SemanticCards> {
    // Metrics whose pinned source files intersect the included set (the engine's
    // applicability rule); localOnly is always false in the mock. Synonyms ride
    // when their canonical names a surfaced metric or names no metric at all.
    const inc = new Set(includedFileIds);
    const surfaced = this.metrics.filter((m) => m.reads.files.some((f) => inc.has(f.fileId)));
    const surfacedNames = new Set(surfaced.map((m) => m.name.toLowerCase()));
    const allNames = new Set(this.metrics.map((m) => m.name.toLowerCase()));
    return {
      metrics: surfaced.map((m) => ({
        id: m.id,
        name: m.name,
        expression: m.expression,
        description: m.description,
        entity: m.entity,
        localOnly: false,
      })),
      synonyms: this.synonyms
        .filter((s) => {
          const c = s.canonical.toLowerCase();
          return surfacedNames.has(c) || !allNames.has(c);
        })
        .map((s) => ({ ...s })),
      // §3.4 auto-derived proposals: the offline mock has no column catalog or
      // SQL-mining engine, so it surfaces none (the Rust engine fills these).
      suggestedSynonyms: [],
      suggestedMetrics: [],
    };
  }

  async createMetric(input: MetricCreateInput): Promise<SemanticMetric> {
    const name = this.normalizeViewName(input.name);
    if (!name) throw new Error("a metric needs a name");
    if (this.metrics.some((m) => m.name === name)) {
      throw new Error(`a metric named "${name}" already exists`);
    }
    if (!input.expression.trim()) throw new Error("a metric needs an expression");
    if (!input.entity.trim()) throw new Error("a metric needs an entity");
    const metric: SemanticMetric = {
      id: `metric-${(this.metrics.length + 1).toString(16).padStart(12, "0")}`,
      name,
      expression: input.expression,
      description: input.description,
      entity: input.entity,
      // Reads derivation is engine work; the mock pins a naive binding.
      reads: {
        files: input.fileIds.map((fileId) => ({ fileId, tableName: input.entity })),
        views: [],
      },
      summary: { text: input.summaryText, source: input.summarySource },
      createdMs: Date.now(),
    };
    this.metrics.push(metric);
    return { ...metric, reads: { files: [...metric.reads.files], views: [] }, summary: { ...metric.summary } };
  }

  async createSynonym(term: string, canonical: string): Promise<Synonym> {
    const t = term.trim();
    const c = canonical.trim();
    if (!t) throw new Error("a synonym needs a term");
    if (!c) throw new Error("a synonym needs a canonical name");
    if (this.synonyms.some((s) => s.term.toLowerCase() === t.toLowerCase())) {
      throw new Error(`a synonym for "${t}" already exists`);
    }
    const synonym: Synonym = { term: t, canonical: c };
    this.synonyms.push(synonym);
    return { ...synonym };
  }

  async renameMetric(id: string, name: string): Promise<SemanticMetric> {
    const rec = this.metrics.find((m) => m.id === id);
    if (!rec) throw new Error("metric not found");
    const deps = this.dependentSynonymTerms(rec.name);
    if (deps.length > 0) {
      throw new Error(`"${rec.name}" can't be renamed while synonyms map to it: ${deps.join(", ")}`);
    }
    const normalized = this.normalizeViewName(name);
    if (!normalized) throw new Error("a metric needs a name");
    if (this.metrics.some((m) => m.id !== id && m.name === normalized)) {
      throw new Error(`a metric named "${normalized}" already exists`);
    }
    rec.name = normalized;
    return { ...rec, reads: { files: [...rec.reads.files], views: [] }, summary: { ...rec.summary } };
  }

  async deleteMetric(id: string, cascade?: boolean): Promise<string> {
    const metric = this.metrics.find((m) => m.id === id);
    if (!metric) throw new Error("metric not found");
    const deps = this.dependentSynonymTerms(metric.name);
    if (deps.length > 0 && !cascade) {
      throw new Error(`"${metric.name}" can't be deleted while synonyms map to it: ${deps.join(", ")}`);
    }
    this.metrics = this.metrics.filter((m) => m.id !== id);
    this.synonyms = this.synonyms.filter(
      (s) => s.canonical.toLowerCase() !== metric.name.toLowerCase(),
    );
    return metric.id;
  }

  async deleteSynonym(term: string): Promise<void> {
    const before = this.synonyms.length;
    this.synonyms = this.synonyms.filter((s) => s.term.toLowerCase() !== term.toLowerCase());
    if (this.synonyms.length === before) throw new Error("synonym not found");
  }

  async defineMetric(_sql: string, _fileIds: string[]): Promise<DefineMetricResult> {
    // PARITY: proposing a metric parses the executed SQL (Rust-only), so the
    // mock — like the web dev twin — answers unavailable; the dialog explains.
    return {
      available: false,
      reason: "defining a metric from an answer runs in the Rust engine",
    };
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
