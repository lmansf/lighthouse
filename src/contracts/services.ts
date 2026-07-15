/**
 * RAG Vault - service interfaces.
 *
 * Features depend on these interfaces, never on a concrete implementation.
 * The mock implementations live in ./mocks and are swapped for real ones
 * (vector store, identity provider, model API) behind the same surface.
 */

import type {
  Briefing,
  BriefingReport,
  Cadence,
  ChangedPin,
  ChatChunk,
  ChatTurn,
  DataSource,
  FileNode,
  OnboardingState,
  Pin,
  PolicySnapshot,
  EgressSnapshot,
  AuditSnapshot,
  AuditVerdict,
  RagReference,
  RestoreToken,
  User,
} from "./types";

/** Curates which files/sources are exposed to retrieval, and runs retrieval. */
export interface RagService {
  /** List every source the user has connected. */
  listSources(): Promise<DataSource[]>;
  /** List the file tree, optionally scoped to a parent node. */
  listNodes(parentId?: string | null): Promise<FileNode[]>;
  /** Include or exclude a node (and, for folders/sources, its descendants). */
  setIncluded(nodeId: string, included: boolean): Promise<void>;
  /** Toggle whether a whole source is available. */
  setSourceAvailable(sourceId: string, available: boolean): Promise<void>;
  /** Retrieve references relevant to a query from the currently-included set. */
  search(query: string, includedFileIds: string[]): Promise<RagReference[]>;
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
   * Write a chat transcript (client-rendered markdown) as a note into
   * `Lighthouse Notes/` in the vault. Implemented in BOTH engines. Returns the
   * new file's id + final name (collision-suffixed, never overwrites).
   */
  exportChat(
    title: string,
    markdown: string,
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
   * primes the fresh pin's summary immediately.
   */
  pinAsk(
    question: string,
    sql: string,
    fileIds: string[],
  ): Promise<{ pin?: Pin; error?: string }>;
  /** Remove a pin (idempotent). */
  unpinAsk(id: string): Promise<void>;
  /** All pins, oldest first. */
  listPins(): Promise<Pin[]>;
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
}

/** Registration / sign-in. Mocked now; swap for a real identity provider later. */
export interface AuthService {
  getState(): OnboardingState;
  signIn(email: string, password: string): Promise<User>;
  register(name: string, email: string, password: string): Promise<User>;
  /** Advance past the welcome/registration step (whether submitted or skipped). */
  finishRegistration(): Promise<void>;
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
   * caller can keep the partial answer and settle its state.
   */
  ask(
    question: string,
    includedFileIds: string[],
    history?: ChatTurn[],
    attachmentFileIds?: string[],
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}
