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
    pub done: bool,
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
