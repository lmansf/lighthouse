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
  Attachment,
  FileInspection,
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
  SigninPoll,
  SigninStart,
  SigninStatus,
} from "./types";

/** Curates which files/sources are exposed to retrieval, and runs retrieval. */
export interface RagService {
  /**
   * A conversation's attachments, in attach order (openspec:
   * refocus-chat-attachments). This IS the corpus: since 0.15.0 there is no
   * tree, no inclusion gate, and no per-file cloud mark — attaching a file to
   * a chat is the whole decision, and detaching removes it from the ask.
   */
  listAttachments(conversationId: string): Promise<Attachment[]>;
  /** Remove one attachment from a conversation (its bytes are swept later). */
  detach(conversationId: string, fileId: string): Promise<void>;
  /** Retrieve references relevant to a query from a conversation's attachments. */
  search(conversationId: string, query: string, attachmentIds?: string[]): Promise<RagReference[]>;
  /**
   * Read-only inspection of a single file ("What the AI sees", openspec:
   * add-file-inspector): what the engine extracted, chunked, catalogued, and
   * indexed for one ATTACHMENT — and, when `query` is given, a bounded,
   * file-scoped test-search (the file's top chunks with scores, via the
   * existing retrieval scorer). PURE READ; since 0.15.0 the panel it feeds
   * surfaces no toggles at all, so inspecting cannot change what an ask sees.
   * PARITY: the web dev twin omits the Rust-engine-only fields (OCR flag,
   * persisted chunk count, column catalog, last-indexed key) rather than faking
   * them; the UI renders those "desktop only".
   */
  inspect(conversationId: string, fileId: string, query?: string): Promise<FileInspection>;
  /**
   * §49: read a saved report's FULL markdown by its id — the
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
   * With `saveAs` (a name hint), the same run also renders a full-fidelity CSV
   * (bounded by the engine's save cap) and RETURNS it as `content` alongside a
   * `savedName` and the exported `rows` count — the caller hands it to the OS
   * save dialog. Before 0.15.0 the engine wrote it into a vault folder itself.
   */
  analyticsSql(
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
  }>;
  /**
   * Hand a client-composed artifact BACK for the OS save dialog — the chat
   * transcript as markdown, or the analytics evidence pack as self-contained
   * HTML. Before 0.15.0 the engine WROTE it into a `Lighthouse Notes/` or
   * `Lighthouse Results/` vault folder; with the vault gone an export belongs
   * to the user's filesystem, not the app's, and the save dialog is the
   * permission. `ext` stays a STRICT engine-side allowlist ("md"|"html") — the
   * client can never name an arbitrary extension. Implemented in BOTH engines.
   */
  exportChat(
    title: string,
    markdown: string,
    options?: { ext?: "md" | "html" },
  ): Promise<{ savedName?: string; content?: string; error?: string }>;
  /**
   * Engine-derived example questions for the chat empty state: each names real
   * columns of a real included tabular file, so the analytics path can answer
   * it ("Total amount by region in sales.csv"). `label` is the chip text,
   * `question` the full ask submitted on tap. Empty when nothing tabular is
   * included (or on the web dev twin — the column catalog is desktop-only), in
   * which case the UI keeps its static empty-state hint.
   */
  suggestedAsks(
    conversationId: string,
    attachmentIds: string[],
  ): Promise<{ label: string; question: string }[]>;
  /**
   * Recipes applicable to the included set (openspec: add-recipes §2), for the
   * Library gallery and the empty-state recipe chips. Each card names the file
   * (display name) or view (name) it runs on; tapping it seeds the chat with the
   * recipe-cued question (see `runRecipeQuestion`). Empty when nothing matches
   * (or on the web dev twin — recipes are Rust-engine-only, so it returns []).
   */
  applicableRecipes(conversationId: string, attachmentIds: string[]): Promise<RecipeCard[]>;
  /**
   * The capability map (openspec: add-deep-analysis §3): the analyzable tables +
   * their recipes/metrics/asks + one "Investigate {table}" per Date+Numeric table
   * for the included set — a single "what can I do" view. A pure aggregate of the
   * posture-gated `applicable_*` surfaces. Empty on the web dev twin (Rust-only).
   */
  capabilityMap(conversationId: string, attachmentIds: string[]): Promise<CapabilityMap>;
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
   * Render the current audit log as CSV and hand it back for the OS save
   * dialog — the same door as chat export. `error` on failure.
   */
  auditExport(): Promise<{ savedName?: string; content?: string; error?: string }>;

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
   * panel; recomputed on show and when the conversation's attachments change,
   * never a background poll.
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
 * mode → model and unlocks the app. The vault (pick a folder) and
 * default-inclusion steps retired with the vault in 0.15.0.
 */
export interface AuthService {
  getState(): OnboardingState;
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
   * The conversation this ask belongs to (openspec:
   * refocus-chat-attachments): its attachments ARE the corpus the engine
   * answers from. Absent = an EMPTY corpus, never a fallback to anything else.
   */
  conversationId?: string;
}

/** Streams an assistant answer plus its references for a user question. */
export interface ChatService {
  /**
   * Ask a question over the conversation's attachments (`opts.conversationId`
   * names it — that IS the corpus since 0.15.0). Yields incremental chunks; the
   * final chunk carries `done: true` and the resolved references. `history`
   * carries prior turns so follow-up questions ("tell me more about the second
   * one") resolve against the ongoing conversation. `attachmentFileIds` narrows
   * to a per-question SUBSET; empty means all of them. An aborted `signal`
   * cancels the in-flight request (the chat UI's Stop button); implementations
   * should surface the abort by throwing (an `AbortError` DOMException) so the
   * caller can keep the partial answer and settle its state. `opts` carries the
   * per-ask answer-cache controls (see AskOptions).
   */
  ask(
    question: string,
    history?: ChatTurn[],
    attachmentFileIds?: string[],
    signal?: AbortSignal,
    opts?: AskOptions,
  ): AsyncIterable<ChatChunk>;
}
