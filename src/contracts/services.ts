/**
 * RAG Vault - service interfaces.
 *
 * Features depend on these interfaces, never on a concrete implementation.
 * The mock implementations live in ./mocks and are swapped for real ones
 * (vector store, identity provider, model API) behind the same surface.
 */

import type {
  Board,
  BoardCardRef,
  BoardCardRefresh,
  Briefing,
  BriefingReport,
  Cadence,
  ChangedPin,
  ChatChunk,
  ChatTurn,
  CurationRule,
  CurationRuleInput,
  DataSource,
  FileInspection,
  FileNode,
  Investigation,
  InvestigationCreateInput,
  OnboardingState,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
  RagReference,
  RecipeCard,
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
   * Pin an analytics answer (question + its exact SQL + files read) so the
   * engine watches it: vault changes re-run the SQL (guarded, model-free) and
   * alert when the computed result changes. Re-pinning the same SQL replaces
   * the pin; past the cap the error explains the limit. The desktop engine
   * primes the fresh pin's summary immediately. `investigationId` (openspec:
   * add-investigations) records the current investigation on the pin — its
   * membership; absent leaves the pin uncategorized, and a re-pin adopts the
   * new ask's investigation.
   */
  pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
    investigationId?: string,
  ): Promise<{ pin?: Pin; error?: string }>;
  /** Remove a pin (idempotent). */
  unpinAsk(id: string): Promise<void>;
  /**
   * All pins, oldest first. `investigationId` (openspec: add-investigations)
   * filters to the pins carrying that investigation; absent = all pins, the
   * original behavior.
   */
  listPins(investigationId?: string): Promise<Pin[]>;
  /**
   * Re-run every pin now (manual refresh). Returns the pins whose computed
   * result changed plus the refreshed list. PARITY: the web dev twin can't
   * execute SQL, so it reports no changes and returns the list unchanged.
   */
  recheckPins(): Promise<{ changed: ChangedPin[]; pins: Pin[] }>;
  /** All briefings, oldest first (add-briefings). */
  listBriefings(): Promise<Briefing[]>;
  /**
   * Create or replace a briefing: a titled, ordered set of pins run together
   * into one report. Re-saving the same title replaces it; past the cap the
   * error explains the limit.
   */
  saveBriefing(
    title: string,
    pinIds: string[],
    cadence: Cadence,
  ): Promise<{ briefing?: Briefing; error?: string }>;
  /** Remove a briefing (idempotent). */
  removeBriefing(id: string): Promise<void>;
  /**
   * Run a briefing now: re-execute each pin's SQL and compose the report.
   * PARITY: the web dev twin can't execute SQL, so it composes from each pin's
   * last known summary. `undefined` when the id is unknown.
   */
  runBriefing(id: string): Promise<BriefingReport | undefined>;
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
   * packaged desktop app, where filesystem-backed actions (opening a cited file
   * natively, linking by path) work; a plain web deployment reports false so the
   * UI can hide affordances the server would refuse.
   */
  capabilities(): Promise<{ desktop: boolean }>;
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
   * G5: refresh the "Lighthouse Briefing" note (Lighthouse Notes/) from the pins
   * that changed, on demand. Returns the written file's id and name, or an
   * `error`. Desktop rechecks each pin's SQL for a real before→after; the web
   * dev twin composes from each pin's last known summary (no before).
   */
  refreshBriefingNote(): Promise<{ savedId?: string; savedName?: string; error?: string }>;
  /**
   * Investigations (openspec: add-investigations): named, durable containers
   * for analysis. Every record in creation order — the caller filters
   * archived ones (archive hides, never deletes). `pinRefs`/`noteRefs` come
   * back derived by the engine at read time (pins carrying the id; files
   * under the investigation's notes folder).
   */
  listInvestigations(): Promise<Investigation[]>;
  /**
   * Create an investigation. The engine mints the id, stamps creation time,
   * fixes the sanitized notes folder name, and validates: non-empty name,
   * unique case-insensitively (archived records count). Empty/absent
   * `scopeFileIds` = whole vault. A validation rejection comes back as
   * `error` with the engine's reason (like addRule), so the create form can
   * surface it inline.
   */
  createInvestigation(
    input: InvestigationCreateInput,
  ): Promise<{ investigation?: Investigation; error?: string }>;
  /**
   * Rename an investigation — same uniqueness rule as create (a case change
   * of its own name is allowed). The notes `folderName` deliberately does
   * NOT move: membership = location, and rename moves nothing.
   */
  renameInvestigation(
    id: string,
    name: string,
  ): Promise<{ investigation?: Investigation; error?: string }>;
  /**
   * Archive or unarchive — a visibility flag only. Nothing cascades or is
   * deleted: pins, notes, scope, and conversation refs stay untouched, and
   * unarchiving restores the investigation fully.
   */
  setInvestigationArchived(
    id: string,
    archived: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }>;
  /**
   * Record a conversation ref (an opaque client Conversation.id — never a
   * transcript). The engine accepts it only when `persistAllowed` (the
   * client's history verdict: persistEnabled && !chatHistoryLocked(), the
   * same value the ask path sends) AND the managed policy allow history;
   * either false ⇒ a silent no-op — the returned record simply lacks the
   * ref. Refs dedupe.
   */
  addInvestigationConversationRef(
    id: string,
    conversationId: string,
    persistAllowed: boolean,
  ): Promise<{ investigation?: Investigation; error?: string }>;
  /**
   * Boards (openspec: add-boards): pin-backed local dashboards.
   * `investigationId` filters to that investigation's boards; absent = all
   * boards (the listPins convention). A scope with no persisted board
   * returns its VIRTUAL default (deterministic `default-…` id, empty cards,
   * `createdMs` 0) — mutating that id materializes it engine-side.
   */
  listBoards(investigationId?: string): Promise<Board[]>;
  /**
   * Create a board in the global scope (absent/blank `investigationId`) or
   * inside an investigation. The engine mints the id, stamps creation time,
   * and validates: non-empty name, unique case-insensitively WITHIN the
   * scope. A validation rejection comes back as `error` with the engine's
   * reason (like createInvestigation), so the form can surface it inline.
   */
  createBoard(
    name: string,
    investigationId?: string,
  ): Promise<{ board?: Board; error?: string }>;
  /**
   * Rename a board — same per-scope uniqueness rule as create (a case
   * change of its own name is allowed). Renaming a virtual default
   * materializes it under the new name, keeping the deterministic id.
   */
  renameBoard(id: string, name: string): Promise<{ board?: Board; error?: string }>;
  /**
   * Delete a board. Deleting a scope's default (virtual or materialized) is
   * effectively a reset — the next listing synthesizes a fresh empty
   * default for the scope. Cards are references: no pin is ever touched.
   */
  deleteBoard(id: string): Promise<{ ok?: boolean; error?: string }>;
  /**
   * Replace a board's card list wholesale — the ONE mutation for reorder,
   * resize, add, and remove alike (atomic full-list replace). Pin ids are
   * not validated against pins (tombstone-tolerant); sizes must be S|M|L.
   * Targeting a virtual default id materializes it with these cards.
   */
  setBoardCards(
    id: string,
    cards: BoardCardRef[],
  ): Promise<{ board?: Board; error?: string }>;
  /**
   * Refresh a board's cards, one answer per requested pin. Desktop re-runs
   * each pin's stored SQL through the guarded model-free direct path (a
   * manual refresh IS a recheck — the pin's stored digest/summary advance)
   * and answers `live: true`; the web dev twin can't execute SQL (PARITY)
   * and answers `live: false` with each pin's stored state. Unknown pins
   * answer `tombstone: true`.
   */
  refreshBoardCards(pinIds: string[]): Promise<BoardCardRefresh[]>;
  /**
   * Shaped views (openspec: add-shaped-views): every saved view, creation
   * order. Views are named, guarded SELECTs stored as definitions and
   * resolved virtually at ask time — never materialized rows.
   */
  listViews(): Promise<View[]>;
  /**
   * Create a view. The ENGINE owns every rule — name sanitization, the
   * single-read-only-SELECT guard, reads derivation, cycle/depth caps, and
   * collision checks — and refusals THROW with the engine's human-readable
   * reason so the dialogs can show it verbatim (the UI never re-validates
   * beyond trimming). Nothing persists on refusal.
   */
  createView(input: ViewCreateInput): Promise<View>;
  /**
   * Rename a view — refused (throws, with the dependent names in the
   * message) while other views read it; otherwise a pure store update that
   * keeps the id and every stored dependency binding.
   */
  renameView(id: string, name: string): Promise<View>;
  /**
   * Delete a view. Refused (throws, naming the transitive dependents) while
   * dependents exist unless `cascade` — sent only after the UI's explicit
   * confirmation showing that list. Returns the deleted ids. Sources are
   * never touched by any path.
   */
  deleteView(id: string, cascade?: boolean): Promise<string[]>;
  /**
   * The views that read `id`: `dependents` directly (what the rename refusal
   * names), `transitive` the whole downstream set (what the cascade
   * confirmation must show) — name lists for the dialogs.
   */
  viewDependents(id: string): Promise<{ dependents: string[]; transitive: string[] }>;
  /**
   * Inspect a saved view (openspec: add-shaped-views §4): the exact definition
   * SQL, the provenance-labeled summary, the source files it reads
   * (transitively) with their saved-age freshness, the effectively-local-only
   * flag, and the dependent names. Pure stored-state read — no SQL executes, so
   * BOTH engines return the identical shape. An unknown id returns `{}`.
   */
  inspectView(id: string): Promise<ViewInspection>;
  /**
   * Shaping ask (openspec: add-shaped-views §3): ONE engine-guarded model
   * completion proposes a transform SELECT over `source` (a registered table
   * or saved view name), evidenced with engine-rendered before/after sample
   * rows. Returns the proposal, or `{available:false}` with an honest reason
   * (extractive/no-model provider; ALWAYS on the web dev twin — PARITY).
   * Refusals — unknown source, guard rejection, the model's own refusal —
   * throw with the engine's reason so the dialog shows it; retry is free.
   * NOTHING persists until `createView` runs on the user's explicit Save.
   */
  shapeView(source: string, instruction: string, fileIds: string[]): Promise<ShapeViewResult>;
  /**
   * The semantic definitions (openspec: add-semantic-layer §6) applicable to the
   * included set, posture-gated — metrics whose tables are in scope plus their
   * synonyms, for the SemanticNav. A metric over a file the chat isn't showing
   * never surfaces (the applicableRecipes rule); a local-only metric is absent on
   * a cloud ask. PARITY: `list` needs no analytics, so BOTH engines compute the
   * identical subset (unlike recipes, which the twin returns [] for). Empty when
   * nothing matches.
   */
  applicableSemantics(includedFileIds: string[]): Promise<SemanticCards>;
  /**
   * Create a metric (openspec §6.1). The ENGINE owns every rule — name
   * sanitization, the read-only aggregation guard, reads derivation, the
   * name-shadow check — and refusals THROW with the engine's human-readable
   * reason so the dialog shows it verbatim. Nothing persists on refusal.
   */
  createMetric(input: MetricCreateInput): Promise<SemanticMetric>;
  /**
   * Create a synonym: a colloquial `term` mapped to a canonical column or metric
   * `canonical`. Unique case-insensitively; refusals throw the engine's reason.
   */
  createSynonym(term: string, canonical: string): Promise<Synonym>;
  /**
   * Rename a metric — refused (throws, naming the dependent synonyms) while any
   * synonym maps to it; otherwise a pure store update keeping the id and reads.
   */
  renameMetric(id: string, name: string): Promise<SemanticMetric>;
  /**
   * Delete a metric. Refused (throws, naming the dependent synonyms) while
   * synonyms map to it unless `cascade` — sent only after the UI's explicit
   * confirmation showing that list; cascade removes the metric and its synonyms
   * in one write. Returns the deleted metric id. Sources are never touched.
   */
  deleteMetric(id: string, cascade?: boolean): Promise<string>;
  /** Delete a synonym by its term (case-insensitive). Throws if unknown. */
  deleteSynonym(term: string): Promise<void>;
  /**
   * Propose a metric from a Beam answer's SQL (openspec §6.1 — the "Save as view"
   * precedent): the engine parses the executed SQL and proposes an aggregate
   * expression + entity the "Define as metric" dialog shows before the user names
   * and saves it (via createMetric). `{available:false}` with an honest reason
   * when there's no single-table aggregate — and ALWAYS on the web dev twin
   * (SQL parsing is Rust-only — PARITY).
   */
  defineMetric(sql: string, fileIds: string[]): Promise<DefineMetricResult>;
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
