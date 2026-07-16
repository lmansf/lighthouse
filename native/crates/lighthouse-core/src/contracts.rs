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

/// The exact executed SQL of an analytics answer and the vault files it read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsMeta {
    pub sql: String,
    pub file_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
}
