/**
 * RAG Vault - shared domain types.
 *
 * This file is the contract every feature team codes against. Treat it as
 * append-only / backwards-compatible: changing a shape here ripples into
 * shell, onboarding, explorer, and chat. Coordinate before breaking it.
 */

/** A top-level source of documents the user can expose (or hide) from RAG. */
export interface DataSource {
  id: string;
  name: string;
  kind: "database" | "folder";
  /** Whether the source as a whole is available to the RAG system. */
  available: boolean;
}

/** A node in the file tree: a database, a folder, or a single file. */
export interface FileNode {
  id: string;
  /** Parent node id, or null for a top-level node under its source. */
  parentId: string | null;
  /** The DataSource this node belongs to. */
  sourceId: string;
  name: string;
  kind: "file" | "folder" | "database";
  /** MIME type for files (e.g. "application/pdf"). Undefined for folders. */
  mimeType?: string;
  /** Size in bytes for files. */
  size?: number;
  /** Whether this node is currently included in the RAG index. */
  ragIncluded: boolean;
  /**
   * Effective "Private — this device only" state (ancestor-wins): the node
   * participates in on-device answers but is withheld from anything a cloud
   * provider would receive. Drives the explorer's lock control. Optional so
   * older snapshots / connectors that omit it read as unmarked.
   */
  localOnly?: boolean;
  /**
   * True for items *referenced* in their real location on disk rather than
   * copied into the vault (added via "Link…"). The subtree root carries it; the
   * whole referenced tree is read in place, so no copies are made.
   */
  external?: boolean;
}

/**
 * Opaque token returned by `RagService.removeFromVault`. Hold onto it and pass
 * it to `restoreFromVault` to undo the removal (re-link, restore flags, or move
 * a trashed file back). The shape is engine-defined; the UI treats it as a
 * blob it round-trips.
 */
export type RestoreToken = Record<string, unknown>;

/** What a curation rule does to the files it matches (openspec:
 *  add-curation-rules). `clear` is a scoped return-to-default that masks
 *  broader rules. */
export type CurationRuleAction = "include" | "exclude" | "local-only" | "clear";

/** The file-kind predicate values — the extraction/catalog classification. */
export type CurationRuleKind = "tabular" | "document" | "image";

/**
 * What the client sends to create a rule (openspec: add-curation-rules):
 * one scope folder (`""` = the vault root), exactly ONE predicate
 * (kind | ext | glob), and an action. The engine validates (whitelists, glob
 * parse) and mints the id.
 */
export interface CurationRuleInput {
  /** Scope folder node id; "" is the vault root. */
  scope: string;
  /** File kind, from the extraction/catalog classification. */
  kind?: CurationRuleKind;
  /** Extension list (lowercased engine-side, dots optional on input). */
  ext?: string[];
  /** Glob over the path relative to the scope — `*`, `**`, `?` only. */
  glob?: string;
  action: CurationRuleAction;
}

/**
 * A stored curation rule as the wire returns it: the input plus the
 * engine-minted id and display enrichment — a generated `name` (e.g.
 * "spreadsheets in /reports", also what the inspector's attribution line
 * quotes), a human `scopeLabel`, and `orphaned` (the scope folder no longer
 * exists — the rule matches nothing but is kept for cleanup). Shape mirrors
 * the engines' RuleListing (vault.rs ⇄ vault.ts) exactly.
 */
export interface CurationRule extends CurationRuleInput {
  id: string;
  name: string;
  scopeLabel: string;
  orphaned: boolean;
}

/**
 * Why an effective flag is what it is (openspec: add-curation-rules): which
 * resolution layer decided — the node's own explicit flag, an ancestor's, a
 * curation rule (with its id + display name), or the global default. Carried
 * on the inspect payload so the inspector can say
 * `included by rule "spreadsheets in /reports"`.
 */
export interface FlagAttribution {
  source: "explicit" | "ancestor" | "rule" | "default";
  ruleId?: string;
  ruleName?: string;
}

/**
 * Read-only snapshot of the machine-scope managed policy (org deployments):
 * which settings an IT-deployed policy.json locks, so the UI can disable the
 * matching controls and label them "Managed by your organization". Shape
 * mirrors the engines' snapshot (policy.rs / src/server/policy.ts) exactly.
 * `present` false ⇒ unmanaged install; `error` true ⇒ a malformed policy file
 * failed closed (local-only providers, telemetry + history off).
 */
export interface PolicySnapshot {
  present: boolean;
  error: boolean;
  locks: {
    /** Permitted provider ids, or null when providers are unrestricted. */
    allowedProviders: string[] | null;
    telemetryOff: boolean;
    chatHistoryOff: boolean;
    widgetHotkeysOff: boolean;
    ocrOff: boolean;
    notificationsOff: boolean;
    auditLogOn: boolean;
    /** Directories the vault may live under, or null when unrestricted. */
    vaultRoots: string[] | null;
  };
}

/**
 * Session egress snapshot (S3) — what has left this machine this session.
 * `total: 0` renders the header shield as "All local". Host + purpose +
 * count + last time only; never content or full URLs.
 */
export interface EgressSnapshot {
  total: number;
  destinations: {
    host: string;
    purpose: string;
    count: number;
    /** Epoch ms of the most recent request to this host+purpose. */
    lastAt: number;
  }[];
}

/**
 * One durable audit record (openspec: add-audit-log) — what the AI read, what
 * left the machine, and when, for a single answered question. Shape mirrors the
 * engines (audit.rs / src/server/audit.ts). The verbatim `question` is present
 * ONLY when the maintainer opted into it; otherwise just the sha256. `egress`
 * is `["none"]` for a fully local answer, else the hosts this question dialed.
 * The HMAC chain fields the Rust engine writes are engine-internal and omitted
 * here — the UI never renders them (the twin doesn't write them: PARITY).
 */
export interface AuditRecord {
  ts: number;
  questionSha256: string;
  question?: string;
  fileIds: string[];
  provider: string;
  egress: string[];
  artifacts: string[];
}

/**
 * The audit viewer's payload: whether logging is on, whether the chain still
 * verifies (`intact` is always true on the no-HMAC TS twin — PARITY), and the
 * most recent records newest-first.
 */
export interface AuditSnapshot {
  enabled: boolean;
  intact: boolean;
  records: AuditRecord[];
}

/**
 * Result of an explicit chain verification: `intact` plus, when broken, the
 * 0-based index of the first record that fails (`breakAt: -1` when intact).
 * `count` is the number of records checked before the break (or in total).
 */
export interface AuditVerdict {
  intact: boolean;
  breakAt: number;
  count: number;
}

/**
 * Provider sign-in (0.12.1 §3) — read-only status of the generic OAuth
 * device-authorization flow (native provider_auth.rs) offered as an
 * alternative to pasting an OpenAI API key. `available` is false on a stock
 * build (the flow ships with NO endpoints or client id configured — a
 * maintainer must register with the vendor first), on the web twin, and
 * under any partial configuration; the UI renders NO sign-in affordance
 * while it is false (the code-signing pattern). `method` is the persisted
 * auth-method choice — "key" is the default and leaves the existing API-key
 * path byte-untouched.
 */
export interface SigninStatus {
  available: boolean;
  signedIn: boolean;
  /** How the OpenAI provider authenticates: API key (default) or sign-in. */
  method: "key" | "signin";
  /** Display-only account hint (e.g. an email) when the grant carried one. */
  accountHint?: string;
  /** Epoch ms the current access token expires (refreshed engine-side). */
  expiresMs?: number;
  /** Why the flow is unavailable, when it is — honest and user-renderable. */
  reason?: string;
}

/**
 * A started device-authorization sign-in: what the user must do. The UI
 * shows `userCode` large, offers to open `verificationUri` in the browser,
 * and polls at `intervalMs` until the vendor reports approval.
 */
export interface SigninStart {
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresInMs?: number;
}

/**
 * One poll of a started sign-in. `pending` may carry a bumped `intervalMs`
 * (the vendor asked to slow down); `error` is terminal (expired/declined) —
 * reset the flow and show it.
 */
export interface SigninPoll {
  status: "pending" | "complete" | "idle";
  intervalMs?: number;
  accountHint?: string;
  error?: string;
}

/** A model provider the user can pick during onboarding. */
export interface ModelProvider {
  id: string;
  label: string;
  /** Selectable model ids for this provider. */
  models: string[];
  /** Page where the user obtains an API key for this provider. */
  apiKeyUrl: string;
}

/** The signed-in (mock) user. */
export interface User {
  id: string;
  name: string;
  email: string;
}

/** Onboarding progress, persisted in the auth store. */
export interface OnboardingState {
  /**
   * Which step the onboarding flow is currently on. First run walks
   * vault → mode → select-model → inclusion → done. The `mode` step (window vs
   * widget) is desktop-only; the web twin auto-advances past it. `user` is
   * always null now that first-run collects no identity (no email/register).
   */
  step: "vault" | "mode" | "select-model" | "inclusion" | "done";
  user: User | null;
  /** Chosen provider id, set during the select-model step. */
  providerId: string | null;
  /** Chosen model id within the provider. */
  modelId: string | null;
  /** Whether the SELECTED provider has a usable API key (the key itself never reaches the client). */
  hasApiKey: boolean;
  /**
   * Provider ids that have a usable key on file (stored or via env var) —
   * never the keys themselves. Lets the key field say "saved — leave blank to
   * keep" only for providers that genuinely have one. Optional: absent from
   * older engines and the plain mock.
   */
  keyedProviders?: string[];
  /**
   * The user's *effective* default-inclusion behavior for newly-added files:
   * `include` = added files are searchable by default (toggle off what you don't
   * want); `exclude` = nothing is searchable until you include it. Chosen during
   * onboarding; absent ⇒ the conservative `exclude` default.
   */
  defaultInclusion?: "include" | "exclude";
}

/** A reference / related file surfaced beneath a chat answer. */
export interface RagReference {
  fileId: string;
  name: string;
  snippet: string;
  /** Relevance score in [0, 1]. */
  score: number;
  /**
   * G6: `"conversation"` when the cite is a past-chat note (under `Lighthouse
   * Notes/Chats/`), else `"file"`. Optional so older payloads deserialize as a
   * file. KEEP IN SYNC with the Rust `SourceKind` enum in contracts.rs.
   */
  kind?: "file" | "conversation";
}

/**
 * "What the AI sees" — a read-only, per-file inspection (openspec:
 * add-file-inspector). Every field is optional: the Rust engine fills them all
 * in; the TS twin OMITS the ones it cannot compute (never a fake value). KEEP
 * IN SYNC with the shared fields of `FileInspection` in lighthouse-core
 * inspect.rs. PARITY: the twin omits `fromOcr`, `chunkCount`, `columns`, and
 * `indexedAt`/`fresh` (OCR, the persistent index, and the column catalog are
 * Rust-engine-only — see docs/ts-twin.md); the UI renders those as "desktop
 * only" rather than blank.
 */
export interface FileInspection {
  name?: string;
  /** Effective AI-visibility (included in retrieval). */
  included?: boolean;
  /** Effective "Private — this device only" (ancestor-wins). */
  localOnly?: boolean;
  /** A bounded slice of the extracted text the model would read. Absent when the
   *  file has no extractable text (it stays findable by name only). */
  extractPreview?: string;
  /** Rust-only: the preview text came from OCR (image / scanned PDF). The twin
   *  has no OCR and omits this. */
  fromOcr?: boolean;
  /** How the file is chunked: row-windows (tabular) vs word-windows (prose). */
  chunkMode?: "tabular" | "prose";
  /** Rust-only: chunk count from the persistent index. The twin re-chunks per
   *  query and persists no count, so it omits this. */
  chunkCount?: number;
  /** Rust-only: detected columns + kinds (column catalog) for a tabular file. */
  columns?: { name: string; kind: "numeric" | "date" | "text" }[];
  /** Rust-only: the index freshness key (`mtimeMs:size`). */
  indexedAt?: string;
  /** Rust-only: whether `indexedAt` still matches the file on disk right now. */
  fresh?: boolean;
  /** The file's top chunks for a test-search query, scored by the existing
   *  retrieval scorer and scoped to this one file. Present only when a query was
   *  supplied. */
  testSearch?: { text: string; score: number }[];
  /** WHY the effective inclusion is what it is (openspec: add-curation-rules):
   *  which layer decided — explicit flag, ancestor, a rule (named), or the
   *  default. Shared field — both engines compute it. */
  includedBy?: FlagAttribution;
  /** The local-only analog of `includedBy`. */
  localOnlyBy?: FlagAttribution;
}

export type ChatRole = "user" | "assistant";

/** A prior turn sent back to the model so follow-up questions have context. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** A single message in the chat transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** References attached to an assistant message. */
  references?: RagReference[];
}

/** Progress note streamed before answer text while the engine works through a
 *  multi-step plan (e.g. multi-document synthesis) — rendered in the loader. */
export interface ChatProgress {
  /** Human-readable stage, e.g. "Reading q3-summary.csv (2/5)…". */
  label: string;
  step: number;
  total: number;
}

/** A streamed chunk emitted while the assistant answers. */
export interface ChatChunk {
  /** Incremental answer text to append. */
  delta: string;
  /** Final references, present on the terminating chunk. */
  references?: RagReference[];
  /** Pre-answer progress (multi-document synthesis stages). */
  progress?: ChatProgress;
  /**
   * Structured provenance of an analytics answer (final chunk only): the exact
   * executed SQL and the vault files it read. Drives refinement chips, Edit
   * SQL, Save-as-CSV, and pins. Desktop engine only — the web dev twin never
   * takes the analytics branch, so it never sets this.
   */
  analytics?: AnalyticsMeta;
  /**
   * Marks a provisional extractive DRAFT (G2 draft-then-verify): the UI shows it
   * under "Draft — verifying…" and REPLACES it in place with the first
   * authoritative (non-draft) delta. Only the local-model path sets this; it
   * never enters any prompt and costs zero tokens. KEEP IN SYNC with the Rust
   * ChatChunk.draft.
   */
  draft?: boolean;
  /**
   * Engine-emitted provenance stamp (final chunk only): where this answer was
   * computed and how much was sent. NEVER derived from model text — the engine
   * sets it where the prompt is assembled, so it counts what was actually
   * handed to the model. `origin` is `"device"` for the local model or the
   * model-free/extractive fallback, else the cloud provider id (e.g.
   * `"anthropic"`) — it agrees with the audit record's `provider`
   * (device⇔local/none) and the egress registry. `excerptCount` is how many
   * context blocks the model received in the branch that ran; `sourceFileCount`
   * is the number of distinct source files behind them (the final chunk's
   * `references` length). `cachedAt` (openspec: add-answer-cache) is present
   * ONLY when this final chunk replays a cached answer: the epoch ms of the
   * ORIGINAL answer's completion — the UI renders its "From cache · same data
   * as HH:MM · Re-run" line from this field alone, never from prose; origin
   * and the counts stay the original answer's. KEEP IN SYNC with the Rust
   * ChunkMeta in contracts.rs.
   */
  meta?: { origin: string; excerptCount: number; sourceFileCount: number; cachedAt?: number };
  /** True on the last chunk of a response. */
  done: boolean;
}

/** The exact executed SQL of an analytics answer and the files it read. */
export interface AnalyticsMeta {
  sql: string;
  fileIds: string[];
}

/**
 * A pinned analytics question: the engine re-runs its stored SQL when the
 * watched files change and alerts when the computed result differs. Persisted
 * engine-side (cap 20). `staleReason` set = the last recheck couldn't run
 * (file gone, schema drift) — shown in the dialog, never alerts.
 */
export interface Pin {
  id: string;
  question: string;
  sql: string;
  fileIds: string[];
  createdMs: number;
  lastRunMs?: number;
  lastDigest?: string;
  /** Compact "NE 125 · NW 50" render of the last result (≤3 rows). */
  lastSummary?: string;
  staleReason?: string;
  /**
   * The investigation this pin belongs to (openspec: add-investigations):
   * the SINGLE source of truth for pin membership — the investigation view's
   * `pinRefs` is derived from it at read time. Absent = uncategorized, which
   * is what every pin created before investigations existed remains.
   */
  investigationId?: string;
}

/** One changed pin from a recheck pass — the alert payload. */
export interface ChangedPin {
  id: string;
  question: string;
  before?: string;
  after: string;
}

/** How often a briefing wants to regenerate. `manual` never comes due on its own. */
export type Cadence = "manual" | "daily" | "weekly";

/**
 * A briefing: a titled, ordered selection of pinned questions (add-briefings).
 * Running it re-executes each pin's SQL and composes the results into one
 * report. Persisted engine-side (cap 20); `cadence` drives the shell's timer.
 */
export interface Briefing {
  id: string;
  title: string;
  pinIds: string[];
  cadence: Cadence;
  lastRunMs?: number;
  createdMs: number;
}

/** One question's slot in a composed report. `error` set = pin gone / query failed. */
export interface BriefingSection {
  question: string;
  markdown: string;
  error?: string;
}

/** A freshly composed briefing report. */
export interface BriefingReport {
  id: string;
  title: string;
  generatedMs: number;
  sections: BriefingSection[];
}

/**
 * Provider posture of an investigation (openspec: add-investigations):
 * "local-only" forces the private path for every ask inside it at the same
 * chokepoint the managed policy layer gates; "default" follows the profile's
 * active provider.
 */
export type InvestigationProviderPolicy = "default" | "local-only";

/**
 * A named, durable container for analysis (openspec: add-investigations):
 * structure persisted vault-scoped engine-side (versioned envelope, atomic
 * writes). `conversationRefs` are opaque client Conversation.id values —
 * refs, never transcripts — and are accepted only when the client's
 * persistAllowed verdict AND the managed history policy both allow.
 * `folderName` is sanitized at creation and never moved by rename. Shape
 * mirrors the engines' view (investigations.rs ⇄ investigations.ts) exactly.
 */
export interface Investigation {
  /** Engine-minted, stable across renames. */
  id: string;
  /** Display name, unique case-insensitively (archived records included). */
  name: string;
  createdMs: number;
  /** Archive hides, never deletes: a visibility flag with no cascade. */
  archived: boolean;
  /** Vault node ids; empty = whole vault. */
  scopeFileIds: string[];
  providerPolicy: InvestigationProviderPolicy;
  conversationRefs: string[];
  /** Notes folder recorded at creation (rename moves nothing). */
  folderName: string;
  /**
   * DERIVED at read time from pins.json (§3): the ids of pins carrying
   * `Pin.investigationId == id`. Never stored on the record.
   */
  pinRefs: string[];
  /**
   * DERIVED at read time from the investigation's folder under
   * `Lighthouse Notes/<folderName>/` (§3): the file ids there — membership =
   * location. Never stored on the record.
   */
  noteRefs: string[];
}

/**
 * What the client sends to create an investigation: the display name plus an
 * optional file scope (absent/empty = whole vault) and provider posture
 * (absent = "default"). The engine mints the id, stamps creation time, and
 * fixes the sanitized notes folder name.
 */
export interface InvestigationCreateInput {
  name: string;
  scopeFileIds?: string[];
  providerPolicy?: InvestigationProviderPolicy;
}

/** Card footprint on a board's responsive grid (openspec: add-boards). */
export type BoardCardSize = "S" | "M" | "L";

/**
 * One ordered board card (openspec: add-boards): a pin reference plus its
 * size — nothing else. Pin existence is deliberately not enforced at write
 * time; a card whose pin was deleted renders as a tombstone, and removing a
 * card never deletes or modifies the pin.
 */
export interface BoardCardRef {
  pinId: string;
  size: BoardCardSize;
}

/**
 * A board (openspec: add-boards): existing pins arranged as a living, local
 * dashboard — ordered card references persisted vault-scoped engine-side
 * (versioned envelope, atomic writes, the investigations idiom). Names are
 * unique case-insensitively WITHIN a scope (global vs each investigation).
 * A scope with no persisted board lists a VIRTUAL default ("My board"
 * globally; the investigation's name when scoped) under a deterministic id
 * (`default-global` / `default-<invId>`, `createdMs` 0); the first mutation
 * targeting that id materializes it as a real record — mutate exactly what
 * the listing returned.
 */
export interface Board {
  /** Engine-minted, stable across renames. */
  id: string;
  /** Display name, unique case-insensitively within its scope. */
  name: string;
  /** Owning investigation; absent = the global scope (mirrors Pin). */
  investigationId?: string;
  /** Ordered card references — order IS the layout order. */
  cards: BoardCardRef[];
  /** Creation instant; 0 on a virtual (not yet persisted) default. */
  createdMs: number;
}

/**
 * One card's answer from a board refresh (openspec: add-boards). `live`
 * distinguishes the engines' modes: the desktop engine re-runs the pin's
 * stored SQL through the same guarded, model-free `run_direct` path as
 * watcher rechecks (a manual refresh IS a recheck — the pin's stored
 * digest/summary advance identically) and answers `live: true` with the
 * fresh markdown/chart/footer/digest; the dev twin cannot execute SQL
 * (analytics is Rust-only, PARITY) and answers `live: false` with the pin's
 * STORED state so cards render the last-known snapshot honestly. A pin that
 * no longer exists answers `tombstone: true`.
 */
export interface BoardCardRefresh {
  pinId: string;
  /** True = computed now by the engine; false = stored state (twin). */
  live: boolean;
  /** The pin no longer exists — render the tombstone card. */
  tombstone?: boolean;
  question?: string;
  /** Live only: narration-capped result table from the re-execution. */
  markdown?: string;
  /** Live only: chart spec when the result is chartable. */
  chart?: string;
  /** Live only: the engine freshness/provenance footer. */
  footer?: string;
  /** Live only: full-fidelity digest (what rechecks compare). */
  resultDigest?: string;
  lastRunMs?: number;
  /** Live only: the re-execution failed — shown staleReason-style. */
  error?: string;
  /** Stored state: the pin's compact summary as of the last recheck. */
  lastSummary?: string;
  /** Stored state: the pin's digest as of the last recheck. */
  lastDigest?: string;
  /** Stored state: why the last recheck couldn't run. */
  staleReason?: string;
}
