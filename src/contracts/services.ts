/**
 * RAG Vault - service interfaces.
 *
 * Features depend on these interfaces, never on a concrete implementation.
 * The mock implementations live in ./mocks and are swapped for real ones
 * (vector store, identity provider, model API) behind the same surface.
 */

/**
 * Form factor of the running shell, reported by the engine on every
 * capability surface (settings + rag list). Distinct from `desktop: boolean`,
 * which means "embedded shell" (true on iOS too) and stays for compat.
 */
export type PlatformKind = "desktop" | "ios" | "android";

/**
 * The structured shape for a deep-analysis report (openspec: add-report-templates).
 * `"imrad"` → Scientific method (Introduction/Methods/Results/Discussion);
 * `"bluf"` → Business report (Bottom line up front + Minto pyramid). Omitting the
 * argument yields the Standard deterministic report. The wire values match the
 * Rust `ReportTemplate::from_wire` parser. Rust-only, like the whole report engine.
 */
export type ReportTemplate = "imrad" | "bluf";

/**
 * §49 §4: one saved report's listing row for the Reports home library. `id` is
 * the report's filename in the engine's reports directory (feed it to
 * `readNote` / the reader open event), `name` the display filename, and
 * `generatedAtMs` the file's save time (epoch ms) that orders the list
 * newest-first. Rust-engine-only, like the whole report engine; the web dev
 * twin has no reports, so `listReports` returns `[]`.
 */
export interface ReportSummary {
  id: string;
  name: string;
  generatedAtMs: number;
}

import type {
  ChatChunk,
  ChatTurn,
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
  InsightsScan,
  InvestigationCreateInput,
  OnboardingState,
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
} from "./types";

/** Curates which files/sources are exposed to retrieval, and runs retrieval. */
export interface RagService {
  /** List every source the user has connected. */
  listSources(): Promise<DataSource[]>;
  /** List the file tree, optionally scoped to a parent node. */
  listNodes(parentId?: string | null): Promise<FileNode[]>;
  /** Include or exclude a node (and, for folders/sources, its descendants). */
  setIncluded(nodeId: string, included: boolean): Promise<void>;
  /**
   * Mark or unmark a node "Private — this device only" (ancestor-wins). A marked
   * node participates in on-device answers but is withheld from anything a cloud
   * provider would receive. Writes only the target's own flag (no descendant
   * cascade); resolution covers the subtree.
   */
  setLocalOnly(nodeId: string, localOnly: boolean): Promise<void>;
  /**
   * Bulk curation rules (openspec: add-curation-rules): every stored rule,
   * enriched with its generated display name, human scope label, and orphaned
   * flag (scope folder gone — matches nothing, kept for cleanup). Rules are a
   * RESOLUTION layer: they decide matching files — present and future — where
   * no explicit per-node flag speaks, and never write per-node state.
   */
  listRules(): Promise<CurationRule[]>;
  /**
   * Create a rule (the engine mints the id and validates: action/kind
   * whitelists, exactly one predicate, glob parse). A validation rejection
   * comes back as `error` with the engine's reason rather than a throw, so
   * the create form can surface it inline.
   */
  addRule(rule: CurationRuleInput): Promise<{ rule?: CurationRule; error?: string }>;
  /**
   * Remove a rule (idempotent). Only the rule's layer disappears: every file
   * it was deciding reverts to the next layer down; explicit per-node flags
   * are untouched by construction.
   */
  removeRule(id: string): Promise<void>;
  /** Toggle whether a whole source is available. */
  setSourceAvailable(sourceId: string, available: boolean): Promise<void>;
  /** Retrieve references relevant to a query from the currently-included set. */
  search(query: string, includedFileIds: string[]): Promise<RagReference[]>;
  /**
   * Read-only inspection of a single file ("What the AI sees", openspec:
   * add-file-inspector): what the engine extracted, chunked, catalogued, and
   * indexed for it, plus its effective inclusion + local-only state — and, when
   * `query` is given, a bounded, file-scoped test-search (the file's top chunks
   * with scores, via the existing retrieval scorer). PURE READ — it surfaces the
   * inclusion + local-only toggles, never mutates. PARITY: the web dev twin omits
   * the Rust-engine-only fields (OCR flag, persisted chunk count, column catalog,
   * last-indexed key) rather than faking them; the UI renders those "desktop only".
   */
  inspect(fileId: string, query?: string): Promise<FileInspection>;
  /**
   * §49: read a saved report note's FULL markdown by its vault node id — the
   * backing for the in-app report reader. Returns the RAW markdown (the
   * ```lighthouse-chart fence intact, so the reader draws the key chart) + the
   * note name. PURE READ. Desktop engine only; the web dev twin returns its
   * mock saved note. `markdown` is empty for an unknown/removed id.
   */
  readNote(id: string): Promise<{ markdown: string; name: string }>;
  /**
   * §49 §4: list every saved report for the Reports home library, NEWEST-FIRST
   * (by save time). A report is a `.md` in the engine's reports directory —
   * the app's own store, so every file there is one. PURE READ. Desktop engine
   * only; the web dev twin has no report engine and returns `[]`.
   */
  listReports(): Promise<ReportSummary[]>;
  /**
   * Re-run an analytics answer's SQL over exactly the files it read — the
   * guarded, model-free path behind Edit SQL. Returns the (capped) result
   * table, the chart spec when chartable, and the provenance footer; a guard
   * rejection or engine failure comes back as `error`. Desktop engine only —
   * the web dev twin answers with an explanatory error.
   *
   * With `saveAs` (a name hint), the same run also writes a full-fidelity CSV
   * (bounded by the engine's save cap) into `Lighthouse Results/` in the
   * vault — an ordinary file the watcher ingests — and the result additionally
   * carries `savedId`, `savedName`, and the exported `rows` count.
   */
  analyticsSql(
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
  }>;
  /**
   * Write a client-composed artifact into the vault. Implemented in BOTH
   * engines. Default (no options): a chat-transcript markdown note into
   * `Lighthouse Notes/` — the original exportChat behavior, unchanged. With
   * `options`, the SAME sanitized write op routes other client-composed
   * artifacts — today the analytics evidence pack (a self-contained HTML file
   * into `Lighthouse Results/`). `subdir`/`ext` are a STRICT engine-side
   * allowlist ("Lighthouse Notes"|"Lighthouse Results"; "md"|"html") — the
   * client can never name arbitrary folders or extensions. Returns the new
   * file's id + final name (collision-suffixed, never overwrites).
   *
   * `investigationId` (openspec: add-investigations): when an investigation
   * is current, pass its id and the NOTES destination becomes the
   * investigation's own folder — `Lighthouse Notes/<folderName>/`, with the
   * folder resolved ENGINE-SIDE from the store (the client never names it).
   * An explicit "Lighthouse Results" subdir (the evidence pack) is
   * unaffected; an unknown id comes back as `error`.
   */
  exportChat(
    title: string,
    markdown: string,
    options?: {
      subdir?: "Lighthouse Notes" | "Lighthouse Results";
      ext?: "md" | "html";
      investigationId?: string;
    },
  ): Promise<{ savedId?: string; savedName?: string; error?: string }>;
  /**
   * G6: auto-export a conversation as an indexed vault note under
   * `Lighthouse Notes/Chats/`, OVERWRITTEN in place per conversation id so the
   * vault keeps one current note per chat. Client-gated on "Save chats on this
   * device". Fire-and-forget on turn settle.
   */
  exportConversationNote(
    conversationId: string,
    title: string,
    markdown: string,
  ): Promise<{ savedId?: string; savedName?: string; error?: string }>;
  /** G6 fail-closed opt-out: delete every auto-exported chat note. */
  purgeConversationNotes(): Promise<{ ok?: boolean; error?: string }>;
                  /**
   * Engine-derived example questions for the chat empty state: each names real
   * columns of a real included tabular file, so the analytics path can answer
   * it ("Total amount by region in sales.csv"). `label` is the chip text,
   * `question` the full ask submitted on tap. Empty when nothing tabular is
   * included (or on the web dev twin — the column catalog is desktop-only), in
   * which case the UI keeps its static empty-state hint.
   */
  suggestedAsks(includedFileIds: string[]): Promise<{ label: string; question: string }[]>;
  /**
   * Recipes applicable to the included set (openspec: add-recipes §2), for the
   * Library gallery and the empty-state recipe chips. Each card names the file
   * (display name) or view (name) it runs on; tapping it seeds the chat with the
   * recipe-cued question (see `runRecipeQuestion`). Empty when nothing matches
   * (or on the web dev twin — recipes are Rust-engine-only, so it returns []).
   */
  applicableRecipes(includedFileIds: string[]): Promise<RecipeCard[]>;
  /**
   * The capability map (openspec: add-deep-analysis §3): the analyzable tables +
   * their recipes/metrics/asks + one "Investigate {table}" per Date+Numeric table
   * for the included set — a single "what can I do" view. A pure aggregate of the
   * posture-gated `applicable_*` surfaces. Empty on the web dev twin (Rust-only).
   */
  capabilityMap(includedFileIds: string[]): Promise<CapabilityMap>;
  /**
   * Link a file or folder by its real absolute path instead of copying it into
   * the vault (reduces duplication). Returns the new node id. Desktop-only —
   * the browser has no access to real filesystem paths.
   */
  addReference(path: string): Promise<{ id: string; kind: "file" | "folder" }>;
  /** Remove a reference (unlink); the real files on disk are left untouched. */
  removeReference(refId: string): Promise<void>;
  /**
   * Move a node under a new parent folder within the same source (a vault-
   * internal reparent), or to the source root when `toParentId` is null. The
   * node's AI-visibility flags travel with it. Returns the node's new id (ids
   * are path-derived, so a move renames the id). Throws if the destination
   * already holds a same-named item, or the source can't move (e.g. cloud).
   */
  moveNode(fromId: string, toParentId: string | null): Promise<{ newId: string }>;
  /** Rename a node in place (same parent, new basename). Returns the new id. */
  renameNode(id: string, newName: string): Promise<{ newId: string }>;
  /** Create an empty folder under a parent (or the vault root, null). */
  createFolder(parentId: string | null, name: string): Promise<{ newId: string }>;
  /**
   * Remove a node from the vault, non-destructively: a linked item unlinks, a
   * vault-resident item moves to a recoverable trash. Throws on failure.
   * Returns a token that `restoreFromVault` can replay to undo the removal.
   */
  removeFromVault(nodeId: string): Promise<RestoreToken>;
  /** Undo a removeFromVault from the token it returned. Throws on failure. */
  restoreFromVault(token: RestoreToken): Promise<void>;
  /**
   * Capabilities of the running deployment. `desktop` is true only in the
   * packaged shell (desktop OR mobile — it means "embedded shell", and the
   * engine relies on it on iOS too), where filesystem-backed actions work; a
   * plain web deployment reports false so the UI can hide affordances the
   * server would refuse. `platform` is the §1 form-factor signal — the ONE
   * value UI platform gates key off (no UA sniffing, no window-size proxies).
   */
  capabilities(): Promise<{ desktop: boolean; platform: PlatformKind }>;
  /**
   * Read-only snapshot of the machine-scope managed policy: which settings an
   * org-deployed policy.json locks. The UI disables the matching controls and
   * labels them "Managed by your organization"; an unmanaged install reports
   * `present: false` with all-permissive locks.
   */
  policy(): Promise<PolicySnapshot>;
  /**
   * Session egress snapshot (S3): what has left this machine this session,
   * grouped by destination host + purpose. Drives the header shield ("All
   * local" / "N requests to <host>") and its detail panel.
   */
  egress(): Promise<EgressSnapshot>;
  /**
   * Recent audit records (openspec: add-audit-log) plus the enabled + chain-
   * intact verdict, newest first. `limit` caps how many records come back
   * (default 100). Backs the audit-log viewer under Settings.
   */
  audit(limit?: number): Promise<AuditSnapshot>;
  /**
   * Explicitly verify the audit chain — `intact` plus the first broken index
   * when tampered. The viewer calls this behind its "Verify integrity" action;
   * the TS twin has no chain and always reports intact (PARITY).
   */
  auditVerify(): Promise<AuditVerdict>;
  /**
   * Export the current audit log to a CSV file inside the vault (via the same
   * sanitized artifact-write path as chat export), returning the new file's id
   * and name, or an `error` string on failure.
   */
  auditExport(): Promise<{ savedId?: string; savedName?: string; error?: string }>;

  /**
   * Proactive insights (openspec: add-quant-depth §5): run the cheap
   * deterministic detectors (the anomaly z-score, top-movers, and changepoint)
   * over the cataloged tables and return the ranked, bounded findings plus the
   * scan's coverage — what stands out WITHOUT the user asking. Takes no arguments
   * (the engine scans its own catalog, bounded by a hard cap). Every headline is
   * engine-computed and rendered verbatim; `tablesScanned` < `tablesAvailable`
   * discloses the cap. PARITY: the scan is Rust-only (DataFusion), so the web dev
   * twin answers an empty scan rather than a fabricated one — the panel then
   * honestly shows "nothing stands out". Backs the proactive "What stands out"
   * panel; recomputed on show and on the vault-change signal, never a background
   * poll.
   */
  insights(): Promise<InsightsScan>;
  /**
   * Deep analysis (openspec: add-deep-analysis §2): run the applicable recipe
   * battery over `table`, assemble the verified results into a report, and save
   * it as markdown in the engine's reports directory — returns its id + name so
   * the caller can open the reader on it. Rust-only (DataFusion + recipes); the
   * web dev twin throws (unavailable).
   *
   * `template` (openspec: add-report-templates) optionally prescribes a
   * structured shape — `"imrad"` (Scientific method: Introduction/Methods/
   * Results/Discussion) or `"bluf"` (Business report: Bottom line up front +
   * Minto pyramid). Omitted ⇒ the Standard deterministic report (byte-identical
   * to before). The engine numbers are unchanged either way; a template only
   * adds model-narrated FRAMING over the same verified findings. §46: an optional
   * `hypothesis` seeds that framing's angle only — never a figure (the report's
   * digit gate is unchanged).
   */
  investigate(
    table: string,
    template?: ReportTemplate,
    hypothesis?: string,
  ): Promise<{ savedId: string; savedName: string }>;
  /**
   * Provider sign-in (0.12.1 §3): status of the generic, registration-gated
   * OAuth device flow. `available` is false on a stock build (no endpoints
   * or client id are configured until a maintainer registers with the
   * vendor), on the web twin, and under any partial configuration — never
   * render a sign-in affordance while it is false.
   */
  providerAuthStatus(): Promise<SigninStatus>;
  /**
   * Begin a device-authorization sign-in. `error` carries the honest reason
   * (unconfigured build, vendor refusal) instead of a throw so the dialog
   * surfaces it inline — the addRule/pinAsk idiom.
   */
  providerAuthStart(): Promise<{ start?: SigninStart; error?: string }>;
  /** Poll the started sign-in once; drive it at the returned interval. */
  providerAuthPoll(): Promise<SigninPoll>;
  /** Drop the signed-in session — sealed tokens removed engine-side. */
  providerAuthSignout(): Promise<void>;
  /**
   * Persist how the OpenAI provider authenticates. "key" (the default)
   * always saves; "signin" is registration-gated like the flow it arms and
   * comes back as `error` on a build where sign-in isn't configured.
   */
  providerAuthSetMethod(method: "key" | "signin"): Promise<{ ok?: boolean; error?: string }>;
}

/**
 * Local single-user onboarding progression. First run collects no identity
 * (no email/registration, no licensing); it just walks the user through
 * vault → mode → model → default-inclusion and unlocks the app.
 */
export interface AuthService {
  getState(): OnboardingState;
  /** Advance past the vault (welcome) step to the interface-mode chooser. */
  finishVault(): Promise<void>;
  /** Advance past the window/widget mode step (auto-skipped on the web twin). */
  finishMode(): Promise<void>;
  selectModel(providerId: string, modelId: string, apiKey: string): Promise<void>;
  /**
   * Live-test an API key against its provider (a cheap authenticated model-list
   * GET, engine-side so the key never has to work from the browser). An empty
   * `apiKey` tests the key already on file for that provider. Never persists
   * anything — pair with `selectModel` to save.
   */
  validateKey(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }>;
  /** Set whether newly-added files are searchable by default (chosen at onboarding). */
  setDefaultInclusion(value: "include" | "exclude"): Promise<void>;
  completeOnboarding(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Per-ask answer-cache controls (openspec: add-answer-cache), computed by the
 * CLIENT per request and carried on the wire. `bypassCache` is the Re-run /
 * Regenerate gesture: skip the cache lookup, run live, refresh the entry.
 * `persistAllowed` is the chat-history verdict — `persistEnabled() &&
 * !chatHistoryLocked()` at the moment of the ask — which gates the engine's
 * DISK cache mirror (history opt-in is client-only state by design, so the
 * engines only ever learn a per-request verdict). Both default false: an
 * absent field fails toward privacy (in-memory cache only, disk mirror
 * deleted).
 */
export interface AskOptions {
  bypassCache?: boolean;
  persistAllowed?: boolean;
  /**
   * The investigation this ask runs inside (openspec: add-investigations).
   * Engine-resolved: a non-empty scope becomes the ask's attachments unless
   * explicit `attachmentFileIds` are passed (most-specific wins), and a
   * local-only policy forces the private path at the model-config chokepoint.
   * Absent = the global context.
   */
  investigationId?: string;
  /**
   * The conversation this ask belongs to (openspec:
   * refocus-chat-attachments): its attachments ARE the corpus the engine
   * answers from. Absent = the legacy vault corpus, until the vault goes.
   */
  conversationId?: string;
}

/** Streams an assistant answer plus its references for a user question. */
export interface ChatService {
  /**
   * Ask a question against the included file set. Yields incremental chunks;
   * the final chunk carries `done: true` and the resolved references. `history`
   * carries prior turns so follow-up questions ("tell me more about the second
   * one") resolve against the ongoing conversation. When `attachmentFileIds` is
   * non-empty the answer is scoped to just those files (the user attached them to
   * this question), regardless of the global included set. An aborted `signal`
   * cancels the in-flight request (the chat UI's Stop button); implementations
   * should surface the abort by throwing (an `AbortError` DOMException) so the
   * caller can keep the partial answer and settle its state. `opts` carries the
   * per-ask answer-cache controls (see AskOptions).
   */
  ask(
    question: string,
    includedFileIds: string[],
    history?: ChatTurn[],
    attachmentFileIds?: string[],
    signal?: AbortSignal,
    opts?: AskOptions,
  ): AsyncIterable<ChatChunk>;
}
