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
