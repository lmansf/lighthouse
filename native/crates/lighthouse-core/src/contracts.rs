//! Domain types (port of `src/contracts/types.ts`). Serialized shapes are
//! camelCase to stay wire-compatible with the existing UI.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Folder,
}

/// Where a retrieved chunk/reference came from. A `Conversation` chunk is an
/// auto-exported past-chat note under `Lighthouse Notes/Chats/` (G6); everything
/// else is an ordinary vault `File`. Defaults to `File` so older payloads /
/// persisted transcripts without the field deserialize correctly. KEEP IN SYNC
/// with the `RagReference["kind"]` union in src/contracts/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    #[default]
    File,
    Conversation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub source_id: String,
    pub name: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub rag_included: bool,
    /// Effective "Private — this device only" state (ancestor-wins), so the
    /// explorer can render the lock without re-resolving. Default false keeps
    /// old snapshots / cloud connectors that omit it unmarked.
    #[serde(default)]
    pub local_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagReference {
    pub file_id: String,
    pub name: String,
    pub snippet: String,
    pub score: f64,
    /// G6: `Conversation` when this cite is a past-chat note, else `File`.
    /// `#[serde(default)]` keeps older wire payloads (no field) valid.
    #[serde(default)]
    pub kind: SourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// Pre-answer stage note streamed while the engine works through a multi-step
/// plan (multi-document synthesis) — rendered in the chat loader.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatProgress {
    /// Human-readable stage, e.g. "Reading q3-summary.csv (2/5)…".
    pub label: String,
    pub step: usize,
    pub total: usize,
    /// Beam loop (openspec: add-beam-loop §2.4): a short, stable machine intent
    /// for the current step ("planning" | "running"), so the cost meter (§3),
    /// plan approval (§4), and context manifest (§5) can attach per iteration
    /// without re-parsing the human `label`. Optional and skipped when None so
    /// pre-Beam payloads and the TS twin stay wire-valid. PARITY: mirrored as an
    /// optional field in src/contracts/types.ts; the twin never runs the
    /// (Rust-only) analytics loop, so it emits None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChunk {
    pub delta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<RagReference>>,
    /// Pre-answer progress (multi-document synthesis stages).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub progress: Option<ChatProgress>,
    /// Structured provenance of an analytics answer, final chunk only — what
    /// refinement chips, Save-as-CSV, and pins act on (never re-parsed out of
    /// the markdown). PARITY: the TS engine never takes the analytics branch,
    /// so it never sets this.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub analytics: Option<AnalyticsMeta>,
    /// Marks a provisional extractive DRAFT (G2 draft-then-verify): the UI shows
    /// it under "Draft — verifying…" and REPLACES it in place with the first
    /// authoritative (non-draft) delta. Only the local-model path sets this; it
    /// never enters any prompt and costs zero tokens. PARITY: mirrored in the TS
    /// twin (user-visible text).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub draft: Option<bool>,
    /// Two-phase plan approval (openspec: add-beam-loop §4.1): on a `plan_only`
    /// ask the engine returns THIS terminal PLAN chunk — the verbatim proposed
    /// step-1 SQL and the tables it would read — and executes NOTHING, so nothing
    /// runs against the vault and no execution/narration egress happens (the
    /// plan-generation model call is the sole cost of previewing; it rides the
    /// `meta.cost` meter honestly). Phase 2 re-issues the ask with the approved
    /// SQL echoed back; the engine runs that exact plan without re-planning. Only
    /// the (Rust-only) analytics plan-only branch sets this. PARITY: the TS twin
    /// has no analytics branch, so it never emits a plan — KEEP IN SYNC with the
    /// ChatChunk["plan"] shape in src/contracts/types.ts.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub plan: Option<PlanPreview>,
    /// Engine-emitted provenance stamp on the FINAL chunk (privacy-legibility):
    /// where the answer was computed and how much was sent. NEVER model text —
    /// the engine sets it where the prompt is assembled, so it counts what was
    /// actually handed to the model. PARITY: mirrored in the TS twin.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub meta: Option<ChunkMeta>,
    pub done: bool,
}

/// Provenance of a single answer, stamped on its final chunk. `origin` is
/// `"device"` for the local model or the model-free/extractive fallback, else
/// the cloud provider id (e.g. `"anthropic"`) — it agrees with the audit
/// record's `provider` (device⇔local/none) and with the egress registry.
/// `excerpt_count` is how many context blocks were handed to the model in the
/// branch that ran; `source_file_count` is the number of distinct source files
/// behind them (the final chunk's `references` length). KEEP IN SYNC with the
/// ChatChunk["meta"] shape in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMeta {
    pub origin: String,
    pub excerpt_count: usize,
    pub source_file_count: usize,
    /// Answer-cache replay stamp (openspec: add-answer-cache): epoch ms of the
    /// ORIGINAL answer's completion, present ONLY when this final chunk replays
    /// a cached answer. Engine-emitted, never model text — the UI renders its
    /// "From cache · same data as HH:MM · Re-run" line from this field alone.
    /// `origin`/counts stay the original answer's (the replay computed nothing).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cached_at: Option<i64>,
    /// Cost meter (openspec: add-beam-loop §3): the ask's provider-reported
    /// token usage summed across every model call, plus a LABELED dollar
    /// estimate. Present on every live final chunk; a replay carries the ORIGINAL
    /// answer's figures as history (the replay itself computed nothing — see
    /// `cached_at`). `#[serde(default)]` keeps pre-Beam cached entries (no field)
    /// valid. KEEP IN SYNC with the ChatChunk["meta"]["cost"] shape in
    /// src/contracts/types.ts.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cost: Option<CostMeta>,
    /// Context manifest (openspec: add-beam-loop §5): the per-context-block
    /// METADATA the model was actually handed, built from the ALREADY-GATED
    /// shareable set (post `vault::shareable_subset`) — so a cloud ask lists ONLY
    /// what left the device, while what was withheld is disclosed separately by
    /// the `local_only_skip_note`. METADATA ONLY, NEVER `Ctx.text` (see
    /// `CtxManifestEntry`). Present on a live final chunk that assembled any
    /// context; a replay carries the ORIGINAL manifest as history (it rides this
    /// `ChunkMeta`, so `..hit.meta` re-emits it — the replay computed nothing).
    /// `#[serde(default)]` keeps pre-manifest cached entries (no field) valid.
    /// KEEP IN SYNC with the ChatChunk["meta"]["manifest"] shape in
    /// src/contracts/types.ts.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manifest: Option<Vec<CtxManifestEntry>>,
}

/// The cost meter for one answer (openspec: add-beam-loop §3.1), stamped on the
/// final chunk's `ChunkMeta`. Tokens are PROVIDER-REPORTED measured facts (from
/// §1's `UsageSink`), summed across the ask's plan / retry / narration calls;
/// the dollar figure is a LABELED ESTIMATE derived from a shipped per-model
/// price constant — never an authoritative charge (constitution §14). It is
/// NEVER a `chars/4` guess: when a provider reports no usage, `reported` is
/// false and the UI shows "not reported". A local/loopback answer reports its
/// tokens with `cost_estimate_usd = Some(0.0)` (on-device, not egress); an
/// unknown model leaves `cost_estimate_usd` None ("estimate unavailable") while
/// still showing the tokens. KEEP IN SYNC with the `cost` shape on
/// ChatChunk["meta"] in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostMeta {
    /// Provider-reported prompt (input) tokens, summed across the ask's calls.
    pub input_tokens: u64,
    /// Provider-reported completion (output) tokens, summed across the ask.
    pub output_tokens: u64,
    /// `input_tokens + output_tokens` (the UI shows the split and the total).
    pub total_tokens: u64,
    /// Whether ANY provider reported usage this ask. `false` ⇒ the UI shows
    /// "not reported" and the token counts are a real 0, never a fabricated
    /// estimate (§1.4 / §14).
    pub reported: bool,
    /// The LABELED dollar estimate — provider-reported tokens × a shipped
    /// per-Mtok price constant, rendered "estimated at $X/Mtok", NEVER a charge.
    /// `Some(0.0)` for a local/loopback answer; `None` when the estimate is
    /// unavailable (an unknown model, or unreported tokens).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_estimate_usd: Option<f64>,
}

/// One entry in the context manifest (openspec: add-beam-loop §5.1) that rides
/// the final chunk's `ChunkMeta.manifest` — a per-context-block DESCRIPTION of
/// what the model was handed, METADATA ONLY. It NEVER carries `Ctx.text`: the
/// manifest rides `ChunkMeta`, which the answer cache persists into
/// `CachedAnswer` (and which G6 exports into conversation notes), so copying
/// context bytes here would land private file text past a boundary `local_only`
/// never authorized — a leak. The bytes stay behind the device-only file
/// inspector (inspect.rs); this is the label, not the content.
///
/// - `name` is the context block's prompt label (what the model saw).
/// - `kind` is a byte-exact string enum: `schema-card` | `query-result` |
///   `retrieved-chunk` | `join-hints` | `chart-options` | `conversation-note`.
/// - `chars` is the block's LENGTH (a count), never the text.
/// - `file_id` attributes a retrieved chunk to its source file (from the flowing
///   `references`, `RagReference.file_id`); absent for engine-computed blocks.
/// - `local_only` is reserved for per-entry local-only marking on the loopback
///   path; the cloud path's manifest is already the gated shareable set, so
///   withholding is disclosed by the skip note rather than per entry.
///
/// KEEP IN SYNC with the `CtxManifestEntry` shape (ChatChunk["meta"]["manifest"])
/// in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CtxManifestEntry {
    pub name: String,
    pub kind: String,
    pub chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    pub score: f64,
}

/// The engine's verdict that an answer VERIFIABLY computed a blessed metric
/// definition (openspec: add-semantic-layer §4). Deterministic and MODEL-FREE:
/// `certified` is AST-equality of the executed SQL's projection to the metric's
/// blessed expression; `reconciled` is a numeric re-run of that definition
/// through the SAME guarded executor (`analytics::reconcile_metric`). `metric`
/// names the definition; `expected`/`got` carry the re-run and answer figures
/// on a mismatch (or the reason on an honest degradation). A non-metric answer
/// is `{certified:false, reconciled:false}` — an honest "not certified", never a
/// failure. PARITY: reconciliation is Rust-only (analytics/DataFusion); this
/// wire shape is mirrored in src/contracts/types.ts (`TrustVerdict`), which the
/// TS twin never populates. KEEP IN SYNC with that mirror.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustVerdict {
    pub certified: bool,
    pub reconciled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub got: Option<String>,
}

/// The exact executed SQL of an analytics answer and the vault files it read.
/// `certified`/`trust` (openspec: add-semantic-layer §3/§4) ride here as
/// additive-optional (pre-Phase-B cache entries carry neither and stay valid),
/// so a cached certified answer replays with its ORIGINAL verdict from
/// `CachedAnswer.analytics` — nothing recomputed. KEEP IN SYNC with the
/// `AnalyticsMeta` mirror in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsMeta {
    pub sql: String,
    pub file_ids: Vec<String>,
    /// The metric names the executed SQL verifiably computed (§3) — engine-
    /// determined by AST-equality, never model text. Absent when none certified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certified: Option<Vec<String>>,
    /// The trust verdict for the certified metric (§4): the definition re-run
    /// and reconciled through the guard. Absent when no metric certified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<TrustVerdict>,
}

/// A previewed analytics plan (openspec: add-beam-loop §4.1), carried on a
/// `plan_only` ask's terminal PLAN chunk. `sql` is the VERBATIM proposed
/// step-1 SQL — the exact statement Phase 2 would execute — shown before it
/// ever touches the vault (constitution §14). `tables` are the names of the
/// registered tables/views the SQL would read (from `regs`/`view_regs`) —
/// METADATA ONLY, never the context bytes (the full per-entry manifest is §5).
/// Because the SQL is not executed in Phase 1, nothing runs against the vault
/// and no execution/narration egress happens. KEEP IN SYNC with the
/// ChatChunk["plan"] shape in src/contracts/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    pub sql: String,
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}
