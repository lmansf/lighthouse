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
   * `references` length). KEEP IN SYNC with the Rust ChunkMeta in contracts.rs.
   */
  meta?: { origin: string; excerptCount: number; sourceFileCount: number };
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
