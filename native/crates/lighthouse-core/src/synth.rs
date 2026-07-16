//! Multi-document synthesis pipeline (Phase 1 — docs/multi-doc-synthesis.md),
//! the Rust twin of src/server/synth.ts. One entry point for the whole ask
//! path: single-shot RAG (with exact table profiles for CSV hits) or a
//! map→reduce plan over 2..6 documents, streamed as ChatChunks with
//! pre-answer `progress` notes. Prompts, trigger rules, and formats MUST stay
//! byte-identical with the TS side.

use std::pin::Pin;

use futures::{Stream, StreamExt};

use crate::contracts::{AnalyticsMeta, ChatChunk, ChatProgress, ChunkMeta, ChatTurn, RagReference};
use crate::llm::{self, Ctx, ModelCfg};
use crate::table_profile::{is_profileable, table_profile};
use crate::{sources, vault};

/// Budgets — mirrored in src/server/synth.ts.
const MAX_MAP_DOCS: usize = 6;
const MIN_MAP_DOCS: usize = 2;
const PER_DOC_CHUNKS: usize = 3;
const WIDE_K: usize = 24;
const MAP_EXTRACT_CHARS: usize = 1800;
const PREVIEW_CHARS: usize = 1600;
const SNIPPET_CHARS: usize = 240;
const ASSUMED_DOC_SCORE: f64 = 0.75;
/// Single-document focus (0.11, field report "partial answers"): a question
/// that clearly targets ONE document is answered from ALL of it — full
/// inclusion when the doc fits the provider budget, else a segment sweep over
/// every chunk — instead of the top-k sample. Dominance = this many of the
/// initial k=5 context blocks from one file.
const DOC_FOCUS_DOMINANCE: usize = 4;

// --- Trigger -------------------------------------------------------------------

const CUE_WORDS: &[&str] = &[
    "across", "compare", "compared", "comparing", "comparison", "versus", "vs",
    "synthesize", "synthesise", "combine", "combined", "overall",
    "differ", "differs", "difference", "differences", "trend", "trends",
];
const CUE_PHRASES: &[&str] = &[
    "all my files", "all my documents", "all my docs", "all the files",
    "all the documents", "all of my", "all of the", "each file", "each document",
    "each doc", "each of", "every file", "every document", "both files",
    "both documents", "both reports", "these files", "these documents",
    "my files", "my documents", "between the",
];

/// Whether a question reads as a cross-document ask. Pure; unit-tested; the
/// normalization matches the TS crossDocCue exactly.
pub fn cross_doc_cue(question: &str) -> bool {
    let lower = question.to_lowercase();
    let mut norm = String::with_capacity(lower.len());
    let mut last_space = true;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            norm.push(ch);
            last_space = false;
        } else if !last_space {
            norm.push(' ');
            last_space = true;
        }
    }
    let norm = norm.trim().to_string();
    let padded = format!(" {norm} ");
    for p in CUE_PHRASES {
        if padded.contains(&format!(" {p} ")) {
            return true;
        }
    }
    norm.split(' ').any(|t| CUE_WORDS.contains(&t))
}

/// G6: how much a recall cue lifts past-conversation candidates before ranking
/// (applied in `vault::retrieve`). Keep identical in the TS twin.
pub const CONV_BOOST: f64 = 1.5;

/// Recall preference for the current investigation (openspec:
/// add-investigations): where `CONV_BOOST` applies, a conversation note
/// BELONGING to the ask's investigation (its filename's `[cid8]` matches a
/// preferred conversation id) is lifted this much FURTHER — preference, not
/// exclusion: global notes still surface, ordered after. Applied in
/// `vault::retrieve`. PARITY: keep identical to
/// src/server/vault.ts::INVESTIGATION_BOOST.
pub const INVESTIGATION_BOOST: f64 = 1.3;

/// Anchored recall frames — a "what did I …" self-reference, not loose keywords.
/// KEEP BYTE-IDENTICAL with the TS twin.
const RECALL_FRAMES: &[&str] = &[
    "what did i ask", "what did i conclude", "what did we conclude",
    "what did i say", "what did i decide", "did i ask", "have i asked",
    "what did i find", "what have i asked",
];

/// G6 recall meta-cue: does the question ask what the USER previously asked,
/// said, concluded, decided, or found? Anchored frames (not loose keywords) so
/// ordinary questions never trigger. It BIASES retrieval toward past-conversation
/// notes; unlike the meta cues it never short-circuits to a model-free answer —
/// full synthesis still runs. Pure; normalization matches `cross_doc_cue`.
/// KEEP BYTE-IDENTICAL with the TS twin (src/server/vault.ts::recallCue).
pub fn recall_cue(question: &str) -> bool {
    let lower = question.to_lowercase();
    let mut norm = String::with_capacity(lower.len());
    let mut last_space = true;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            norm.push(ch);
            last_space = false;
        } else if !last_space {
            norm.push(' ');
            last_space = true;
        }
    }
    let padded = format!(" {} ", norm.trim());
    RECALL_FRAMES.iter().any(|f| padded.contains(&format!(" {f} ")))
}

/// G6: the synthesis prompt label for a retrieved context. A past-conversation
/// note is announced as such so the model knows the block is the user's OWN
/// earlier chat (not a source document); ordinary files keep their name. This is
/// the text the model reads via `build_prompt`'s `[{n}] {name}` header. KEEP
/// BYTE-IDENTICAL with the TS twin string in src/server/synth.ts.
fn ctx_label(c: &vault::Context) -> String {
    match c.kind {
        crate::contracts::SourceKind::Conversation => {
            "from your past Lighthouse conversation".to_string()
        }
        crate::contracts::SourceKind::File => c.name.clone(),
    }
}

// --- Document candidates ---------------------------------------------------------

#[derive(Debug, Clone)]
pub struct DocCandidate {
    pub id: String,
    pub name: String,
    /// Aggregate relevance in [0,1] — reused as the doc-level reference score.
    pub score: f64,
}

/// Group per-chunk references by file, rank by summed score, normalize to [0,1].
pub fn rank_docs_from_hits(refs: &[RagReference], max: usize) -> Vec<DocCandidate> {
    let mut by_file: Vec<DocCandidate> = Vec::new();
    for r in refs {
        match by_file.iter_mut().find(|d| d.id == r.file_id) {
            Some(d) => d.score += r.score,
            None => by_file.push(DocCandidate {
                id: r.file_id.clone(),
                name: r.name.clone(),
                score: r.score,
            }),
        }
    }
    by_file.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    by_file.truncate(max);
    let top = by_file.first().map(|d| d.score).filter(|s| *s > 0.0).unwrap_or(1.0);
    for d in &mut by_file {
        d.score = (d.score / top).min(1.0);
    }
    by_file
}

// --- Single-document focus (doc-focus) ---------------------------------------------

/// The one file that dominates the initial hits: at least
/// DOC_FOCUS_DOMINANCE of the context blocks come from a single file.
/// Contexts don't carry file ids, so names are counted and mapped back
/// through the (per-file-deduped) references; a display name shared by two
/// referenced files is ambiguous and returns None. Pure; mirrors
/// src/server/synth.ts::dominantDoc.
pub fn dominant_doc(ctx_names: &[String], refs: &[RagReference]) -> Option<(String, String)> {
    if ctx_names.len() < DOC_FOCUS_DOMINANCE {
        return None;
    }
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for n in ctx_names {
        match counts.iter_mut().find(|(name, _)| *name == n.as_str()) {
            Some((_, c)) => *c += 1,
            None => counts.push((n.as_str(), 1)),
        }
    }
    let (name, c) = counts.into_iter().max_by_key(|(_, c)| *c)?;
    if c < DOC_FOCUS_DOMINANCE {
        return None;
    }
    let matching: Vec<&RagReference> = refs.iter().filter(|r| r.name == name).collect();
    match matching.as_slice() {
        [one] => Some((one.file_id.clone(), one.name.clone())),
        _ => None,
    }
}

/// Partition ORDERED chunks into contiguous `\n\n`-joined segments of at most
/// `seg_budget` chars (a single over-budget chunk still gets its own
/// segment; order is preserved). Pure; mirrors synth.ts::partitionSegments.
pub fn partition_segments(chunks: &[String], seg_budget: usize) -> Vec<String> {
    let mut segs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_chars = 0usize;
    for ch in chunks {
        let n = ch.chars().count();
        if cur_chars > 0 && cur_chars + 2 + n > seg_budget {
            segs.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        if cur_chars > 0 {
            cur.push_str("\n\n");
            cur_chars += 2;
        }
        cur.push_str(ch);
        cur_chars += n;
    }
    if cur_chars > 0 {
        segs.push(cur);
    }
    segs
}

/// Evenly-spaced sample of at most `max` segments (all of them when they
/// fit), plus the pre-sample total for the honesty note. First and last
/// segments are always kept. Pure; mirrors synth.ts::sampleSegments.
pub fn sample_segments(segs: Vec<String>, max: usize) -> (Vec<String>, usize) {
    let total = segs.len();
    if total <= max || max == 0 {
        return (segs, total);
    }
    let mut out: Vec<String> = Vec::with_capacity(max);
    for i in 0..max {
        let idx = if max == 1 {
            0
        } else {
            i * (total - 1) / (max - 1)
        };
        out.push(segs[idx].clone());
    }
    (out, total)
}

// --- Map step --------------------------------------------------------------------

/// The extraction ask wrapped around the user's question for each map call.
/// KEEP BYTE-IDENTICAL with src/server/synth.ts::mapQuestion.
pub fn map_question(question: &str) -> String {
    format!(
        "From this single document, extract every fact, figure, date, and quote \
         relevant to answering the question below. Reply as concise bullet points \
         and include exact numbers verbatim. If nothing in it is relevant, reply \
         with exactly NO_RELEVANT_CONTENT.\n\nQuestion: {question}"
    )
}

/// Strip `[n]` citation markers (with any directly-preceding whitespace) — the
/// reduce step mints its own numbering over documents. Equivalent to the TS
/// replace(/\s*\[\d{1,3}\]/g, "").
pub fn strip_markers(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j < chars.len() && chars[j] == '[' {
            let mut k = j + 1;
            let mut digits = 0;
            while k < chars.len() && chars[k].is_ascii_digit() && digits < 4 {
                k += 1;
                digits += 1;
            }
            if (1..=3).contains(&digits) && k < chars.len() && chars[k] == ']' {
                i = k + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

// --- Pipeline --------------------------------------------------------------------

/// Providers that can actually run map calls (the keyless extractive fallback
/// answers single-shot only).
fn has_real_model(cfg: &ModelCfg) -> bool {
    match cfg.provider_id.as_deref() {
        Some("local") => true,
        Some(id) if id == "anthropic" || crate::llm::remote_provider(id).is_some() => {
            cfg.api_key.as_deref().is_some_and(|k| !k.is_empty())
        }
        _ => false,
    }
}

/// The provenance origin for this answer's stamp: `"device"` for the local
/// model or the model-free/extractive fallback (no provider configured), else
/// the cloud provider id. Agrees with the audit record's `provider` (which the
/// choke point derives as `cfg.provider_id` or `"none"`) under the
/// device⇔local/none mapping. KEEP IN SYNC with src/server/synth.ts::originOf.
fn origin_of(cfg: &ModelCfg) -> String {
    match cfg.provider_id.as_deref() {
        Some("local") | None => "device".to_string(),
        Some(id) => id.to_string(),
    }
}

/// Whether a CLOUD provider is active — the single predicate that arms
/// local-only enforcement. A keyed remote vendor is cloud; the on-device model
/// and the model-free/extractive fallback are not (`origin == "device"`). Note
/// this is keyed on provider IDENTITY, not on whether a key is present: a
/// selected-but-keyless cloud provider still counts as cloud, so local-only
/// marks fail CLOSED toward privacy even before a key is entered. Reused by the
/// pipeline and the `suggestedAsks` op. KEEP IN SYNC with synth.ts::isCloudProvider.
pub fn is_cloud_provider(cfg: &ModelCfg) -> bool {
    origin_of(cfg) != "device"
}

/// The honest skip note appended to a CLOUD answer that dropped `n ≥ 1` files
/// solely because they are marked local-only. Engine-emitted, never model-
/// generated; byte-identical to synth.ts::localOnlySkipNote (per docs/ts-twin.md
/// rule 2). Mirrors the shape of the named-but-excluded note.
pub fn local_only_skip_note(n: usize) -> String {
    let (files, them) = if n == 1 { ("file", "it") } else { ("files", "them") };
    format!(
        "_({n} {files} skipped — marked private (this device only), so the AI can't send {them} to a cloud model. Switch to the private model to include {them}.)_\n\n"
    )
}

fn progress(label: String, step: usize, total: usize) -> ChatChunk {
    ChatChunk {
        delta: String::new(),
        references: None,
        progress: Some(ChatProgress { label, step, total }),
        analytics: None,
        draft: None,
        meta: None,
        done: false,
    }
}

fn delta(d: String) -> ChatChunk {
    ChatChunk {
        delta: d,
        references: None,
        progress: None,
        analytics: None,
        draft: None,
        meta: None,
        done: false,
    }
}

/// One provisional extractive draft chunk (G2): instant, already-in-hand text
/// emitted as a single chunk (no per-word streaming) that the UI replaces in
/// place with the first authoritative delta. PARITY: mirrored in src/server/synth.ts.
fn draft_chunk(d: String) -> ChatChunk {
    ChatChunk {
        delta: d,
        references: None,
        progress: None,
        analytics: None,
        draft: Some(true),
        meta: None,
        done: false,
    }
}

/// The terminating chunk, stamped with the engine-computed provenance
/// (privacy-legibility). `excerpt_count` is the number of context blocks the
/// branch that ran actually handed to the model; `source_file_count` is derived
/// here from the references so it can never drift from what's cited (and from
/// the audit record's `fileIds`, which are those same refs' ids). KEEP IN SYNC
/// with src/server/synth.ts::finalChunk.
fn final_chunk(references: Vec<RagReference>, excerpt_count: usize, origin: &str) -> ChatChunk {
    let source_file_count = references.len();
    ChatChunk {
        delta: String::new(),
        references: Some(references),
        progress: None,
        analytics: None,
        draft: None,
        meta: Some(ChunkMeta {
            origin: origin.to_string(),
            excerpt_count,
            source_file_count,
            // Live answers never carry the replay stamp; the answer-cache
            // wrapper adds `cached_at` only when it replays a stored entry.
            cached_at: None,
        }),
        done: true,
    }
}

async fn collect(mut s: llm::AnswerStream) -> String {
    let mut out = String::new();
    while let Some(d) = s.next().await {
        out.push_str(&d);
    }
    out
}

fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Citation sample + full read-set from the registered tables. Refs cite up
/// to 3 real member files per registration (ids the explorer can open);
/// meta ids flatten EVERY file read (all group members) — what the
/// refinement chips, Save-as-CSV, and pins act on.
fn analytics_refs(regs: &[crate::analytics::TableReg]) -> (Vec<RagReference>, Vec<String>) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut refs: Vec<RagReference> = Vec::new();
    let mut meta_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut meta_ids: Vec<String> = Vec::new();
    for r in regs {
        let snippet: String = r.card.chars().take(240).collect();
        match &r.group {
            // A unioned family cites its first members — real ids the
            // explorer can open.
            Some(g) => {
                for (id, name) in g.file_ids.iter().zip(&g.file_names).take(3) {
                    if seen.insert(id.clone()) {
                        refs.push(RagReference {
                            file_id: id.clone(),
                            name: name.clone(),
                            snippet: snippet.clone(),
                            score: 0.9,
                            kind: crate::vault::source_kind_of(id),
                        });
                    }
                }
                for id in &g.file_ids {
                    if meta_seen.insert(id.clone()) {
                        meta_ids.push(id.clone());
                    }
                }
            }
            None => {
                if seen.insert(r.file_id.clone()) {
                    refs.push(RagReference {
                        file_id: r.file_id.clone(),
                        name: r.file_name.clone(),
                        snippet,
                        score: 0.9,
                        kind: crate::vault::source_kind_of(&r.file_id),
                    });
                }
                if meta_seen.insert(r.file_id.clone()) {
                    meta_ids.push(r.file_id.clone());
                }
            }
        }
    }
    (refs, meta_ids)
}

/// The full ask path — see the module docs. Every surface (axum route,
/// desktop IPC) forwards these chunks verbatim. This wrapper is the answer
/// cache's ONE choke point (openspec: add-answer-cache): the key is computed
/// ONCE at ask entry — BEFORE retrieval — from the same inputs the live
/// pipeline will use; a hit replays the stored answer verbatim (one text chunk
/// + the final chunk re-stamped with `cachedAt`) with zero retrieval and zero
/// model calls; a miss (or `bypass_cache`, the Re-run affordance) runs
/// `live_pipeline` unchanged and inserts only a SUCCESSFUL, COMPLETED answer
/// under the ask-time key. Any cache doubt already read as a miss inside
/// `answer_cache`, so this layer can only add speed, never break an answer.
/// `preferred_conversation_ids` (openspec: add-investigations) is the ask's
/// investigation's conversationRefs — retrieval's recall preference; empty
/// when no investigation rides the ask.
/// KEEP IN SYNC with src/server/synth.ts::answerPipeline.
pub fn answer_pipeline(
    question: String,
    included_file_ids: Vec<String>,
    attachment_file_ids: Vec<String>,
    history: Vec<ChatTurn>,
    cfg: ModelCfg,
    cache: crate::answer_cache::CacheCtl,
    preferred_conversation_ids: Vec<String>,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    Box::pin(async_stream::stream! {
        let is_cloud = is_cloud_provider(&cfg);
        // Key at ask entry (blocking: one cached walk + a stat per candidate).
        // A panicked helper degrades to "no cache this ask", never a failure.
        let key: Option<String> = {
            let q = question.clone();
            let provider = cfg.provider_id.clone();
            let model = cfg.model_id.clone();
            let atts = attachment_file_ids.clone();
            let prefs = preferred_conversation_ids.clone();
            tokio::task::spawn_blocking(move || {
                crate::answer_cache::cache_key(
                    &q,
                    provider.as_deref(),
                    model.as_deref(),
                    &atts,
                    &prefs,
                    is_cloud,
                )
            })
            .await
            .ok()
        };
        if let Some(key) = &key {
            // Lookup also enforces the persistence posture (a disallowed ask
            // deletes any disk mirror even when it misses or bypasses).
            let hit = {
                let key = key.clone();
                tokio::task::spawn_blocking(move || crate::answer_cache::lookup(&key, cache))
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(hit) = hit {
                // Verbatim replay: the full text as ONE chunk (no progress, no
                // draft), then the stored final chunk plus the honesty stamp.
                yield delta(hit.text);
                yield ChatChunk {
                    delta: String::new(),
                    references: Some(hit.references),
                    progress: None,
                    analytics: hit.analytics,
                    draft: None,
                    meta: Some(ChunkMeta { cached_at: Some(hit.created_ms), ..hit.meta }),
                    done: true,
                };
                return;
            }
        }

        // Miss or bypass: run live, observing the stream so only a successful,
        // completed answer is stored. The settled text mirrors the UI's rule:
        // a provisional draft is REPLACED by the first authoritative delta.
        let mut inner = live_pipeline(
            question,
            included_file_ids,
            attachment_file_ids,
            history,
            cfg,
            preferred_conversation_ids,
        );
        let mut text = String::new();
        let mut draft_active = false;
        let mut final_chunk: Option<ChatChunk> = None;
        while let Some(c) = inner.next().await {
            if !c.delta.is_empty() {
                if c.draft == Some(true) {
                    draft_active = true;
                } else if draft_active {
                    draft_active = false;
                    text.clear();
                }
                text.push_str(&c.delta);
            }
            if c.done {
                final_chunk = Some(c.clone());
            }
            yield c;
        }
        // Insert only on successful completion: a terminating chunk with its
        // provenance stamp arrived, real text settled (never a bare draft),
        // and no engine failure note rode in the answer (llm turns provider
        // errors into "…model unavailable — …" notes, not throws — the same
        // marker the map steps already filter on).
        if let (Some(key), Some(done), false) = (key, final_chunk, draft_active) {
            if let Some(meta) = done.meta {
                if !text.trim().is_empty() && !text.contains("model unavailable —") {
                    let entry = crate::answer_cache::CachedAnswer {
                        key: String::new(), // stamped by insert
                        created_ms: crate::config::now_ms(),
                        text,
                        references: done.references.unwrap_or_default(),
                        analytics: done.analytics,
                        meta,
                    };
                    let _ = tokio::task::spawn_blocking(move || {
                        crate::answer_cache::insert(&key, entry, cache)
                    })
                    .await;
                }
            }
        }
    })
}

/// The live ask path (pre-cache behavior, byte-identical): single-shot RAG or
/// multi-document synthesis, streamed as ChatChunks.
fn live_pipeline(
    question: String,
    included_file_ids: Vec<String>,
    attachment_file_ids: Vec<String>,
    history: Vec<ChatTurn>,
    cfg: ModelCfg,
    preferred_conversation_ids: Vec<String>,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    Box::pin(async_stream::stream! {
        // Provenance origin for this answer's stamp — resolved once from the
        // active provider (agrees with the audit record's `provider`). Every
        // branch's final chunk carries it; it is never derived from model text.
        let origin = origin_of(&cfg);
        // Local-only enforcement is armed only for a CLOUD provider. On the
        // device path this is false everywhere below, so the shareable gate is a
        // no-op and on-device answers are byte-identical to today.
        let is_cloud = is_cloud_provider(&cfg);

        // Blend the previous user turn into retrieval so bare follow-ups anchor
        // to the topic (identical to the TS pipeline).
        let last_user_turn = history.iter().rev().find(|t| t.role == "user");
        let retrieval_query = match last_user_turn {
            Some(t) => format!("{}\n{}", t.content, question),
            None => question.clone(),
        };

        let initial = sources::retrieve(
            &retrieval_query,
            &included_file_ids,
            &attachment_file_ids,
            5,
            is_cloud,
            &preferred_conversation_ids,
        )
        .await;

        // Instant acknowledgment: local models take seconds to a first token,
        // but retrieval lands in milliseconds — naming the sources NOW makes
        // the answer visibly start immediately (0.6.x field feedback: "slow to
        // write… provide something instantly"). The loader shows this label
        // until real tokens replace it. KEEP IN SYNC with synth.ts.
        if !initial.references.is_empty() {
            let names: Vec<&str> =
                initial.references.iter().take(3).map(|r| r.name.as_str()).collect();
            let extra = initial.references.len().saturating_sub(names.len());
            let label = if extra > 0 {
                format!("Reading {} +{}…", names.join(", "), extra)
            } else {
                format!("Reading {}…", names.join(", "))
            };
            yield progress(label, 0, 1);
        }

        // Honesty note (deterministic, engine text): the question names a
        // vault file that ISN'T included — say so up front instead of letting
        // the model deny the file exists. Skipped for attachment-scoped asks
        // (the attach gesture already chose the files).
        if attachment_file_ids.is_empty() {
            let missing = tokio::task::spawn_blocking({
                let q = question.clone();
                move || vault::named_but_excluded(&q)
            })
            .await
            .unwrap_or_default();
            if !missing.is_empty() {
                let names = missing
                    .iter()
                    .map(|n| format!("“{n}”"))
                    .collect::<Vec<_>>()
                    .join(" and ");
                let (isare, itthem) =
                    if missing.len() == 1 { ("is", "it") } else { ("are", "them") };
                yield delta(format!(
                    "_({names} {isare} in your vault but not included, so the AI can't read {itthem}. Toggle {itthem} on in the explorer and ask again.)_\n\n"
                ));
            }
        }

        // Honesty note (deterministic, engine text): a CLOUD answer is about to
        // drop one or more files SOLELY because they are marked local-only —
        // say so plainly instead of silently omitting them. Counts the files a
        // cloud model can't be shown: attachment-scoped asks count the dropped
        // attachments; otherwise the effectively-local-only members of the
        // active-included set. Inert on the device path (`is_cloud` false ⇒ 0).
        if is_cloud {
            let scope: Vec<String> = if attachment_file_ids.is_empty() {
                vault::active_included_file_ids()
            } else {
                attachment_file_ids.clone()
            };
            let dropped = tokio::task::spawn_blocking(move || {
                vault::local_only_subset(&scope, true).len()
            })
            .await
            .unwrap_or_default();
            if dropped > 0 {
                yield delta(local_only_skip_note(dropped));
            }
        }

        // --- Vault meta-answers (openspec: add-vault-meta-answers): anchored
        //     questions ABOUT the vault (recency, inventory, column
        //     membership) answer instantly from walk metadata + the column
        //     catalog — no model call, real references. Runs before analytics
        //     (meta questions are never aggregates). Any renderer error falls
        //     through with NOTHING emitted — no partial meta output. ---
        if attachment_file_ids.is_empty() {
            if let Some(intent) = crate::meta::meta_intent(&question) {
                let ids = included_file_ids.clone();
                let rendered = tokio::task::spawn_blocking(move || {
                    crate::meta::render_meta(&intent, &ids, crate::config::now_ms(), is_cloud)
                })
                .await
                .ok()
                .and_then(|r| r.ok());
                if let Some(ans) = rendered {
                    yield delta(ans.markdown);
                    // Model-free deterministic answer: zero excerpts handed to a
                    // model, files behind it are the cited references.
                    yield final_chunk(ans.references, 0, &origin);
                    return;
                }
            }
        }

        // --- Analytics branch (docs/analytics-beam.md): aggregate ask over
        //     tabular files → model writes SQL, DataFusion executes, the model
        //     narrates the verified result. Any failure falls through silently
        //     to the paths below — analytics can only add capability. ---
        if has_real_model(&cfg) && crate::analytics::analytics_cue(&question) {
            // Shareable candidate gather: on the cloud path both branches drop
            // effectively-local-only ids, so a private table's schema card
            // (column names + sample rows) is never built for a vendor prompt.
            let candidate_ids: Vec<String> = if !attachment_file_ids.is_empty() {
                vault::shareable_subset(&attachment_file_ids, is_cloud)
            } else {
                let active: std::collections::HashSet<String> =
                    vault::shareable_file_ids(is_cloud).into_iter().collect();
                included_file_ids
                    .iter()
                    .filter(|id| active.contains(*id))
                    .cloned()
                    .collect()
            };
            let mut files: Vec<(String, String, std::path::PathBuf)> = Vec::new();
            for id in candidate_ids {
                // Scan wide so whole file families are visible to union
                // grouping; registration slots stay bounded downstream.
                if files.len() >= crate::analytics::CANDIDATE_SCAN {
                    break;
                }
                if let Some((name, abs)) = vault::doc_path(&id) {
                    // PDFs with a confident text-layer grid register as bonus
                    // tables (G3); they stay OUT of is_tabular so prose chunking
                    // and spreadsheet meta answers are unaffected.
                    if crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name) {
                        files.push((id, name, abs));
                    }
                }
            }
            if !files.is_empty() {
                yield progress("Reading table schemas…".to_string(), 1, 4);
                let ctx = datafusion::prelude::SessionContext::new();
                let regs = crate::analytics::register_tables(&ctx, &files, is_cloud).await;
                if !regs.is_empty() {
                    let mut sql_ctxs: Vec<Ctx> = regs
                        .iter()
                        .map(|r| Ctx { name: r.file_name.clone(), text: r.card.clone(), score: 1.0 })
                        .collect();
                    if let Some(hints) = crate::analytics::join_hints(&regs) {
                        sql_ctxs.push(Ctx {
                            name: "join hints".to_string(),
                            text: hints,
                            score: 0.0,
                        });
                    }
                    // --- Multi-step (openspec: add-multi-step-analytics):
                    //     a comparison/why question on a keyed REMOTE
                    //     provider may run up to 3 sequential verified
                    //     queries; the final narration sees every step's
                    //     result and no raw table data. Local models never
                    //     enter (their 6144-token window can't carry
                    //     multi-step context) — behavior there is identical
                    //     to today. Zero successful steps falls through to
                    //     the single-query path below, which keeps its own
                    //     retry; every number stays engine-computed.
                    let remote_keyed =
                        cfg.provider_id.as_deref().is_some_and(|id| id != "local");
                    if remote_keyed && crate::analytics::multi_step_cue(&question) {
                        let mut steps: Vec<crate::analytics::StepRecord> = Vec::new();
                        let mut last_chart: Option<String> = None;
                        'steps: while steps.len() < 3 {
                            let n = steps.len() + 1;
                            yield progress(format!("Planning query {n} (of up to 3)…"), n, 4);
                            let raw = collect(llm::stream_answer(
                                crate::analytics::step_question(&question, &steps),
                                sql_ctxs.clone(),
                                cfg.clone(),
                                history.clone(),
                            ))
                            .await;
                            let mut attempt =
                                match crate::analytics::parse_step_reply(&strip_markers(&raw)) {
                                    crate::analytics::StepReply::Done => break 'steps,
                                    crate::analytics::StepReply::Sql(sql) => sql,
                                };
                            for round in 0..2 {
                                yield progress(format!("Running query {n}…"), n, 4);
                                match crate::analytics::run_query(&ctx, &attempt).await {
                                    Ok(res) => {
                                        last_chart = res.chart.clone();
                                        steps.push(crate::analytics::StepRecord {
                                            sql: attempt.clone(),
                                            result_markdown: res.markdown,
                                        });
                                        continue 'steps;
                                    }
                                    Err(err) if round == 0 => {
                                        // One corrective retry with the
                                        // engine's error — the same pattern
                                        // as the single-query path.
                                        let retry_q = format!(
                                            "{}\n\nYour previous SQL failed.\nPrevious SQL: {attempt}\nError: {err}\nReply with NEXT_SQL: and a corrected single SELECT statement.",
                                            crate::analytics::step_question(&question, &steps)
                                        );
                                        let raw2 = collect(llm::stream_answer(
                                            retry_q,
                                            sql_ctxs.clone(),
                                            cfg.clone(),
                                            history.clone(),
                                        ))
                                        .await;
                                        match crate::analytics::parse_step_reply(&strip_markers(
                                            &raw2,
                                        )) {
                                            crate::analytics::StepReply::Sql(sql) => attempt = sql,
                                            crate::analytics::StepReply::Done => break 'steps,
                                        }
                                    }
                                    // Second failure ends the loop; whatever
                                    // was collected still narrates below.
                                    Err(_) => break 'steps,
                                }
                            }
                        }
                        if !steps.is_empty() {
                            yield progress("Summarizing results…".to_string(), 4, 4);
                            let mut ctxs: Vec<Ctx> = steps
                                .iter()
                                .enumerate()
                                .map(|(i, s)| Ctx {
                                    name: format!(
                                        "query {} result — computed exactly by Lighthouse",
                                        i + 1
                                    ),
                                    text: format!(
                                        "SQL:\n{}\n\nResult:\n{}",
                                        s.sql, s.result_markdown
                                    ),
                                    score: 1.0,
                                })
                                .collect();
                            ctxs.extend(regs.iter().map(|r| Ctx {
                                name: format!("{} — schema", r.file_name),
                                text: r.card.clone(),
                                score: 0.0,
                            }));
                            let excerpt_count = ctxs.len();
                            // No chart card rides multi-step (its chart is the
                            // last step's heuristic), but the fence scrub still
                            // applies: a stray chart request must never reach
                            // displayed prose. (Charts by default, 0.12.1: a
                            // "none" no longer suppresses the step chart — the
                            // engine decides chartability.)
                            let mut scrub = crate::analytics::DirectiveScrubber::new();
                            let mut answer = llm::stream_answer(
                                question.clone(),
                                ctxs,
                                cfg.clone(),
                                history.clone(),
                            );
                            while let Some(d) = answer.next().await {
                                let safe = scrub.push(&d);
                                if !safe.is_empty() {
                                    yield delta(safe);
                                }
                            }
                            let tail = scrub.finish();
                            if !tail.is_empty() {
                                yield delta(tail);
                            }
                            // Deterministic transparency: EVERY executed
                            // query in order, then ONE freshness stamp over
                            // the union of files the steps read.
                            if steps.len() == 1 {
                                yield delta(format!(
                                    "\n\n*Query used:*\n```sql\n{}\n```\n",
                                    steps[0].sql
                                ));
                            } else {
                                yield delta(format!(
                                    "\n\n*Queries used ({}):*\n",
                                    steps.len()
                                ));
                                for (i, s) in steps.iter().enumerate() {
                                    yield delta(format!(
                                        "{}.\n```sql\n{}\n```\n",
                                        i + 1,
                                        s.sql
                                    ));
                                }
                            }
                            let all_sql = steps
                                .iter()
                                .map(|s| s.sql.as_str())
                                .collect::<Vec<_>>()
                                .join("\n");
                            if let Some(fresh) = crate::analytics::freshness_line(
                                &regs,
                                &all_sql,
                                crate::config::now_ms(),
                            ) {
                                yield delta(fresh);
                            }
                            // Same row-cap honesty as the single-query path:
                            // the steps read the same registrations, so a
                            // capped workbook must disclose here too.
                            if let Some(cap) = crate::analytics::row_cap_footer(&regs) {
                                yield delta(cap);
                            }
                            // Charts by default (0.12.1): the heuristic chart
                            // of the LAST step flows regardless of any "none"
                            // directive — the engine decides chartability, and
                            // a materializing directive can't run here anyway
                            // (steps carry markdown, not batches). last_chart
                            // comes from run_query, which never charts a
                            // truncated result.
                            if let Some(chart) = &last_chart {
                                yield delta(format!("\n```lighthouse-chart\n{chart}\n```\n"));
                            }
                            // Chips act on the LAST query; the footer shows all.
                            let (refs, meta_ids) = analytics_refs(&regs);
                            let mut done = final_chunk(refs, excerpt_count, &origin);
                            done.analytics = Some(AnalyticsMeta {
                                sql: steps.last().map(|s| s.sql.clone()).unwrap_or_default(),
                                file_ids: meta_ids,
                            });
                            yield done;
                            return;
                        }
                    }

                    yield progress("Writing a query…".to_string(), 2, 4);
                    // A refining follow-up should adapt the conversation's
                    // previous query, not re-derive it from scratch.
                    let prior_sql = crate::analytics::last_query_used(&history);
                    let raw = collect(llm::stream_answer(
                        crate::analytics::sql_question(&question, prior_sql.as_deref()),
                        sql_ctxs.clone(),
                        cfg.clone(),
                        history.clone(),
                    ))
                    .await;
                    let mut attempt = crate::analytics::extract_sql(&strip_markers(&raw));
                    let mut outcome: Option<(String, crate::analytics::QueryResult)> = None;
                    for round in 0..2 {
                        let Some(sql) = attempt.clone() else { break };
                        yield progress("Running the query…".to_string(), 3, 4);
                        match crate::analytics::run_query(&ctx, &sql).await {
                            Ok(res) => {
                                outcome = Some((sql, res));
                                break;
                            }
                            Err(err) if round == 0 => {
                                // One correction round with the engine's error.
                                let retry_q = format!(
                                    "{}\n\nYour previous SQL failed.\nPrevious SQL: {sql}\nError: {err}\nWrite a corrected single SELECT statement.",
                                    crate::analytics::sql_question(&question, prior_sql.as_deref())
                                );
                                let raw2 = collect(llm::stream_answer(
                                    retry_q,
                                    sql_ctxs.clone(),
                                    cfg.clone(),
                                    history.clone(),
                                ))
                                .await;
                                attempt = crate::analytics::extract_sql(&strip_markers(&raw2));
                            }
                            Err(_) => break,
                        }
                    }
                    if let Some((sql, res)) = outcome {
                        yield progress("Summarizing results…".to_string(), 4, 4);
                        // Never present the cap as the total: when truncated the
                        // true count (from run_query's uncapped COUNT) rides here
                        // so the narration can state it honestly.
                        let count_desc = match (res.truncated, res.total) {
                            (true, Some(t)) => format!("first {} of {} rows", res.shown, t),
                            (true, None) => format!("first {} rows, truncated", res.shown),
                            _ => format!("{} row(s)", res.shown),
                        };
                        let mut ctxs: Vec<Ctx> = vec![Ctx {
                            name: "query result — computed exactly by Lighthouse".to_string(),
                            text: format!("SQL:\n{sql}\n\nResult ({count_desc}):\n{}", res.markdown),
                            score: 1.0,
                        }];
                        ctxs.extend(regs.iter().map(|r| Ctx {
                            name: format!("{} — schema", r.file_name),
                            text: r.card.clone(),
                            score: 0.0,
                        }));
                        // Chart card (openspec: add-chart-directive): the same
                        // mechanism as join hints — one low-score Ctx — added
                        // ONLY when the result is untruncated and its shape
                        // could chart, so the ~200 tokens are never spent on a
                        // doomed directive. Truncated results never chart.
                        if !res.truncated {
                            if let Some(card) = crate::analytics::chart_card(&res.batches) {
                                ctxs.push(Ctx {
                                    name: "chart options".to_string(),
                                    text: card,
                                    score: 0.0,
                                });
                            }
                        }
                        let excerpt_count = ctxs.len();
                        // The narration streams through the directive scrubber:
                        // prose forwards as it arrives, chart-request fence
                        // bytes never do (the UI strip is a second net, not
                        // the mechanism).
                        let mut scrub = crate::analytics::DirectiveScrubber::new();
                        let mut answer =
                            llm::stream_answer(question.clone(), ctxs, cfg.clone(), history.clone());
                        while let Some(d) = answer.next().await {
                            let safe = scrub.push(&d);
                            if !safe.is_empty() {
                                yield delta(safe);
                            }
                        }
                        let tail = scrub.finish();
                        if !tail.is_empty() {
                            yield delta(tail);
                        }
                        // Deterministic transparency — never model-generated.
                        yield delta(format!("\n\n*Query used:*\n```sql\n{sql}\n```\n"));
                        // …and which file versions it read, so stale-looking
                        // numbers point at the file, not the engine.
                        if let Some(fresh) = crate::analytics::freshness_line(
                            &regs,
                            &sql,
                            crate::config::now_ms(),
                        ) {
                            yield delta(fresh);
                        }
                        // Truncation honesty: a capped result states its true
                        // total deterministically (matches the model-free
                        // run_direct footer), so 200 of 12,431 never reads as 200.
                        if let Some(trunc) = crate::analytics::truncation_footer(
                            res.shown,
                            res.truncated,
                            res.total,
                        ) {
                            yield delta(trunc);
                        }
                        // Coverage honesty: if the per-ask table caps left some
                        // in-scope tabular files unanalyzed, say so — a partial
                        // analysis must never read as the whole vault's.
                        // Denominator stays spreadsheet-scoped: unregistered_count
                        // already counts only is_tabular files, so a bonus-track
                        // PDF never distorts "in-scope tabular files".
                        let tabular_total =
                            files.iter().filter(|(_, n, _)| crate::analytics::is_tabular(n)).count();
                        let dropped = crate::analytics::unregistered_count(&files, &regs);
                        if dropped > 0 {
                            yield delta(format!(
                                "_Analyzed {} of {} in-scope tabular files (engine table limit)._\n",
                                tabular_total.saturating_sub(dropped),
                                tabular_total,
                            ));
                        }
                        // Row-cap honesty: a single workbook registered to its
                        // leading rows must never read as the whole file.
                        // Engine text, deterministic; union-family omissions
                        // are covered by the coverage line above, never here.
                        if let Some(cap) = crate::analytics::row_cap_footer(&regs) {
                            yield delta(cap);
                        }
                        // Chartable result → engine-built spec the chat renders
                        // as SVG (Phase C), now directive-aware (openspec:
                        // add-chart-directive) with charts by default (0.12.1):
                        // a valid chart request REFINES which columns/kind; a
                        // "none" (or anything invalid) lands on the unchanged
                        // heuristic — a directive can never suppress a
                        // chartable result. Data comes straight from the query
                        // batches in every case; the model's text never
                        // supplies a number. Truncated results still never
                        // chart.
                        let chart = if res.truncated {
                            None
                        } else {
                            crate::analytics::decide_chart(&res.batches, scrub.full_text())
                        };
                        if let Some(chart) = &chart {
                            yield delta(format!("\n```lighthouse-chart\n{chart}\n```\n"));
                        }
                        // Citations + structured provenance (chips/save/pins).
                        let (refs, meta_ids) = analytics_refs(&regs);
                        let mut done = final_chunk(refs, excerpt_count, &origin);
                        done.analytics = Some(AnalyticsMeta { sql, file_ids: meta_ids });
                        yield done;
                        return;
                    }
                }
            }
        }

        // --- Answer-level draft-then-verify (G2): on the PRIVATE path, stream an
        //     instant extractive draft from the retrieval snippets already in
        //     hand, replaced IN PLACE by the local model's grounded answer below.
        //     Gated to the LOCAL provider + the draftAnswers preference (default
        //     on) + non-empty contexts. Meta and analytics answered/returned
        //     above, so this only ever precedes a real local-model grounded
        //     answer, never a deterministic one. The draft is a separate chunk
        //     that never enters any prompt — zero tokens against the local
        //     window. KEEP IN SYNC with src/server/synth.ts.
        if cfg.provider_id.as_deref() == Some("local")
            && crate::settings::read_desktop_settings().draft_answers != Some(false)
            && !initial.contexts.is_empty()
        {
            let ctxs: Vec<Ctx> = initial
                .contexts
                .iter()
                .map(|c| Ctx { name: ctx_label(c), text: c.text.clone(), score: c.score })
                .collect();
            let text = llm::draft_answer(&question, &ctxs);
            if !text.trim().is_empty() {
                yield draft_chunk(text);
            }
        }

        // --- Decide: synthesis or single-shot ---
        let mut docs: Vec<DocCandidate> = Vec::new();
        if has_real_model(&cfg) {
            if attachment_file_ids.len() >= MIN_MAP_DOCS {
                // Multi-attach IS the cross-document gesture — but a marked
                // attachment can't ride to a cloud model. Filter this bypasser
                // at its own choke point before any doc_text read below.
                docs = vault::shareable_subset(&attachment_file_ids, is_cloud)
                    .iter()
                    .take(MAX_MAP_DOCS)
                    .map(|id| DocCandidate { id: id.clone(), name: String::new(), score: ASSUMED_DOC_SCORE })
                    .collect();
            } else if attachment_file_ids.is_empty() && cross_doc_cue(&question) {
                let wide = sources::retrieve(
                    &retrieval_query,
                    &included_file_ids,
                    &[],
                    WIDE_K,
                    is_cloud,
                    &preferred_conversation_ids,
                )
                .await;
                docs = rank_docs_from_hits(&wide.references, MAX_MAP_DOCS);
                let active: std::collections::HashSet<String> =
                    vault::shareable_file_ids(is_cloud).into_iter().collect();
                let in_scope: Vec<&String> =
                    included_file_ids.iter().filter(|id| active.contains(*id)).collect();
                if in_scope.len() <= MAX_MAP_DOCS {
                    for id in in_scope {
                        if docs.len() >= MAX_MAP_DOCS {
                            break;
                        }
                        if !docs.iter().any(|d| &d.id == id) {
                            docs.push(DocCandidate {
                                id: id.clone(),
                                name: String::new(),
                                score: ASSUMED_DOC_SCORE,
                            });
                        }
                    }
                }
            }
        }

        if docs.len() >= MIN_MAP_DOCS {
            let total = docs.len() + 1;
            let mut extracts: Vec<(RagReference, String)> = Vec::new();

            for (i, doc) in docs.iter().enumerate() {
                let preview = vault::doc_text(&doc.id, Some(PREVIEW_CHARS));
                let name = if !doc.name.is_empty() {
                    doc.name.clone()
                } else {
                    preview.as_ref().map(|(n, _)| n.clone()).unwrap_or_else(|| doc.id.clone())
                };
                yield progress(
                    format!("Reading {} ({}/{})…", name, i + 1, docs.len()),
                    i + 1,
                    total,
                );
                let Some((_, preview_text)) = preview else { continue };

                // This document's best chunks via the attachment-scoping path.
                // doc.id is already shareable (filtered above), so is_cloud here
                // only re-affirms the guarantee. No recall preference: scoped to
                // ONE document, there is no cross-candidate order to prefer.
                let per_doc = vault::retrieve(
                    &retrieval_query,
                    &[],
                    PER_DOC_CHUNKS,
                    &[],
                    std::slice::from_ref(&doc.id),
                    is_cloud,
                    &[],
                );
                let mut ctxs: Vec<Ctx> = if per_doc.contexts.is_empty() {
                    vec![Ctx { name: name.clone(), text: preview_text.clone(), score: 1.0 }]
                } else {
                    per_doc
                        .contexts
                        .iter()
                        .map(|c| Ctx { name: ctx_label(c), text: c.text.clone(), score: c.score })
                        .collect()
                };

                // Exact numbers for tables: profile the full file, not the preview.
                let mut profile: Option<String> = None;
                if is_profileable(&name) {
                    profile = vault::doc_text(&doc.id, None)
                        .and_then(|(_, full)| table_profile(&name, &full));
                    if let Some(p) = &profile {
                        ctxs.push(Ctx {
                            name: format!("{name} — table profile"),
                            text: p.clone(),
                            score: 0.0,
                        });
                    }
                }

                let raw = collect(llm::stream_answer(
                    map_question(&question),
                    ctxs,
                    cfg.clone(),
                    Vec::new(),
                ))
                .await;
                let extract = take_chars(strip_markers(&raw).trim(), MAP_EXTRACT_CHARS);
                // A model failure mid-map is yielded as an "_(… model
                // unavailable — …)_" note (llm.rs turns provider errors into a
                // note, not a throw), so the surrounding logic never sees an
                // Err. Skip BOTH the local- and live-model forms — otherwise a
                // failure note becomes a bogus extract with a fabricated
                // citation in the reduce.
                if extract.is_empty()
                    || extract.starts_with("NO_RELEVANT_CONTENT")
                    || extract.contains("model unavailable —")
                {
                    continue;
                }

                let snippet = take_chars(
                    per_doc.contexts.first().map(|c| c.text.as_str()).unwrap_or(&preview_text),
                    SNIPPET_CHARS,
                );
                let block = match &profile {
                    Some(p) => format!("{extract}\n\n{p}"),
                    None => extract,
                };
                extracts.push((
                    RagReference {
                        file_id: doc.id.clone(),
                        name,
                        snippet,
                        score: doc.score,
                        kind: crate::vault::source_kind_of(&doc.id),
                    },
                    block,
                ));
            }

            if extracts.len() >= MIN_MAP_DOCS {
                yield progress(
                    format!("Synthesizing across {} documents…", extracts.len()),
                    total,
                    total,
                );
                let reduce_ctxs: Vec<Ctx> = extracts
                    .iter()
                    .map(|(r, t)| Ctx { name: r.name.clone(), text: t.clone(), score: r.score })
                    .collect();
                let excerpt_count = reduce_ctxs.len();
                let mut answer =
                    llm::stream_answer(question.clone(), reduce_ctxs, cfg.clone(), history.clone());
                while let Some(d) = answer.next().await {
                    yield delta(d);
                }
                yield final_chunk(
                    extracts.into_iter().map(|(r, _)| r).collect(),
                    excerpt_count,
                    &origin,
                );
                return;
            }
            // Fewer than two documents had anything to say — fall through.
        }

        // --- Single-document focus (0.11, field report "partial answers"):
        //     a question that clearly targets ONE document — a single
        //     attachment, a named file, or one file dominating the initial
        //     hits — is answered from ALL of it, not a top-k sample. Full
        //     inclusion when the doc fits the provider budget; otherwise a
        //     map sweep over every chunk (the multi-doc machinery, applied
        //     per segment). Multi-doc asks never reach here (returned above
        //     or guarded by the cue); tabular files stay on the
        //     analytics/table-profile paths. ---
        if has_real_model(&cfg) && attachment_file_ids.len() <= 1 && !cross_doc_cue(&question) {
            // Doc-focus reads the WHOLE target file into the prompt, so both of
            // its bypasser entrypoints are filtered here at their own choke
            // point: a lone local-only attachment is dropped, and named-file
            // lookup runs over the shareable set only (a marked file can't be
            // "named" into a cloud prompt). dominant_doc is safe already —
            // initial.references are shareable.
            let target: Option<(String, String)> = if attachment_file_ids.len() == 1 {
                vault::shareable_subset(&attachment_file_ids, is_cloud)
                    .into_iter()
                    .next()
                    .map(|id| (id, String::new()))
            } else {
                let named = tokio::task::spawn_blocking({
                    let q = question.clone();
                    let ids = vault::shareable_subset(&included_file_ids, is_cloud);
                    move || vault::named_file_target(&q, &ids)
                })
                .await
                .unwrap_or_default();
                named.or_else(|| {
                    let names: Vec<String> =
                        initial.contexts.iter().map(|c| c.name.clone()).collect();
                    dominant_doc(&names, &initial.references)
                })
            };
            let doc: Option<(String, String, Vec<String>)> = match target {
                Some((doc_id, _)) => {
                    let id = doc_id.clone();
                    tokio::task::spawn_blocking(move || vault::doc_chunks(&id))
                        .await
                        .unwrap_or_default()
                        .map(|(name, chunks)| (doc_id, name, chunks))
                }
                None => None,
            };
            if let Some((doc_id, name, chunks)) =
                doc.filter(|(_, n, c)| !is_profileable(n) && !c.is_empty())
            {
                let kind = crate::vault::source_kind_of(&doc_id);
                let reference = RagReference {
                    file_id: doc_id,
                    name: name.clone(),
                    snippet: take_chars(&chunks[0], SNIPPET_CHARS),
                    score: 1.0,
                    kind,
                };
                let total_chars: usize = chunks.iter().map(|c| c.chars().count()).sum::<usize>()
                    + 2 * chunks.len().saturating_sub(1);
                if total_chars <= llm::full_doc_char_budget(&cfg) {
                    // The whole document rides in one prompt.
                    yield progress(format!("Reading all of {name}…"), 1, 2);
                    let n = chunks.len();
                    let ctxs: Vec<Ctx> = chunks
                        .iter()
                        .enumerate()
                        .map(|(i, t)| Ctx {
                            name: if n == 1 {
                                name.clone()
                            } else {
                                format!("{name} — part {}/{n}", i + 1)
                            },
                            text: t.clone(),
                            // Descending scores make the local clamp's
                            // lowest-score-first drop a deterministic tail
                            // truncation (never mid-document holes).
                            score: 1.0 - i as f64 * 1e-4,
                        })
                        .collect();
                    let excerpt_count = ctxs.len();
                    let mut answer =
                        llm::stream_answer(question.clone(), ctxs, cfg.clone(), history.clone());
                    while let Some(d) = answer.next().await {
                        yield delta(d);
                    }
                    yield final_chunk(vec![reference], excerpt_count, &origin);
                    return;
                }
                // Too big for one prompt: sweep EVERY chunk in ordered
                // segments, extract per segment, then synthesize.
                let segs =
                    partition_segments(&chunks, llm::doc_segment_char_budget(&cfg));
                let (segs, total_segs) = sample_segments(segs, llm::max_doc_segments(&cfg));
                let read = segs.len();
                if read < total_segs {
                    yield delta(format!(
                        "_(Long document: read {read} of {total_segs} sections of “{name}”, evenly spread.)_\n\n"
                    ));
                }
                let steps = read + 1;
                let mut extracts: Vec<(usize, String)> = Vec::new();
                for (i, seg) in segs.iter().enumerate() {
                    yield progress(
                        format!("Reading {name} (part {}/{read})…", i + 1),
                        i + 1,
                        steps,
                    );
                    let ctxs = vec![Ctx {
                        name: format!("{name} — part {}/{read}", i + 1),
                        text: seg.clone(),
                        score: 1.0,
                    }];
                    let raw = collect(llm::stream_answer(
                        map_question(&question),
                        ctxs,
                        cfg.clone(),
                        Vec::new(),
                    ))
                    .await;
                    let extract = take_chars(strip_markers(&raw).trim(), MAP_EXTRACT_CHARS);
                    // Same failure-note filter as the multi-doc map step.
                    if extract.is_empty()
                        || extract.starts_with("NO_RELEVANT_CONTENT")
                        || extract.contains("model unavailable —")
                    {
                        continue;
                    }
                    extracts.push((i + 1, extract));
                }
                if !extracts.is_empty() {
                    yield progress(format!("Synthesizing {name}…"), steps, steps);
                    let reduce_ctxs: Vec<Ctx> = extracts
                        .iter()
                        .map(|(i, t)| Ctx {
                            name: format!("{name} — part {i}/{read}"),
                            text: t.clone(),
                            score: 1.0,
                        })
                        .collect();
                    let excerpt_count = reduce_ctxs.len();
                    let mut answer = llm::stream_answer(
                        question.clone(),
                        reduce_ctxs,
                        cfg.clone(),
                        history.clone(),
                    );
                    while let Some(d) = answer.next().await {
                        yield delta(d);
                    }
                    yield final_chunk(vec![reference], excerpt_count, &origin);
                    return;
                }
                // Every segment came back empty/failed — fall through to the
                // ordinary single-shot path below.
            }
        }

        // --- Single-shot path + exact table stats for CSV hits ---
        let mut contexts: Vec<Ctx> = initial
            .contexts
            .iter()
            .map(|c| Ctx { name: ctx_label(c), text: c.text.clone(), score: c.score })
            .collect();
        let mut profiled = 0;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for r in &initial.references {
            if profiled >= 2 {
                break;
            }
            if seen.contains(&r.file_id) || !is_profileable(&r.name) {
                continue;
            }
            seen.insert(r.file_id.clone());
            if let Some(p) =
                vault::doc_text(&r.file_id, None).and_then(|(_, full)| table_profile(&r.name, &full))
            {
                contexts.push(Ctx {
                    name: format!("{} — table profile", r.name),
                    text: p,
                    score: 0.0,
                });
                profiled += 1;
            }
        }

        let excerpt_count = contexts.len();
        let mut answer = llm::stream_answer(question, contexts, cfg, history);
        while let Some(d) = answer.next().await {
            yield delta(d);
        }
        yield final_chunk(initial.references, excerpt_count, &origin);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(file_id: &str, name: &str, score: f64) -> RagReference {
        RagReference {
            file_id: file_id.into(),
            name: name.into(),
            snippet: String::new(),
            score,
            kind: crate::contracts::SourceKind::File,
        }
    }

    #[test]
    fn cues_trigger_and_ordinary_questions_do_not() {
        // Mirrors test/synth.cues.test.mjs.
        assert!(cross_doc_cue("Compare the Q3 report with the Q2 report"));
        assert!(cross_doc_cue("q3 versus q2 revenue"));
        assert!(cross_doc_cue("Q3 vs. Q2 — what changed?"));
        assert!(cross_doc_cue("what's the overall trend across my invoices"));
        assert!(cross_doc_cue("summarize all my documents"));
        assert!(cross_doc_cue("what does each file say about late fees?"));
        assert!(cross_doc_cue("look at both reports and tell me the difference"));
        assert!(cross_doc_cue("what do these files have in common?"));

        assert!(!cross_doc_cue("what were 2017 sales?"));
        assert!(!cross_doc_cue("summarize the onboarding doc"));
        assert!(!cross_doc_cue("when is the invoice due?"));
        assert!(!cross_doc_cue("what is on the canvas layer?"));
        assert!(!cross_doc_cue("list all caps words in the readme"));
    }

    #[test]
    fn recall_cue_triggers_on_self_reference_only() {
        // Mirrors test/recallCue.test.mjs (byte-parity with recallCue).
        assert!(recall_cue("what did I conclude about churn?"));
        assert!(recall_cue("What did we conclude on pricing"));
        assert!(recall_cue("did I ask about Q3 revenue?"));
        assert!(recall_cue("have I asked about the refund policy"));
        assert!(recall_cue("what did I decide regarding vendors"));
        assert!(recall_cue("what did I find in the audit"));
        // Ordinary questions must NOT trigger.
        assert!(!recall_cue("what is churn?"));
        assert!(!recall_cue("conclude the report"));
        assert!(!recall_cue("what did the memo say?"));
        assert!(!recall_cue("summarize my invoices"));
        assert!(!recall_cue("what were 2017 sales?"));
    }

    #[test]
    fn source_kind_is_path_based_and_exact() {
        use crate::contracts::SourceKind;
        use crate::vault::source_kind_of;
        assert_eq!(source_kind_of("Lighthouse Notes/Chats/My chat [ab12cd34].md"), SourceKind::Conversation);
        assert_eq!(source_kind_of("Lighthouse Notes/x.md"), SourceKind::File);
        assert_eq!(source_kind_of("a/b.md"), SourceKind::File);
        assert_eq!(source_kind_of(""), SourceKind::File);
        // The trailing slash is required — a sibling folder is NOT a conversation.
        assert_eq!(source_kind_of("Lighthouse Notes/Chatsz/x.md"), SourceKind::File);
    }

    #[test]
    fn ctx_label_announces_conversations_only() {
        use crate::contracts::SourceKind;
        let conv = crate::vault::Context {
            name: "My chat [ab12cd34].md".into(),
            text: String::new(),
            score: 1.0,
            kind: SourceKind::Conversation,
        };
        let file = crate::vault::Context {
            name: "q3.csv".into(),
            text: String::new(),
            score: 1.0,
            kind: SourceKind::File,
        };
        assert_eq!(ctx_label(&conv), "from your past Lighthouse conversation");
        assert_eq!(ctx_label(&file), "q3.csv");
    }

    #[test]
    fn rank_docs_groups_sums_and_normalizes() {
        let refs = vec![
            r("a", "a.md", 0.9),
            r("b", "b.md", 0.8),
            r("a", "a.md", 0.7),
            r("c", "c.md", 0.2),
        ];
        let docs = rank_docs_from_hits(&refs, 6);
        let ids: Vec<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(docs[0].score, 1.0);
        assert_eq!(docs[1].score, 0.5);
    }

    #[test]
    fn strip_markers_removes_citations_and_leading_space() {
        assert_eq!(strip_markers("Total was 42 [1] exactly[2]."), "Total was 42 exactly.");
        assert_eq!(strip_markers("keep [1234] big"), "keep [1234] big");
        assert_eq!(strip_markers("[not] brackets"), "[not] brackets");
    }

    // --- doc-focus (mirrors test/docFocus.test.mjs) ---

    fn names(ns: &[&str]) -> Vec<String> {
        ns.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn dominance_requires_four_of_five_from_one_referenced_file() {
        let refs = vec![r("a", "sop.docx", 0.9), r("b", "other.md", 0.5)];
        // 4/5 from one file → dominant.
        let ctx = names(&["sop.docx", "sop.docx", "sop.docx", "sop.docx", "other.md"]);
        assert_eq!(
            dominant_doc(&ctx, &refs),
            Some(("a".to_string(), "sop.docx".to_string()))
        );
        // 3/5 → not dominant.
        let ctx = names(&["sop.docx", "sop.docx", "sop.docx", "other.md", "other.md"]);
        assert_eq!(dominant_doc(&ctx, &refs), None);
        // Too few hits overall → never dominant.
        let ctx = names(&["sop.docx", "sop.docx", "sop.docx"]);
        assert_eq!(dominant_doc(&ctx, &refs), None);
        // A display name shared by TWO referenced files is ambiguous.
        let dup = vec![r("a", "sop.docx", 0.9), r("z", "sop.docx", 0.8)];
        let ctx = names(&["sop.docx", "sop.docx", "sop.docx", "sop.docx", "sop.docx"]);
        assert_eq!(dominant_doc(&ctx, &dup), None);
    }

    #[test]
    fn segments_partition_in_order_within_budget() {
        let chunks: Vec<String> = (0..10).map(|i| format!("{i}{}", "x".repeat(99))).collect();
        // 100-char chunks, 350 budget → 3 per segment (300 + 2×2 sep = 304).
        let segs = partition_segments(&chunks, 350);
        assert_eq!(
            segs.len(),
            4,
            "{:?}",
            segs.iter().map(|s| s.len()).collect::<Vec<_>>()
        );
        assert!(segs.iter().all(|s| s.chars().count() <= 350));
        // Order preserved: first segment starts with chunk 0, last ends with 9.
        assert!(segs[0].starts_with('0'));
        assert!(segs[3].contains('9'));
        // A single over-budget chunk still lands in its own segment.
        let big = vec!["y".repeat(500)];
        assert_eq!(partition_segments(&big, 350).len(), 1);
        // Empty in, empty out.
        assert!(partition_segments(&[], 350).is_empty());
    }

    #[test]
    fn sampling_keeps_ends_and_reports_total() {
        let segs: Vec<String> = (0..23).map(|i| i.to_string()).collect();
        let (kept, total) = sample_segments(segs.clone(), 8);
        assert_eq!(total, 23);
        assert_eq!(kept.len(), 8);
        assert_eq!(kept.first().unwrap(), "0");
        assert_eq!(kept.last().unwrap(), "22");
        // Strictly increasing (no duplicates).
        let idxs: Vec<usize> = kept.iter().map(|s| s.parse().unwrap()).collect();
        assert!(idxs.windows(2).all(|w| w[0] < w[1]), "{idxs:?}");
        // Fits already → untouched.
        let (all, total) = sample_segments(segs.clone(), 23);
        assert_eq!((all.len(), total), (23, 23));
    }
}
