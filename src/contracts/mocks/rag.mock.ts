import type { RagService } from "../services";
import type {
  Briefing,
  BriefingReport,
  Cadence,
  ChangedPin,
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
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
    options?: { subdir?: "Lighthouse Notes" | "Lighthouse Results"; ext?: "md" | "html" },
  ): Promise<{ savedId?: string; savedName?: string; error?: string }> {
    await new Promise((r) => setTimeout(r, 150));
    if (!markdown.trim()) return { error: "markdown required" };
    // Mirror the engines' strict allowlist so a bad caller fails offline too.
    const subdir = options?.subdir ?? "Lighthouse Notes";
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
