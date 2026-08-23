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
/** A bounded, parsed preview of a delimited (CSV/TSV) file: the header row and
 *  the first few data rows (columns capped) — a glance at the table's shape, not
 *  the whole file. KEEP IN SYNC with `PreviewTable` in lighthouse-core
 *  inspect.rs. */
export interface PreviewTable {
  header: string[];
  rows: string[][];
  /** True when the file has more rows or columns than shown — never a claim of
   *  completeness. */
  truncated: boolean;
}

export interface FileInspection {
  name?: string;
  /** Effective AI-visibility (included in retrieval). */
  included?: boolean;
  /** Effective "Private — this device only" (ancestor-wins). */
  localOnly?: boolean;
  /** A bounded slice of the extracted text the model would read. Absent when the
   *  file has no extractable text (it stays findable by name only). */
  extractPreview?: string;
  /** For a CSV/TSV file, a tiny parsed table preview — header + first rows,
   *  columns capped — so the panel shows the table's shape, not just a raw text
   *  slice. Shared field (both engines parse delimited text); absent otherwise. */
  previewTable?: PreviewTable;
  /** Rust-only: the preview text came from OCR (image / scanned PDF). The twin
   *  has no OCR and omits this. */
  fromOcr?: boolean;
  /** Whether OCR can run in THIS engine right now, and why not (iOS field
   *  patch 3 §1 — a build whose models never shipped becomes diagnosable):
   *  "ready" | "off" (toggle / managed policy) | "missing-models" (the .rten
   *  files didn't load) from the Rust engine; the TS twin fills its own honest
   *  constant "unsupported" (it has no OCR — images stay findable by name
   *  only). Present only for files OCR could apply to (images + PDFs). */
  ocrAvailability?: "ready" | "off" | "missing-models" | "unsupported";
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
  /**
   * Beam loop (openspec: add-beam-loop §2.4): a short, stable machine intent for
   * the current step ("planning" | "running"), so the cost meter (§3), plan
   * approval (§4), and context manifest (§5) can attach per iteration without
   * re-parsing the human `label`. PARITY: `intent` in contracts.rs; the Rust-only
   * analytics loop is the only emitter, so the twin never sets it.
   */
  intent?: string;
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
   * Two-phase plan approval (openspec: add-beam-loop §4.1): on a `planOnly` ask
   * the engine returns THIS terminal PLAN chunk — the verbatim proposed step-1
   * SQL and the tables it would read — and executes nothing. Phase 2 re-issues
   * the ask with the approved SQL echoed back, which runs without re-planning.
   * PARITY: plan execution is Rust-only (analytics); this dev twin has no
   * analytics branch, so it NEVER emits a plan — the shape is mirrored so the
   * same UI renders the Rust engine's preview. KEEP IN SYNC with the Rust
   * ChatChunk.plan / PlanPreview in contracts.rs.
   */
  plan?: PlanPreview;
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
   * and the counts stay the original answer's. `cost` (openspec: add-beam-loop
   * §3) is the answer's cost meter — provider-reported tokens summed across the
   * ask's model calls, plus a LABELED dollar estimate (the app renders
   * "estimated at $X/Mtok", NEVER a charge). `reported: false` ⇒ the meter shows
   * "not reported" (never a chars/4 guess); a local answer reports tokens with
   * `costEstimateUsd: 0`; an unknown model omits `costEstimateUsd` ("estimate
   * unavailable"). PARITY: the cost VALUES are Rust-shipped — this dev twin does
   * not parse provider usage (§1), so its answers report "not reported"; the
   * shape is mirrored so the same UI renders either engine's meter. `manifest`
   * (openspec: add-beam-loop §5) is the per-context-block METADATA the model was
   * handed — built from the ALREADY-GATED shareable set, so a cloud ask lists
   * only what left the device (what was withheld is disclosed by the skip note).
   * METADATA ONLY, never the context text: `chars` is the block's LENGTH (a
   * count), never the bytes, which stay behind the device-only file inspector.
   * `kind` is a byte-exact string enum; `fileId` attributes a retrieved chunk to
   * its source file. PARITY: this dev twin has no analytics branch, so it only
   * ever emits `retrieved-chunk` / `conversation-note` entries (the kinds its RAG
   * paths assemble) — the analytics kinds (`schema-card` / `query-result` /
   * `join-hints` / `chart-options`) are Rust-only; the labels match byte-for-byte.
   * KEEP IN SYNC with the Rust ChunkMeta / CostMeta / CtxManifestEntry in
   * contracts.rs.
   */
  meta?: {
    origin: string;
    excerptCount: number;
    sourceFileCount: number;
    cachedAt?: number;
    cost?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reported: boolean;
      costEstimateUsd?: number;
    };
    manifest?: {
      name: string;
      kind: string;
      chars: number;
      fileId?: string;
      localOnly?: boolean;
      score: number;
    }[];
    /** §22.6: the engine-validated chart spec (JSON) for this answer, moved
     *  OFF the streamed markdown — the renderer draws from THIS field; a
     *  ```lighthouse-chart fence in answer text is legacy-only (old saved
     *  chats). Engine-built from query batches / profiled tables, never model
     *  text. KEEP IN SYNC with contracts.rs ChunkMeta::chart. */
    chart?: string;
    /** §32 §3: the answer's result table (JSON
     *  `{"columns":[…],"rows":[[…]]}`), moved OFF the streamed markdown
     *  exactly like `chart` — under the apple-fm prose-only contract the
     *  model narrates over a fact sheet and the ENGINE carries the verified
     *  rows; the renderer draws them at the answer's table position and
     *  consumers read them via answerTable(). Emitted ONLY when that
     *  contract is active; cloud/desktop answers keep markdown tables and
     *  omit this. KEEP IN SYNC with contracts.rs ChunkMeta::table. */
    table?: string;
  };
  /** True on the last chunk of a response. */
  done: boolean;
}

/**
 * The engine's verdict that an answer VERIFIABLY computed a blessed metric
 * definition (openspec: add-semantic-layer §4). Deterministic and MODEL-FREE:
 * `certified` is AST-equality of the executed SQL's projection to the metric's
 * blessed expression; `reconciled` is a numeric re-run of that definition through
 * the same guarded executor. `metric` names the definition; `expected`/`got`
 * carry the re-run and answer figures on a mismatch (or the reason on an honest
 * degradation). A non-metric answer is `{certified:false, reconciled:false}` — an
 * honest "not certified", never a failure. PARITY: certification/reconciliation
 * are RUST-ONLY (analytics/DataFusion); this dev twin never takes the analytics
 * branch, so it never populates a verdict — this is the wire shape only. KEEP IN
 * SYNC with the Rust `TrustVerdict` in contracts.rs.
 */
export interface TrustVerdict {
  certified: boolean;
  reconciled: boolean;
  metric?: string;
  expected?: string;
  got?: string;
}

/**
 * The exact executed SQL of an analytics answer and the files it read.
 * `certified`/`trust` (openspec: add-semantic-layer §3/§4) ride here as
 * additive-optional (pre-Phase-B cache entries carry neither and stay valid), so
 * a cached certified answer replays with its ORIGINAL verdict — nothing
 * recomputed. PARITY: both are Rust-only (analytics); this twin never populates
 * them. KEEP IN SYNC with the Rust `AnalyticsMeta` in contracts.rs.
 */
export interface AnalyticsMeta {
  sql: string;
  fileIds: string[];
  certified?: string[];
  trust?: TrustVerdict;
}

/**
 * A previewed analytics plan (openspec: add-beam-loop §4.1), carried on a
 * `planOnly` ask's terminal PLAN chunk. `sql` is the VERBATIM proposed step-1
 * SQL — the exact statement Phase 2 would execute — shown before it ever touches
 * the vault. `tables` are the names of the registered tables/views it would read
 * (metadata only, never the context bytes). PARITY: plan execution is Rust-only
 * (analytics); this dev twin never emits a plan. KEEP IN SYNC with the Rust
 * PlanPreview in contracts.rs.
 */
export interface PlanPreview {
  sql: string;
  tables: string[];
}

/**
 * Provider posture of an investigation (openspec: add-investigations):
 * "local-only" forces the private path for every ask inside it at the same
 * chokepoint the managed policy layer gates; "default" follows the profile's
 * active provider.
 */
export type InvestigationProviderPolicy = "default" | "local-only";

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

/**
 * Where a view's one-line summary came from (openspec: add-shaped-views):
 * recorded from the asked question ("Save as view" on a Beam answer) or
 * stated by the model during a shaping ask. The whole whitelist — a view
 * never carries an unlabeled summary.
 */
export type ViewSummarySource = "question" | "model";

/**
 * One source-file dependency of a view, with the table-name binding the
 * definition's SQL uses pinned at save time.
 */
export interface ViewFileRead {
  fileId: string;
  tableName: string;
}

/**
 * A built-in analysis recipe (openspec: add-recipes §2): a named, deterministic
 * bundle of guarded SELECT templates that plans model-free and runs on every
 * provider (cloud, local, extractive). v1 ships five built-ins and NO
 * user-authored recipes — the descriptor is the extension seam, not a creation
 * surface. KEEP IN SYNC with the `Recipe` descriptor in lighthouse-core
 * recipes.rs (id/name/summary).
 */
export interface Recipe {
  /** Wire-stable built-in key the run cue names (`run-recipe:{id} on {table}`). */
  id: string;
  name: string;
  /** One line for the gallery/chip. */
  summary: string;
}

/**
 * An applicable recipe resolved for the Library gallery / empty-state chips: the
 * built-in plus the table (file display name) or view (name) it runs on. Only
 * surfaces where the catalog satisfies the recipe's applicability predicate — a
 * view that is effectively local-only never surfaces on a cloud ask. KEEP IN
 * SYNC with `RecipeCard` in lighthouse-core meta.rs.
 */
export interface RecipeCard extends Recipe {
  /** The file (display name) or view (name) this recipe runs on. */
  table: string;
}

/**
 * The run-recipe seam (openspec: add-recipes §2.4). LOWER-CHURN CHOICE: a recipe
 * chip/gallery row runs a recipe by dispatching the EXISTING
 * `lighthouse:ask-question` event with a recipe-CUED question — no new event and
 * no new streaming op. The Rust engine's `synth.rs` detects this exact prefix
 * (`recipes::parse_recipe_cue`) BEFORE the model gate and runs the recipe
 * deterministically; a plain natural-language question never carries the prefix,
 * so a recipe never triggers by accident. KEEP the format in sync with
 * `RECIPE_CUE_PREFIX` in lighthouse-core recipes.rs.
 */
export const RECIPE_CUE_PREFIX = "run-recipe:";

/** Build the recipe-cued question a chip/gallery row seeds the chat with. */
export function runRecipeQuestion(id: string, table: string): string {
  return `${RECIPE_CUE_PREFIX}${id} on ${table}`;
}

// --- Deep analysis + capability map (openspec: add-deep-analysis) -----------------

/** A typed column in the capability map — `kind` mirrors the Rust `ColumnKind`. */
export type CapabilityColumnKind = "numeric" | "date" | "text";

/**
 * One analyzable table in the capability map: its display name, typed columns,
 * and whether it has a Date+Numeric shape (⇒ investigable by deep analysis). KEEP
 * IN SYNC with `CapabilityTable` in lighthouse-core meta.rs.
 */
export interface CapabilityTable {
  name: string;
  columns: { name: string; kind: CapabilityColumnKind }[];
  investigable: boolean;
}

/**
 * One "Investigate {table}" suggestion — offered for a Date+Numeric table only,
 * so it never proposes an investigation that would produce an empty report. KEEP
 * IN SYNC with `SuggestedInvestigation` in lighthouse-core meta.rs.
 */
export interface SuggestedInvestigation {
  label: string;
  table: string;
}

/**
 * The capability map (openspec: add-deep-analysis §3): a single view of what the
 * included vault makes investigable — the analyzable tables + their columns, the
 * recipes that apply, the suggested asks, and one report suggestion per
 * Date+Numeric table. A pure aggregate of the posture-gated `applicable_*`
 * surfaces (no new analysis). KEEP IN SYNC with `CapabilityMap` in meta.rs.
 * PARITY: Rust-only — the TS `capabilityMap` op returns an empty map.
 */
export interface CapabilityMap {
  tables: CapabilityTable[];
  recipes: RecipeCard[];
  suggestedAsks: { label: string; question: string }[];
  suggestedInvestigations: SuggestedInvestigation[];
}

/** The honest empty capability map — the TS twin's degradation + a safe default. */
export const EMPTY_CAPABILITY_MAP: CapabilityMap = {
  tables: [],
  recipes: [],
  suggestedAsks: [],
  suggestedInvestigations: [],
};

// --- Proactive insights (openspec: add-quant-depth §5) -----------------------

/**
 * Which cheap deterministic detector produced a finding (openspec:
 * add-quant-depth §5): a monthly z-score `anomaly`, a top-`mover`, or a
 * level-shift `changepoint`. KEEP IN SYNC with the Rust `InsightKind` in
 * lighthouse-core insights.rs.
 */
export type InsightKind = "anomaly" | "mover" | "changepoint";

/**
 * One noteworthy finding the engine surfaced WITHOUT the user asking (openspec:
 * add-quant-depth §5). `headline` is an engine-computed, ready-to-display string
 * — every number in it is engine SQL, and it is rendered VERBATIM (never model
 * text). `magnitude` is the ranking key (findings arrive pre-ranked, most
 * notable first) and `sql` is the guarded SELECT that produced the numbers. KEEP
 * IN SYNC with the Rust `Insight` in lighthouse-core insights.rs.
 */
export interface InsightFinding {
  /** The cataloged table (file display name / view name) the finding is about. */
  table: string;
  kind: InsightKind;
  /** Engine-computed, ready-to-display headline — rendered verbatim. */
  headline: string;
  /** The finding's magnitude — the ranking key (e.g. a z-score or % move). */
  magnitude: number;
  /** The guarded SELECT that produced the finding's numbers. */
  sql: string;
}

/**
 * What the `insights` op answers (openspec: add-quant-depth §5): the ranked,
 * bounded findings plus the scan's coverage. `tablesScanned` < `tablesAvailable`
 * means the scan hit its cap and the surface MUST disclose it ("scanned N of M
 * tables") rather than present the capped set as exhaustive. An empty `findings`
 * is an honest "nothing stands out", never an error. PARITY: the scan runs the
 * detectors as guarded SELECTs through DataFusion (Rust engine only), so the web
 * dev twin answers an empty scan (findings [], both counts 0) — the panel then
 * honestly shows "nothing stands out". KEEP IN SYNC with the Rust `InsightsScan`.
 */
export interface InsightsScan {
  findings: InsightFinding[];
  /** How many cataloged tables the scan actually visited (bounded by the cap). */
  tablesScanned: number;
  /** How many cataloged tables were available to scan. */
  tablesAvailable: number;
}
