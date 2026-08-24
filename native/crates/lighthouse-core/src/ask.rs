//! The shared headless-ask chokepoint (openspec: add-automation §1).
//!
//! `synth::answer_pipeline` computes, keys, caches, and streams an answer — but
//! it does NOT audit itself and does NOT resolve scope or provider. Those are
//! wired by each TRANSPORT, by hand, immediately before the call: the axum
//! route (`routes.rs::chat_post`) and the desktop IPC command
//! (`commands.rs::chat_ask`) each assemble the identical sequence inline —
//! `resolve_ask_context` over `model_config()`, `AnswerAudit::start` before the
//! stream, `.finish(provider, files, artifacts, cost)` after the final chunk.
//! That wrapper is the ONLY thing that puts an ask into the audit + egress
//! ledger. A NEW entry point that calls `answer_pipeline` and forgets the
//! wrapper answers correctly but leaves NO audit record and NO egress
//! attribution — a silent hole. A CLI and an MCP server are exactly the kind of
//! new entry point that would forget.
//!
//! `run_headless_ask` encapsulates the wrapper so it CANNOT be skipped: it is
//! the CANONICAL path for every NEW ask entry (the `lighthouse` CLI's `ask`,
//! the MCP `ask_vault` tool). A caller obtains its answer stream here, so it
//! reaches `answer_pipeline` only THROUGH the scope/provider + audit + egress
//! wrapper — a headless ask is recorded exactly like an app ask, by
//! construction rather than by remembering.
//!
//! DECISION (§1.5) — do NOT retrofit `chat_post`/`chat_ask` onto this helper in
//! v1. They already assemble the identical sequence inline, so folding them in
//! is tempting DRY — but both are `async_stream!` bodies with load-bearing
//! timing (`audit.finish` fires AFTER the whole stream drains, `answer_cost` is
//! read from the final chunk mid-drain, and each transport frames the chunks
//! differently — NDJSON bytes vs an IPC channel). A byte-identical streaming
//! equivalence is not something to assert without a dedicated parity test. So
//! v1 leaves the two UI transports exactly as they are and documents this
//! helper as the canonical path for NEW ask entries; a retrofit that routes all
//! four entries through the one helper is a clean follow-on the moment a
//! `run_headless_ask`-vs-`chat_post` byte-identical-stream test exists.
//!
//! PARITY: this helper is Rust ENTRY PLUMBING (the same category as
//! `lighthouse-server` / `lighthouse-desktop`), not shared engine behavior, so
//! it has NO `src/server` twin — the two TS transports wire the equivalent
//! inline in `app/api/chat`. Only `answer_pipeline` (which it calls) is twinned.

use std::pin::Pin;

use futures::{Stream, StreamExt};

use crate::contracts::{ChatChunk, ChatTurn, CostMeta};

/// Options for a headless ask. `#[derive(Default)]` yields the inert posture:
/// the profile's provider, the ambient vault, no investigation, no explicit
/// attachments — a caller opts INTO each departure from that baseline.
#[derive(Debug, Clone, Default)]
pub struct AskOpts {
    /// Force the local (on-device, key-less) provider — the zero-network path.
    /// Most-restrictive wins: this OR a `local-only` investigation forces
    /// device (see `run_headless_ask`).
    pub local: bool,
    /// The conversation whose ATTACHMENTS this ask reads. `None` is an ask
    /// with no corpus — it answers from the model alone and cites nothing.
    pub conversation_id: Option<String>,
    /// The attachment ids to scope this question to. Empty = the whole
    /// conversation.
    pub attachment_ids: Vec<String>,
}

/// Answer `question` headlessly, streaming `ChatChunk`s UNCHANGED — the SAME
/// stream the app sees, including the final chunk's `ChunkMeta` provenance
/// stamp (`origin`, `cost`, `manifest`). Reproduces the transport wrapper
/// EXACTLY (`routes.rs::chat_post` / `commands.rs::chat_ask`):
///
/// 1. Base config: `profile::local_model_config()` when `opts.local`, else
///    `profile::model_config()` — the same swap `resolve_ask_context` performs
///    for a `local-only` investigation, so `--local` and a local-only
///    investigation reach the identical zero-network config.
/// 2. `investigations::resolve_ask_context` resolves scope + provider policy at
///    this one chokepoint: a `local-only` investigation swaps `cfg` to local
///    HERE regardless of `opts.local` (most-restrictive wins — either forces
///    device), while local-only-marked scope files stay readable to the private
///    model.
/// 3. `AnswerAudit::start` captures the egress baseline before the stream;
///    `.finish` records the per-question egress DELTA plus the provider, the
///    files read, and the NEW cost meter (`audit::ask_new_cost(&meta)`, which is
///    None on a cache replay so the running total never double-counts).
/// 4. `answer_pipeline` runs in between with the privacy-safe cache/plan
///    defaults (`CacheCtl::default()` — memory-only, no disk mirror;
///    `PlanCtl::default()` — an ordinary ask, not a plan preview).
///
/// The provenance a caller reports is READ from the final `ChunkMeta` stamp —
/// the engine's own account of where the answer was computed and what it cost —
/// never recomputed or model-authored.
pub fn run_headless_ask(
    question: String,
    included_ids: Vec<String>,
    history: Vec<ChatTurn>,
    opts: AskOpts,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    // Destructure up front so the fields move cleanly into the sync setup below
    // and the stream body — no partial-move gymnastics.
    let AskOpts {
        local,
        conversation_id,
        attachment_ids,
    } = opts;

    // (1) Base config — local (device) when forced, else the profile's.
    let cfg = if local {
        crate::profile::local_model_config()
    } else {
        crate::profile::model_config()
    };

    // (2) Investigations retired with the 0.15.0 refocus: an ask's files are
    // its attachments, and there is no scope, provider policy or recall
    // preference to resolve any more.
    let attachments = attachment_ids;
    let preferred_conversation_ids: Vec<String> = Vec::new();

    // (3) Audit log: capture the question + egress baseline before the answer;
    // the delta + provider + files + new cost are recorded once the final chunk
    // lands. `provider` is read from the RESOLVED cfg (post local-only swap),
    // exactly as `chat_post`/`chat_ask` derive it.
    let audit = crate::audit::AnswerAudit::start(&question);
    let provider = cfg.provider_id.clone().unwrap_or_else(|| "none".to_string());

    Box::pin(async_stream::stream! {
        // (4) The whole ask path — single-shot RAG or multi-document synthesis —
        // lives in the engine pipeline, so a headless ask behaves identically to
        // an app ask. Cache/plan controls take the privacy-safe defaults
        // (memory-only cache, no disk mirror, no plan preview).
        let mut chunks = crate::synth::answer_pipeline(
            question,
            included_ids,
            attachments,
            history,
            cfg,
            crate::answer_cache::CacheCtl::default(),
            crate::beam::PlanCtl::default(),
            preferred_conversation_ids,
            // A headless ask names files on the command line; the caller has
            // already attached them to a conversation and names it here.
            crate::synth::Corpus { conversation_id },
        );
        let mut final_files: Vec<String> = Vec::new();
        let mut artifacts: Vec<String> = Vec::new();
        // The NEW cost this ask incurred, read from the final chunk's meter; a
        // cache replay computes nothing (`ask_new_cost` is None on `cached_at`),
        // so the running audit total never double-counts.
        let mut answer_cost: Option<CostMeta> = None;
        while let Some(c) = chunks.next().await {
            if c.done {
                if let Some(refs) = &c.references {
                    final_files = refs.iter().map(|r| r.file_id.clone()).collect();
                }
                if let Some(a) = &c.analytics {
                    artifacts.extend(a.file_ids.iter().cloned());
                }
                if let Some(meta) = &c.meta {
                    answer_cost = crate::audit::ask_new_cost(meta);
                }
            }
            // Chunks stream through UNCHANGED — the caller sees the same stream
            // (and the same final `ChunkMeta`) the app sees.
            yield c;
        }
        // Fires AFTER the whole stream drains — the `chat_post` timing verbatim.
        audit.finish(&provider, final_files, artifacts, answer_cost);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure unit tests only — the store-touching scenarios (audit record written,
    // local forces device with no egress, replay records 0 new cost, provenance
    // equals the ChunkMeta stamp, and the `opts.vault` ⇒ state-root mapping) live
    // in tests/ask_test.rs, serialized by the shared VAULT_DIR env lock. Keeping
    // these tests env-free avoids racing the other modules' store tests in the
    // shared `--lib` binary.

    #[test]
    fn askopts_default_is_inert() {
        // The derived Default is the baseline every departure opts INTO: the
        // profile's provider (not forced local), no corpus, no attachments.
        let opts = AskOpts::default();
        assert!(!opts.local, "default does not force the local provider");
        assert!(opts.conversation_id.is_none(), "default names no conversation");
        assert!(
            opts.attachment_ids.is_empty(),
            "default attaches no explicit files"
        );
    }
}
