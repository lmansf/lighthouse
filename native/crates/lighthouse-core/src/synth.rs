//! Multi-document synthesis pipeline (Phase 1 — docs/multi-doc-synthesis.md),
//! the Rust twin of src/server/synth.ts. One entry point for the whole ask
//! path: single-shot RAG (with exact table profiles for CSV hits) or a
//! map→reduce plan over 2..6 documents, streamed as ChatChunks with
//! pre-answer `progress` notes. Prompts, trigger rules, and formats MUST stay
//! byte-identical with the TS side.

use std::pin::Pin;

use futures::{Stream, StreamExt};

use crate::contracts::{
    AnalyticsMeta, ChatChunk, ChatProgress, ChatTurn, ChunkMeta, CostMeta, CtxManifestEntry,
    PlanPreview, RagReference,
};
use crate::llm::{self, Ctx, ModelCfg};
use crate::table_profile::{is_profileable, profile_chart, table_profile};
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

/// The second-ranked source must score at least this fraction of the top
/// (references are normalized to the top = 1.0) for the ask to count as
/// genuinely cross-file. Deliberately high so an incidental tail hit never
/// trips the cross-file route. PARITY: keep identical to src/server/synth.ts.
const SECONDARY_FILE_MIN: f64 = 0.6;

/// §3 cross-file span: the initial retrieval surfaced at least two distinct
/// sources whose relevance is COMPARABLE — the second-best scores within reach
/// of the best. When true, the pipeline SKIPS the whole-file focus read (which
/// would single-source the dominant file) and lets the single-shot path answer:
/// that one model call already sees BOTH files' top chunks, so the answer
/// INTEGRATES them at no extra cost. Conservative by construction: a single
/// dominant file (the second source weak) falls through to whole-file focus.
/// `refs` are one-per-source and score-descending. Pure; mirrors
/// src/server/synth.ts::multiFileSpan.
pub fn multi_file_span(refs: &[RagReference]) -> bool {
    refs.len() >= MIN_MAP_DOCS && refs[MIN_MAP_DOCS - 1].score >= SECONDARY_FILE_MIN
}

/// §4 small-model reliability: deterministic assist blocks injected into the
/// context ONLY for the small bundled local model (`provider_id == "local"`).
/// Weak local models were denying files (and columns) that plainly exist; these
/// blocks assert, deterministically, that they do. Cloud models are capable
/// enough and never pay these tokens, and the keyless extractive fallback calls
/// no model at all — both are excluded by the provider check. A HIGH score
/// protects the blocks from the drop-lowest-first local context clamp
/// (`llm::clamp_local_contexts`), and routing them through the normal context
/// list means they are budgeted against the 6144 window automatically.
///
/// Two blocks: a capability preamble (how many files you can see; you can query
/// the tabular ones; never claim a LISTED file/column is unavailable — the
/// schema cards on the analytics path list the columns), and, when the question
/// NAMES an included file, a hard existence assertion for it.
///
/// PARITY: mirrored byte-for-byte by src/server/synth.ts::reliabilityBlocks.
/// (A per-column catalog assist is a Rust-only follow-on — the schema cards +
/// this preamble already cover column denial, and the catalog is Rust-only.)
pub fn reliability_blocks(question: &str, cfg: &ModelCfg, included_file_ids: &[String]) -> Vec<Ctx> {
    if cfg.provider_id.as_deref() != Some("local") {
        return Vec::new();
    }
    let n = included_file_ids.len();
    if n == 0 {
        return Vec::new();
    }
    // Built from joined sentence parts so the TS twin is byte-identical.
    let preamble = [
        format!("You currently have {n} file(s) available to answer from in this vault."),
        "Each appears below as a numbered context block, and the tabular ones can be queried as tables (their columns are listed in the schema cards).".to_string(),
        "Everything shown to you here IS available — never tell the user that a file or a column that appears in your context is missing or that you cannot access it.".to_string(),
        "If something you'd need is genuinely not present, say what's missing, but do not deny that a listed file or column exists.".to_string(),
    ]
    .join(" ");
    let mut out =
        vec![Ctx { name: llm::RELIABILITY_PREAMBLE_NAME.to_string(), text: preamble, score: 1.0 }];
    if let Some((_, name)) = vault::named_file_target(question, included_file_ids) {
        out.push(Ctx {
            name: llm::RELIABILITY_CONFIRMED_NAME.to_string(),
            text: format!(
                "The file \"{name}\" IS available to you right now — use it to answer; never say it is missing or that you cannot open it."
            ),
            score: 1.0,
        });
    }
    out
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

/// §35 §2: the doc-focus reduce synthesizes a WHOLE document, so left
/// uncapped it happily writes a wall. The reduce ask carries one extra
/// sentence naming the target length; a question that asks for depth
/// overrides it because the note says so. Applied ONLY at the doc-focus
/// reduce call site — the map extracts and every other ask are untouched.
/// Pure; mirrors synth.ts::reduceQuestion.
pub fn reduce_question(question: &str) -> String {
    format!("{question}\n\n(Target length: a focused summary runs about 120-250 words — go longer only when the question itself asks for depth or detail.)")
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

/// §22.4 queue-not-fail bounds. A fresh install's cold load is the long pole
/// (mmap + prefill of a ~4 GB model), so the loading wait is generous; the
/// spawn grace only needs to outlive one supervisor reconcile tick (3 s) plus
/// process start. KEEP IN SYNC with synth.ts.
const LOCAL_WARM_POLL_MS: u64 = 1_500;
const LOCAL_SPAWN_GRACE_MS: u64 = 20_000;
const LOCAL_WARM_WAIT_MS: u64 = 300_000;

/// §22.4: one step of the warm-wait state machine, pure for tests.
/// `Proceed` means "stop waiting and let the ask run" — either the server is
/// ready, or waiting can no longer help (no installed model to spawn, grace or
/// budget exhausted) and the existing unavailable→passages path is the honest
/// outcome. KEEP IN SYNC with synth.ts::warmWaitVerdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WarmStep {
    Proceed,
    Wait,
}

pub(crate) fn warm_wait_verdict(
    health: llm::LocalHealth,
    installed: bool,
    waited_ms: u64,
) -> WarmStep {
    match health {
        llm::LocalHealth::Ready => WarmStep::Proceed,
        _ if waited_ms >= LOCAL_WARM_WAIT_MS => WarmStep::Proceed,
        llm::LocalHealth::Loading => WarmStep::Wait,
        llm::LocalHealth::Down if installed && waited_ms < LOCAL_SPAWN_GRACE_MS => WarmStep::Wait,
        llm::LocalHealth::Down => WarmStep::Proceed,
    }
}

/// The user-visible warming status — staged, progressive copy (faster & calmer):
/// the message advances through reassuring phases instead of a raw ticking
/// seconds counter, so a cold model load reads as steady progress, not a
/// stopwatch. KEEP IN SYNC (byte-identical) with synth.ts::warmingLabel.
fn warming_label(waited_ms: u64) -> String {
    if waited_ms < 8000 {
        "Private model warming up…".to_string()
    } else if waited_ms < 20000 {
        "Loading the private model into memory…".to_string()
    } else {
        "Almost ready — the first private answer takes a moment…".to_string()
    }
}

/// §22.4 queue-not-fail: when the PRIVATE model is the active provider but its
/// server is still starting (fresh install, cold launch) or loading, this
/// stream yields "warming up" progress chunks until the server is healthy —
/// then ends, letting the ask run instead of racing into the
/// "Local model unavailable → passages" fallback. For any other provider (or a
/// healthy server) it ends immediately. Cancellation is inherited: dropping
/// the outer answer stream drops this stream mid-sleep.
fn local_warm_wait(cfg: &ModelCfg) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    // Guard: a warm-up only ever holds where the private model can actually
    // become healthy — the desktop shell, or a mobile shell whose plugin
    // reports an on-device backend (supported_here() folds both). Where no
    // backend exists, "warming up…" is unreachable by construction (such
    // profiles are normalized off "local" in profile.rs load; this guard makes
    // the property hold for ANY cfg a caller passes).
    let is_local =
        cfg.provider_id.as_deref() == Some("local") && crate::local_model::supported_here();
    Box::pin(async_stream::stream! {
        if !is_local {
            return;
        }
        // Waiting for a Down server only makes sense when something can bring
        // it up: the desktop supervisor with an installed model to spawn (≤ one
        // reconcile tick away), or — 0.14.1 field report — a mobile on-device
        // bridge, which the shell re-ensures at every ask (chat_ask) after iOS
        // tears its loopback listener down with app suspension; the re-bind
        // lands within a poll tick. A BYO endpoint that is simply absent
        // (Ollama not running, web twin) keeps today's immediate fallback via
        // the Down arm of the verdict.
        let installed = crate::local_model::find_installed_model().is_some()
            || crate::local_model::on_device_backend();
        let mut waited: u64 = 0;
        loop {
            match warm_wait_verdict(llm::local_health().await, installed, waited) {
                WarmStep::Proceed => return,
                WarmStep::Wait => {}
            }
            yield progress(warming_label(waited), 1, 1);
            tokio::time::sleep(std::time::Duration::from_millis(LOCAL_WARM_POLL_MS)).await;
            waited += LOCAL_WARM_POLL_MS;
        }
    })
}

/// §22.6: split the first engine-composed ```lighthouse-chart fence out of
/// deterministic answer markdown (meta answers embed one for tile/breakdown
/// results), returning (markdown without the fence, the spec) for the final
/// chunk's meta channel. Line-exact: only a fence whose opener is the entire
/// line matches — model-ish partial fences pass through untouched (and are
/// then stripped by the renderer's new-era defense, never drawn). KEEP IN
/// SYNC with synth.ts::extractChartFence.
fn extract_chart_fence(md: &str) -> (String, Option<String>) {
    let lines: Vec<&str> = md.split('\n').collect();
    let Some(start) = lines.iter().position(|l| l.trim_end() == "```lighthouse-chart") else {
        return (md.to_string(), None);
    };
    let Some(end_rel) = lines[start + 1..].iter().position(|l| l.trim_end() == "```") else {
        return (md.to_string(), None); // unclosed: not ours — leave untouched
    };
    let end = start + 1 + end_rel;
    let spec = lines[start + 1..end].join("\n");
    let mut rest: Vec<&str> = Vec::with_capacity(lines.len());
    rest.extend_from_slice(&lines[..start]);
    rest.extend_from_slice(&lines[end + 1..]);
    (rest.join("\n"), Some(spec))
}

fn progress(label: String, step: usize, total: usize) -> ChatChunk {
    ChatChunk {
        delta: String::new(),
        references: None,
        progress: Some(ChatProgress { label, step, total, intent: None }),
        analytics: None,
        draft: None,
        plan: None,
        meta: None,
        done: false,
    }
}

/// A per-iteration Beam-loop progress chunk (openspec: add-beam-loop §2.4):
/// like `progress`, but `step`/`total` carry the query index and the configured
/// budget (not a fixed phase count), and `intent` stamps a short, stable machine
/// label for the step so §3/§4/§5 can attach per iteration without re-parsing
/// the human `label`. PARITY: the analytics loop is Rust-only, so the twin never
/// emits these.
fn step_progress(label: String, step: usize, total: usize, intent: &str) -> ChatChunk {
    ChatChunk {
        delta: String::new(),
        references: None,
        progress: Some(ChatProgress { label, step, total, intent: Some(intent.to_string()) }),
        analytics: None,
        draft: None,
        plan: None,
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
        plan: None,
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
        plan: None,
        meta: None,
        done: false,
    }
}

/// The terminating chunk, stamped with the engine-computed provenance
/// (privacy-legibility). `excerpt_count` is the number of context blocks the
/// branch that ran actually handed to the model; `source_file_count` is derived
/// here from the references so it can never drift from what's cited (and from
/// the audit record's `fileIds`, which are those same refs' ids). `cost` is the
/// ask's cost meter (openspec: add-beam-loop §3.1), computed from the per-ask
/// usage sink. `manifest` is the context manifest (openspec: add-beam-loop §5) —
/// the metadata of every context block handed to the model in the branch that
/// ran, built from the already-gated shareable set; empty ⇒ omitted (a
/// model-free or degradation path assembled nothing). KEEP IN SYNC with
/// src/server/synth.ts::finalChunk.
fn final_chunk(
    references: Vec<RagReference>,
    excerpt_count: usize,
    origin: &str,
    cost: CostMeta,
    manifest: Vec<CtxManifestEntry>,
) -> ChatChunk {
    let source_file_count = references.len();
    ChatChunk {
        delta: String::new(),
        references: Some(references),
        progress: None,
        analytics: None,
        draft: None,
        plan: None,
        meta: Some(ChunkMeta {
            origin: origin.to_string(),
            excerpt_count,
            source_file_count,
            // Live answers never carry the replay stamp; the answer-cache
            // wrapper adds `cached_at` only when it replays a stored entry.
            cached_at: None,
            cost: Some(cost),
            manifest: (!manifest.is_empty()).then_some(manifest),
            // §22.6: branches that chart set this AFTER building the chunk
            // (the mutate-after pattern `done.analytics` already uses).
            chart: None,
            // §32 §3: same mutate-after pattern — only the apple-fm prose
            // contract attaches the structured table.
            table: None,
        }),
        done: true,
    }
}

/// The terminal PLAN chunk of a Phase-1 `plan_only` op (openspec: add-beam-loop
/// §4.1): the verbatim proposed step-1 SQL and the tables it would read, with
/// NOTHING executed. It rides the final-chunk seam (`done: true`) so the
/// transport closes the stream after it, carries the plan's `references` (the
/// files whose schemas the planning call saw) and an honest `cost` meter — the
/// plan-generation model call IS egress, but no SQL ran, so nothing touched the
/// vault and no narration egressed. PARITY: analytics is Rust-only, so the twin
/// never emits a plan.
fn plan_chunk(
    preview: PlanPreview,
    references: Vec<RagReference>,
    excerpt_count: usize,
    origin: &str,
    cost: CostMeta,
    manifest: Vec<CtxManifestEntry>,
) -> ChatChunk {
    let source_file_count = references.len();
    ChatChunk {
        delta: String::new(),
        references: Some(references),
        progress: None,
        analytics: None,
        draft: None,
        plan: Some(preview),
        meta: Some(ChunkMeta {
            origin: origin.to_string(),
            excerpt_count,
            source_file_count,
            cached_at: None,
            cost: Some(cost),
            // The planning context the previewed SQL was written from (schema /
            // view cards + join hints) — metadata only, the same gated set.
            manifest: (!manifest.is_empty()).then_some(manifest),
            // A plan preview draws nothing — charts belong to executed answers.
            chart: None,
            table: None,
        }),
        done: true,
    }
}

/// The ask's cost meter (openspec: add-beam-loop §3.1) built from the per-ask
/// usage sink's summed total. `total` is `sink.total()`: `Some` when a provider
/// reported usage across the ask's model calls, `None` when none did (§1.4).
/// Tokens are provider-reported measured facts; the dollar figure is a LABELED
/// ESTIMATE from the shipped price table (`$0.00` for local/loopback, absent for
/// an unknown model). An unreported ask is `reported: false` — the app shows
/// "not reported", NEVER a `chars/4` guess (constitution §14). KEEP IN SYNC with
/// the cost shape in src/server/synth.ts.
fn cost_meta(cfg: &ModelCfg, total: Option<llm::Usage>) -> CostMeta {
    match total {
        Some(u) => CostMeta {
            input_tokens: u.input,
            output_tokens: u.output,
            total_tokens: u.total(),
            reported: true,
            cost_estimate_usd: llm::cost_estimate_usd(cfg, u),
        },
        None => CostMeta {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            reported: false,
            cost_estimate_usd: None,
        },
    }
}

// --- Context manifest (openspec: add-beam-loop §5) --------------------------------
//
// A per-context-block manifest of what the model was handed — METADATA ONLY,
// never `Ctx.text`. It rides `ChunkMeta` (like the cost meter), so the answer
// cache persists it and a replay re-emits the ORIGINAL via `..hit.meta`. Every
// builder below runs AFTER the shareable-subset gate (the ctxs are assembled
// from candidate ids already filtered through `vault::shareable_subset`), so a
// cloud ask's manifest lists only the shareable subset; what was withheld is
// disclosed by `local_only_skip_note`. The `kind` strings are byte-exact and
// mirrored in the TS twin (src/server/synth.ts).

/// One manifest entry from a context block's METADATA — its `name`, `kind`,
/// `chars` (the text LENGTH, a count — never the bytes), source `file_id`, and
/// `score`. The text is deliberately absent: it stays behind the device-only
/// file inspector (inspect.rs), never in the persisted `ChunkMeta`.
fn manifest_entry(
    kind: &str,
    name: &str,
    text_len: usize,
    score: f64,
    file_id: Option<String>,
) -> CtxManifestEntry {
    CtxManifestEntry {
        name: name.to_string(),
        kind: kind.to_string(),
        chars: text_len,
        file_id,
        // The manifest is the gated shareable set, so every entry here is
        // shareable; withholding is disclosed by the skip note, not per entry.
        local_only: None,
        score,
    }
}

/// Manifest for an analytics NARRATION context (openspec: add-beam-loop §5.1),
/// derived from the SAME assembled `ctxs` the model was handed (so every name
/// and length is byte-exact to the prompt) plus its structural split: the
/// leading `n_results` blocks are engine-computed `query-result`s, the next
/// `regs.len()` are per-table `schema-card`s (each attributed to its source
/// file), and any trailing block — present only on the single-query path — is
/// the `chart-options` card.
fn analytics_manifest(
    ctxs: &[Ctx],
    n_results: usize,
    regs: &[crate::analytics::TableReg],
) -> Vec<CtxManifestEntry> {
    let mut m = Vec::with_capacity(ctxs.len());
    for c in ctxs.iter().take(n_results) {
        m.push(manifest_entry("query-result", &c.name, c.text.len(), c.score, None));
    }
    for (c, r) in ctxs.iter().skip(n_results).zip(regs.iter()) {
        m.push(manifest_entry(
            "schema-card",
            &c.name,
            c.text.len(),
            c.score,
            Some(r.file_id.clone()),
        ));
    }
    for c in ctxs.iter().skip(n_results + regs.len()) {
        m.push(manifest_entry("chart-options", &c.name, c.text.len(), c.score, None));
    }
    m
}

/// Manifest for the PLANNING context (openspec: add-beam-loop §5.1) — the
/// context the previewed/executed SQL was written from, which is exactly
/// `sql_ctxs`: the first `regs.len()` blocks are file `schema-card`s (attributed
/// to their file), the next `n_views` are saved-view `schema-card`s (virtual, no
/// file), then — when `has_semantic` — the one semantic `business-definitions`
/// block (openspec: add-semantic-layer §2.2), and any trailing block is the
/// `join-hints` card.
fn planning_manifest(
    sql_ctxs: &[Ctx],
    regs: &[crate::analytics::TableReg],
    n_views: usize,
    has_semantic: bool,
) -> Vec<CtxManifestEntry> {
    let mut m = Vec::with_capacity(sql_ctxs.len());
    for (c, r) in sql_ctxs.iter().take(regs.len()).zip(regs.iter()) {
        m.push(manifest_entry(
            "schema-card",
            &c.name,
            c.text.len(),
            c.score,
            Some(r.file_id.clone()),
        ));
    }
    for c in sql_ctxs.iter().skip(regs.len()).take(n_views) {
        m.push(manifest_entry("schema-card", &c.name, c.text.len(), c.score, None));
    }
    // The semantic block rides between the view cards and the join-hints card.
    let n_semantic = usize::from(has_semantic);
    for c in sql_ctxs.iter().skip(regs.len() + n_views).take(n_semantic) {
        m.push(manifest_entry("business-definitions", &c.name, c.text.len(), c.score, None));
    }
    for c in sql_ctxs.iter().skip(regs.len() + n_views + n_semantic) {
        m.push(manifest_entry("join-hints", &c.name, c.text.len(), c.score, None));
    }
    m
}

/// Manifest for a RETRIEVAL context (openspec: add-beam-loop §5.1/§5.3): one
/// entry per retrieved chunk, `kind` = `conversation-note` for a past-chat note
/// else `retrieved-chunk`, attributed to its source `file_id` via the per-file
/// `references` (matched by display name — references are one-per-file). The
/// entry `name` is the prompt label the model saw (`ctx_label`). Metadata only;
/// the chunk text never rides along.
fn retrieval_manifest(
    contexts: &[vault::Context],
    references: &[RagReference],
) -> Vec<CtxManifestEntry> {
    let file_of: std::collections::HashMap<&str, &str> = references
        .iter()
        .map(|r| (r.name.as_str(), r.file_id.as_str()))
        .collect();
    contexts
        .iter()
        .map(|c| {
            let kind = if c.kind == crate::contracts::SourceKind::Conversation {
                "conversation-note"
            } else {
                "retrieved-chunk"
            };
            manifest_entry(
                kind,
                &ctx_label(c),
                c.text.len(),
                c.score,
                file_of.get(c.name.as_str()).map(|s| s.to_string()),
            )
        })
        .collect()
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
    plan: crate::beam::PlanCtl,
    preferred_conversation_ids: Vec<String>,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    Box::pin(async_stream::stream! {
        let is_cloud = is_cloud_provider(&cfg);
        // Phase 1 (openspec: add-beam-loop §4.3): a `plan_only` op is a PREVIEW,
        // not an answer — it must neither read nor write the answer cache. Run
        // live directly (no key, no lookup, no insert, no posture side effect) so
        // the cache is left exactly as it was; caching keys on the APPROVED ask.
        if crate::beam::plan_only_bypasses_cache(plan.plan_only) {
            let mut inner = live_pipeline(
                question,
                included_file_ids,
                attachment_file_ids,
                history,
                cfg,
                plan,
                preferred_conversation_ids,
            );
            while let Some(c) = inner.next().await {
                yield c;
            }
            return;
        }
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
                    plan: None,
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
            plan,
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
    // Two-phase plan approval (openspec: add-beam-loop §4). `plan_only` previews
    // step-1 SQL and stops; `approved_plan` runs the approved SQL as step 1
    // without re-planning. Both apply only in the remote-keyed analytics branch;
    // everywhere else they are inert (an ordinary ask).
    plan: crate::beam::PlanCtl,
    preferred_conversation_ids: Vec<String>,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    Box::pin(async_stream::stream! {
        // Provenance origin for this answer's stamp — resolved once from the
        // active provider (agrees with the audit record's `provider`). Every
        // branch's final chunk carries it; it is never derived from model text.
        let origin = origin_of(&cfg);
        // ONE per-ask usage sink (openspec: add-beam-loop §3.1): threaded into
        // EVERY `stream_answer` call in EVERY branch below, so a single-shot,
        // doc-focus, map-reduce, recipe-narration, or multi-step answer all sum
        // their provider-reported usage here. `cost_meta(&cfg, sink.total())`
        // reads it for the final chunk's cost meter (None ⇒ "not reported").
        let sink = llm::UsageSink::new();
        // Local-only enforcement is armed only for a CLOUD provider. On the
        // device path this is false everywhere below, so the shareable gate is a
        // no-op and on-device answers are byte-identical to today.
        let is_cloud = is_cloud_provider(&cfg);

        // --- Recipe branch (openspec: add-recipes §2.2): an EXPLICIT, chip/
        //     gallery-originated `run-recipe:{id} on {table}` cue runs a
        //     DETERMINISTIC bundle of guarded SELECTs. It sits BEFORE the
        //     has_real_model gate (and before retrieval) so recipes run on cloud,
        //     local, AND extractive providers, and a structured cue never pays
        //     for retrieval it won't use. Planning is model-free; narration is
        //     skippable. A plain NL question never enters — parse_recipe_cue
        //     matches only the structured prefix naming a known built-in.
        //     PARITY: Rust-only (analytics); the TS twin has no recipe branch. ---
        if let Some(cue) = crate::recipes::parse_recipe_cue(&question) {
            let recipe = crate::recipes::lookup(&cue.id)
                .expect("parse_recipe_cue only matches a known built-in");
            yield progress("Reading table schemas…".to_string(), 1, 4);

            // Candidate gather — the SAME shareable-subset rule the analytics
            // branch uses, so a private table's bytes never reach a cloud model.
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
                if files.len() >= crate::analytics::CANDIDATE_SCAN {
                    break;
                }
                if let Some((name, abs)) = vault::doc_path(&id) {
                    if crate::analytics::is_tabular(&name) || crate::analytics::is_pdf(&name) {
                        files.push((id, name, abs));
                    }
                }
            }
            // Resolve the target table's TYPED columns the same way
            // `applicable_recipes` OFFERS it — catalog kinds for a file (a CSV
            // date reads as Date), the resolved Arrow schema for a view — so
            // what a recipe is offered on and what it runs on never disagree.
            // RISK-4: resolution reads the catalog only, never narration output.
            let catalog = tokio::task::spawn_blocking({
                let files = files.clone();
                move || crate::catalog::columns_for(&files)
            })
            .await
            .unwrap_or_default();
            let ctx = datafusion::prelude::SessionContext::new();
            let regs = crate::analytics::register_tables(&ctx, &files, is_cloud).await;
            let view_regs = crate::analytics::register_views(&ctx, &regs, is_cloud).await;

            // Map the cue's table (a file display name or a view name) to the
            // registered SQL table name + its typed columns.
            let mut resolved: Option<crate::recipes::ResolvedParams> = None;
            if let Some(fc) = catalog.iter().find(|fc| fc.name == cue.table) {
                // A union-family member maps to the family's registered table.
                let sql_table = regs
                    .iter()
                    .find(|r| {
                        r.file_id == fc.id
                            || r.group.as_ref().is_some_and(|g| g.file_ids.contains(&fc.id))
                    })
                    .map(|r| r.table.clone());
                if let Some(sql_table) = sql_table {
                    let cols: Vec<(String, crate::catalog::ColumnKind)> =
                        fc.columns.iter().map(|c| (c.name.clone(), c.kind)).collect();
                    resolved = recipe.resolve(&sql_table, &cols);
                }
            }
            if resolved.is_none() {
                if let Some(name) = view_regs
                    .iter()
                    .find(|vr| vr.name == cue.table)
                    .map(|vr| vr.name.clone())
                {
                    let cols = crate::meta::view_typed_columns(&ctx, &name).await;
                    resolved = recipe.resolve(&name, &cols);
                }
            }

            let Some(params) = resolved else {
                // Stale/unavailable target: an honest, engine-derived degradation
                // (never a fabricated or partial answer). The cue always resolves
                // here, so we NEVER fall through to answer the cue string as prose.
                yield delta(format!(
                    "The **{}** recipe needs {} in “{}”, which isn't available right now. \
                     Toggle the file on in the explorer, or pick a table that has it.\n",
                    recipe.name,
                    recipe.needs.describe(),
                    cue.table,
                ));
                yield final_chunk(Vec::new(), 0, &origin, cost_meta(&cfg, sink.total()), Vec::new());
                return;
            };

            let plan = (recipe.plan)(&params);
            // The representative query — plan[0], the recipe's primary result —
            // rides AnalyticsMeta so pin/board/save/Edit-SQL keep working: the
            // same single-SQL limitation multi-step has (RISK-2); a structured-
            // plan pin field is a deferred follow-on.
            let representative_sql =
                plan.first().map(|q| q.sql.clone()).unwrap_or_default();

            // Execute each template through the SAME model-free path a single
            // query uses (run_query = guard + execute + cap + count) into
            // StepRecords — the multi-step accumulator MINUS the model planning.
            // A template that errors (e.g. no anomaly beyond the fence → no rows)
            // drops that step; the rest continue and the footer lists only what ran.
            let mut steps: Vec<crate::analytics::StepRecord> = Vec::new();
            let mut labels: Vec<String> = Vec::new();
            let mut last_rows: Option<crate::ledger::RowFacts> = None;
            // The representative step's full result (plan[0], the query
            // AnalyticsMeta carries), retained for the §4 trust re-run.
            let mut representative_result: Option<crate::analytics::QueryResult> = None;
            for (i, q) in plan.iter().enumerate() {
                yield progress(
                    format!("Running query {} of {}…", i + 1, plan.len()),
                    2,
                    4,
                );
                if let Ok(res) = crate::analytics::run_query(&ctx, &q.sql).await {
                    last_rows = Some(crate::ledger::RowFacts::of(&res));
                    labels.push(q.label.clone());
                    let markdown = res.markdown.clone();
                    // Hold the representative query's result (plan[0]) for the §4
                    // re-run; other steps' batches drop after their markdown.
                    if q.sql == representative_sql && representative_result.is_none() {
                        representative_result = Some(res);
                    }
                    steps.push(crate::analytics::StepRecord {
                        sql: q.sql.clone(),
                        result_markdown: markdown,
                    });
                }
            }
            if steps.is_empty() {
                yield delta(format!(
                    "The **{}** recipe couldn't compute a result over “{}” — its queries \
                     returned nothing.\n",
                    recipe.name, cue.table,
                ));
                yield final_chunk(Vec::new(), 0, &origin, cost_meta(&cfg, sink.total()), Vec::new());
                return;
            }

            // Narration is SKIPPABLE (design step 5). With a model, one collect()
            // narrates over the step RESULTS (never raw tables) using the recipe's
            // narration_prompt. Extractive/no-model: nothing here — the
            // deterministic tables below ARE the answer. The footer + final chunk
            // NEVER depend on any narration output.
            // The manifest (§5) describes only what a MODEL was handed; the
            // extractive path narrates nothing, so it stays empty.
            let mut manifest: Vec<CtxManifestEntry> = Vec::new();
            if has_real_model(&cfg) {
                // §22.4 queue-not-fail: the deterministic tables above already
                // streamed — hold ONLY the narration while a freshly installed
                // or cold-launched private model finishes loading, instead of
                // letting stream_answer fail into the "unavailable" note.
                {
                    let mut w = local_warm_wait(&cfg);
                    while let Some(c) = w.next().await {
                        yield c;
                    }
                }
                yield progress("Summarizing results…".to_string(), 4, 4);
                // §32 §3c: apple-fm tiers narrate the (already compact) step
                // results WITHOUT schema cards — they inform SQL, not prose.
                // The recipe's tables stream deterministically above, so no
                // meta.table is needed (it would duplicate the displayed
                // tables). Cloud/llama keep today's assembly byte-for-byte.
                let tier = llm::narration_tier(&cfg);
                let mut ctxs: Vec<Ctx> = steps
                    .iter()
                    .zip(&labels)
                    .map(|(s, label)| Ctx {
                        name: format!("{label} — computed exactly by Lighthouse"),
                        text: format!("SQL:\n{}\n\nResult:\n{}", s.sql, s.result_markdown),
                        score: 1.0,
                    })
                    .collect();
                if !tier.is_apple_fm() {
                    ctxs.extend(regs.iter().map(|r| Ctx {
                        name: format!("{} — schema", r.file_name),
                        text: r.card.clone(),
                        score: 0.0,
                    }));
                }
                // Metadata of the narration context (result cards + schema cards
                // — none of the latter on apple tiers), built before `ctxs` is
                // handed to the model below.
                manifest = if tier.is_apple_fm() {
                    analytics_manifest(&ctxs, steps.len(), &[])
                } else {
                    analytics_manifest(&ctxs, steps.len(), &regs)
                };
                let mut scrub = crate::analytics::DirectiveScrubber::new();
                let mut answer = llm::stream_answer(
                    recipe.narration_prompt.to_string(),
                    ctxs,
                    cfg.clone(),
                    history.clone(),
                    Some(sink.clone()),
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
            }

            // Deterministic engine output: the result tables (ALWAYS — the whole
            // answer on the extractive path, evidence beside the narration on the
            // model path).
            for (s, label) in steps.iter().zip(&labels) {
                yield delta(format!("\n**{label}**\n\n{}\n", s.result_markdown));
            }
            // Engine-authored chart (add-quant-depth §2.3): a recipe that declares
            // one — the forecast band — draws it from the representative result
            // (plan[0]). §22.6: the spec rides the final chunk's meta, never the
            // streamed text (fences were the model-mangleable channel). Never
            // model-chosen; every value is the engine's.
            let recipe_chart: Option<String> =
                representative_result.as_ref().and_then(|res| recipe.chart(res));
            // Provenance footer: EVERY executed query in order (the multi-step
            // footer shape), then ONE freshness stamp over the union they read.
            if steps.len() == 1 {
                yield delta(format!(
                    "\n\n*Query used:*\n```sql\n{}\n```\n",
                    crate::sqlfmt::format_sql(&steps[0].sql)
                ));
            } else {
                yield delta(format!("\n\n*Queries used ({}):*\n", steps.len()));
                for (i, s) in steps.iter().enumerate() {
                    yield delta(format!(
                        "{}.\n```sql\n{}\n```\n",
                        i + 1,
                        crate::sqlfmt::format_sql(&s.sql)
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
                &crate::analytics::expand_views_for_freshness(&all_sql, &view_regs),
                crate::config::now_ms(),
            ) {
                yield delta(fresh);
            }
            // The §1 assumption ledger for the LAST executed step (its SQL +
            // threaded row facts) — engine-derived, never model text; the same
            // disclosure the single-query and multi-step paths emit.
            if let Some(last) = steps.last() {
                if let Some(ledger) =
                    crate::ledger::assumption_ledger_parts(&last.sql, &regs, last_rows)
                {
                    yield delta(format!("\n{ledger}\n"));
                }
            }
            // Certified answers (openspec: add-semantic-layer §3): the metrics
            // the representative query (the one AnalyticsMeta carries) verifiably
            // computed — engine-emitted after the Assumptions footer, never model
            // text; empty ⇒ no line (byte-identical to a metric-free vault).
            let semantic_eligible = crate::semantic::eligible_for_posture(is_cloud);
            let certified = crate::analytics::certified_metrics(
                &representative_sql,
                &semantic_eligible.metrics,
            );
            if !certified.is_empty() {
                yield delta(format!("\n*Certified:* {}\n", certified.join(", ")));
            }
            if let Some(cap) = crate::analytics::row_cap_footer(&regs) {
                yield delta(cap);
            }
            // Pin/board/save act on the representative query.
            let (refs, meta_ids) = analytics_refs(&regs);
            let mut done =
                final_chunk(refs, steps.len(), &origin, cost_meta(&cfg, sink.total()), manifest);
            // Trust check (openspec: add-semantic-layer §4): reconcile the
            // representative query's certified metric through the SAME guard
            // (model-free, honest degradation) when a metric certified and its
            // result is in hand.
            let metric_rec = certified.first().and_then(|name| {
                semantic_eligible.metrics.iter().find(|m| &m.name == name)
            });
            let trust = match (metric_rec, &representative_result) {
                (Some(m), Some(res)) => {
                    Some(crate::analytics::reconcile_metric(&ctx, &representative_sql, res, m).await)
                }
                _ => None,
            };
            done.analytics = Some(AnalyticsMeta {
                sql: representative_sql,
                file_ids: meta_ids,
                certified: (!certified.is_empty()).then(|| certified.clone()),
                trust,
            });
            if let Some(m) = done.meta.as_mut() {
                m.chart = recipe_chart;
            }
            yield done;
            return;
        }

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
                    // §22.6: a meta answer's engine-composed chart fence moves
                    // onto the meta channel like every other chart — the text
                    // itself must arrive fence-free (live turns strip fences).
                    let (md, meta_chart) = extract_chart_fence(&ans.markdown);
                    yield delta(md);
                    // Model-free deterministic answer: zero excerpts handed to a
                    // model, files behind it are the cited references, and the
                    // cost meter is "not reported" (no model call, so no tokens).
                    // No context was assembled for a model, so the manifest is
                    // empty (§5).
                    let mut done = final_chunk(ans.references, 0, &origin, cost_meta(&cfg, sink.total()), Vec::new());
                    if let Some(m) = done.meta.as_mut() {
                        m.chart = meta_chart;
                    }
                    yield done;
                    return;
                }
            }
        }

        // --- Analytics branch (docs/analytics-beam.md): aggregate ask over
        //     tabular files → model writes SQL, DataFusion executes, the model
        //     narrates the verified result. Any failure falls through silently
        //     to the paths below — analytics can only add capability. ---
        if has_real_model(&cfg) && crate::analytics::analytics_cue(&question) {
            // §22.4 queue-not-fail: this branch is about to ask the model to
            // write SQL — if the PRIVATE model's server is still starting or
            // loading (fresh install, cold launch), wait with "warming up"
            // progress chunks instead of racing into the unavailable fallback.
            // Bounded; deterministic stages above never waited.
            // KEEP IN SYNC with synth.ts (localWarmWait).
            {
                let mut w = local_warm_wait(&cfg);
                while let Some(c) = w.next().await {
                    yield c;
                }
            }
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
                    // Saved views resolve as virtual tables AFTER the files
                    // (openspec: add-shaped-views §2): each eligible view
                    // registers under the shared table caps and contributes a
                    // view-marked card. Zero saved views ⇒ empty, and every
                    // prompt string below is byte-identical to today.
                    let view_regs =
                        crate::analytics::register_views(&ctx, &regs, is_cloud).await;
                    // §32 §4 / §44 §1a: the planning tier decides the schema
                    // diet. On the shared-window on-device tiers (apple-fm AND
                    // the §42 mobile llama) the question ranks the tables (top 3
                    // ride) and each card is PRUNED to matched + key columns
                    // with one sample value per matched column — the floor: a
                    // question-named or synonym-matched column is never pruned.
                    // §44 §1a folded mobile llama in (it plans on a phone-class
                    // 6144 window, so it needs the same diet). Cloud and desktop
                    // llama-6144 keep every full card byte-for-byte.
                    let plan_tier = llm::narration_tier(&cfg);
                    let plan_synonyms: Vec<(String, String)> = if plan_tier.wants_pruned_plan() {
                        crate::semantic::planning_synonyms(is_cloud)
                    } else {
                        Vec::new()
                    };
                    let mut sql_ctxs: Vec<Ctx> = if plan_tier.wants_pruned_plan() {
                        crate::analytics::rank_tables(&regs, &question, &plan_synonyms)
                            .into_iter()
                            .map(|r| Ctx {
                                name: r.file_name.clone(),
                                text: crate::analytics::pruned_schema_card(
                                    r,
                                    &question,
                                    &plan_synonyms,
                                ),
                                score: 1.0,
                            })
                            .collect()
                    } else {
                        regs.iter()
                            .map(|r| Ctx {
                                name: r.file_name.clone(),
                                text: r.card.clone(),
                                score: 1.0,
                            })
                            .collect()
                    };
                    // Deterministic prompt order: file cards, view cards, the
                    // semantic business-definitions block, the vault brief, then
                    // join hints.
                    sql_ctxs.extend(view_regs.iter().map(|v| Ctx {
                        name: v.name.clone(),
                        text: v.card.clone(),
                        score: 1.0,
                    }));
                    // The semantic layer's business-definitions block (openspec:
                    // add-semantic-layer §2.2): posture-eligible metrics,
                    // synonyms, and metric-expansion examples, rendered
                    // deterministically and count-capped. Pushed here so BOTH the
                    // single-query and
                    // multi-step paths (each consumes `sql_ctxs`) see it. Zero
                    // eligible definitions ⇒ None ⇒ NOT pushed ⇒ every prompt
                    // string below is byte-identical to the pre-semantic-layer
                    // prompt (pinned by a test). PARITY: this analytics-branch
                    // injection is Rust-only (the TS twin has no analytics
                    // branch); semantic.ts::renderBlock mirrors the labels.
                    // §4: apple tiers carry only the QUESTION-MATCHED semantic
                    // entries (applicable definitions, not the whole store).
                    let semantic_block = if plan_tier.is_apple_fm() {
                        crate::semantic::prompt_block_matched(is_cloud, &question)
                    } else {
                        crate::semantic::prompt_block(is_cloud)
                    };
                    let has_semantic = if let Some(block) = semantic_block {
                        sql_ctxs.push(block);
                        true
                    } else {
                        false
                    };
                    // The vault brief (openspec: field-patch-0.12.5 §3.5): a
                    // deterministic, engine-drafted summary of the vault being
                    // answered over — file composition + the queryable tables in
                    // scope — injected as ONE editable block beside the business-
                    // definitions block. Additive and NOT part of the §3 ablation
                    // (it is the auto-derive deliverable, not a component on
                    // trial); it draws only on engine-known facts, never model
                    // prose. Empty facts ⇒ None ⇒ nothing pushed. PARITY: Rust-only
                    // injection (the TS twin has no analytics branch);
                    // vaultBrief.ts::renderBrief mirrors the renderer.
                    // §4: the vault brief is orientation prose, not SQL signal —
                    // the shared-window tiers spend those chars on schemas.
                    if !plan_tier.is_apple_fm() {
                        if let Some(brief) = crate::vault_brief::draft_brief(&regs) {
                            sql_ctxs.push(brief);
                        }
                    }
                    // Auto-derived join hints (columns shared across registered
                    // tables). The declared/curated join hints that used to win
                    // over these for a pair were removed in field-patch-0.12.5 §3
                    // (no authoring UI), so this is now the sole join-hint source.
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
                    // The Beam loop's configured step budget (openspec §2.3),
                    // hoisted so BOTH the plan-approval preview (§4) and the loop
                    // read the same value.
                    let max_steps =
                        crate::settings::read_desktop_settings().beam_max_steps_effective();

                    // === Two-phase plan approval — Phase 1 (openspec §4.1) ===
                    // A `plan_only` ask previews the step-1 SQL and STOPS: it
                    // executes no query, so nothing runs against the vault and no
                    // execution/narration egress happens. The plan-generation model
                    // call is the sole cost of previewing (surfaced honestly on the
                    // plan chunk's cost meter). Remote-keyed analytics only — local
                    // keeps its single-query path and never previews. The planner
                    // MATCHES the path that would run (the multi-step step-1 prompt
                    // for a multi_step_cue ask, else the single-query prompt), so the
                    // previewed SQL is faithful to what execution would plan; the
                    // tables are the registered names (metadata only — §5 is the
                    // full manifest).
                    if remote_keyed && plan.plan_only {
                        let multi = crate::analytics::multi_step_cue(&question);
                        yield step_progress(
                            "Planning the query…".to_string(),
                            1,
                            max_steps,
                            "planning",
                        );
                        let planner = if multi {
                            crate::analytics::step_question(&question, &[], max_steps)
                        } else {
                            // §4: one few-shot on apple tiers, all five elsewhere.
                            crate::analytics::sql_question_for(
                                plan_tier,
                                &question,
                                crate::analytics::last_query_used(&history).as_deref(),
                            )
                        };
                        let raw = collect(llm::stream_answer(
                            planner,
                            sql_ctxs.clone(),
                            cfg.clone(),
                            history.clone(),
                            Some(sink.clone()),
                        ))
                        .await;
                        let proposed = if multi {
                            match crate::analytics::parse_step_reply(&strip_markers(&raw)) {
                                crate::analytics::StepReply::Sql(sql) => Some(sql),
                                crate::analytics::StepReply::Done => None,
                            }
                        } else {
                            crate::analytics::extract_sql(&strip_markers(&raw))
                        };
                        // The plan's honest cost is the previewing call's tokens
                        // (None ⇒ "not reported"); no SQL ran, so no vault or
                        // narration egress. `refs` are the files whose schema cards
                        // the planner saw.
                        let (refs, _meta_ids) = analytics_refs(&regs);
                        let cost = cost_meta(&cfg, sink.total());
                        // Manifest (§5): the planning context the previewed SQL was
                        // written from — schema/view cards + join hints — metadata
                        // only, already the gated shareable set.
                        let manifest =
                            planning_manifest(&sql_ctxs, &regs, view_regs.len(), has_semantic);
                        match proposed {
                            Some(sql) => {
                                let tables: Vec<String> = regs
                                    .iter()
                                    .map(|r| r.file_name.clone())
                                    .chain(view_regs.iter().map(|v| v.name.clone()))
                                    .collect();
                                yield plan_chunk(
                                    PlanPreview { sql, tables },
                                    refs,
                                    sql_ctxs.len(),
                                    &origin,
                                    cost,
                                    manifest,
                                );
                            }
                            // The model proposed no query (an immediate DONE / no
                            // SQL): nothing to preview and — plan_only — nothing to
                            // execute. A bare terminal chunk closes the stream.
                            None => yield final_chunk(refs, sql_ctxs.len(), &origin, cost, manifest),
                        }
                        return;
                    }

                    if remote_keyed && crate::analytics::multi_step_cue(&question) {
                        let mut steps: Vec<crate::analytics::StepRecord> = Vec::new();
                        let mut last_chart: Option<String> = None;
                        // §32 §3c: the last step's verified rows for meta.table
                        // (apple-fm tiers only — gated where the final chunk is
                        // built; captured here because steps keep markdown, not
                        // batches).
                        let mut last_table: Option<String> = None;
                        // The last step's row facts for the assumption ledger:
                        // StepRecord keeps only result_markdown, and `res` is
                        // consumed into it below, so capture the three scalars
                        // here (cheap) rather than reparse a row count out of
                        // the markdown (unreliable). None if no step succeeds.
                        let mut last_rows: Option<crate::ledger::RowFacts> = None;
                        // The last executed step's full result, retained for the
                        // §4 trust re-run (the query AnalyticsMeta carries); the
                        // StepRecord keeps only markdown, so hold the batches here.
                        let mut last_result: Option<crate::analytics::QueryResult> = None;
                        // Per-ask token accounting (openspec: add-beam-loop §1):
                        // the ask-level `sink` (opened at the top of the pipeline)
                        // is shared across this ask's plan calls, corrective
                        // retries, and the final narration and sums their
                        // provider-reported usage (§1.3). §2 reads it through the
                        // loop's budget (below); §3 reads it for the cost meter on
                        // the final chunk.
                        // The budgeted Beam loop (openspec: add-beam-loop §2):
                        // the former bare `steps.len() < 3` count is replaced by
                        // an explicit Budget — max_steps (config `beam_max_steps`,
                        // default 2), a generous whole-loop wall-clock deadline,
                        // and the §1 token ceiling — plus a no-progress guard. The
                        // single combined plan+decide model call per iteration
                        // (§2.2) is unchanged, and every number is still computed
                        // by the guarded `run_query`. See crate::beam. (max_steps
                        // is hoisted above the plan-approval preview so both read
                        // the same budget.)
                        // §2 wires the token ceiling as unset (None ⇒ never
                        // binding); §3 supplies a real ceiling from the pricing
                        // constants. With None — and with usage possibly
                        // unreported (§1.4) — the loop still bounds on
                        // max_steps/deadline, never unbounded.
                        let mut beam = crate::beam::BeamLoop::new(crate::beam::Budget::new(
                            max_steps,
                            std::time::Instant::now() + crate::beam::DEADLINE,
                            None,
                        ));
                        // Phase 2 (openspec: add-beam-loop §4.2): an approved plan
                        // runs as step 1 with NO planning call — the plan the user
                        // saw is the plan that runs (trust, and no double plan
                        // cost). `step_one_plan` yields the seed SQL, taken once on
                        // the first iteration; the guard is NOT bypassed — the
                        // `run_query` below still runs `guard_sql` on it.
                        let mut step_one =
                            crate::beam::step_one_plan(plan.approved_plan.as_deref());
                        'steps: while beam
                            .stop_before_step(steps.len(), sink.total())
                            .is_none()
                        {
                            let n = steps.len() + 1;
                            let mut attempt = if let Some(sql) = step_one.sql.take() {
                                // Approved step-1 SQL: skip planning, execute the
                                // exact plan the user approved (guarded below).
                                sql
                            } else {
                                yield step_progress(
                                    format!("Planning query {n} (of up to {max_steps})…"),
                                    n,
                                    max_steps,
                                    "planning",
                                );
                                let raw = collect(llm::stream_answer(
                                    crate::analytics::step_question(&question, &steps, max_steps),
                                    sql_ctxs.clone(),
                                    cfg.clone(),
                                    history.clone(),
                                    Some(sink.clone()),
                                ))
                                .await;
                                match crate::analytics::parse_step_reply(&strip_markers(&raw)) {
                                    crate::analytics::StepReply::Done => break 'steps,
                                    crate::analytics::StepReply::Sql(sql) => sql,
                                }
                            };
                            // No-progress guard rule (a): a planned SQL identical
                            // to a prior step re-computes a known result — stop
                            // instead of spending budget on it.
                            if beam.is_repeat_sql(&attempt) {
                                break 'steps;
                            }
                            for round in 0..2 {
                                yield step_progress(
                                    format!("Running query {n}…"),
                                    n,
                                    max_steps,
                                    "running",
                                );
                                match crate::analytics::run_query(&ctx, &attempt).await {
                                    Ok(res) => {
                                        last_chart = res.chart.clone();
                                        last_table = crate::analytics::meta_table_json(&res);
                                        last_rows = Some(crate::ledger::RowFacts {
                                            shown: res.shown,
                                            truncated: res.truncated,
                                            total: res.total,
                                        });
                                        beam.record_step(attempt.clone());
                                        steps.push(crate::analytics::StepRecord {
                                            sql: attempt.clone(),
                                            result_markdown: res.markdown.clone(),
                                        });
                                        last_result = Some(res);
                                        continue 'steps;
                                    }
                                    Err(err) if round == 0 => {
                                        // First reply's SQL failed to advance
                                        // (no-progress guard rule b) — one
                                        // corrective retry with the engine's
                                        // error, the same pattern as the
                                        // single-query path.
                                        beam.record_non_advance();
                                        let retry_q = format!(
                                            "{}\n\nYour previous SQL failed.\nPrevious SQL: {attempt}\nError: {err}\nReply with NEXT_SQL: and a corrected single SELECT statement.",
                                            crate::analytics::step_question(&question, &steps, max_steps)
                                        );
                                        let raw2 = collect(llm::stream_answer(
                                            retry_q,
                                            sql_ctxs.clone(),
                                            cfg.clone(),
                                            history.clone(),
                                            Some(sink.clone()),
                                        ))
                                        .await;
                                        match crate::analytics::parse_step_reply(&strip_markers(
                                            &raw2,
                                        )) {
                                            crate::analytics::StepReply::Sql(sql) => {
                                                // A retry that just replays a
                                                // prior step's SQL is no
                                                // progress either (rule a).
                                                if beam.is_repeat_sql(&sql) {
                                                    break 'steps;
                                                }
                                                attempt = sql;
                                            }
                                            crate::analytics::StepReply::Done => break 'steps,
                                        }
                                    }
                                    // The corrective retry's SQL also failed:
                                    // two consecutive replies failed to advance
                                    // (rule b). record_non_advance trips the
                                    // no-progress guard, so the while-gate ends
                                    // the loop with no further model call —
                                    // whatever succeeded still narrates below
                                    // (preserves today's stop-on-double-failure).
                                    Err(_) => {
                                        beam.record_non_advance();
                                    }
                                }
                            }
                        }
                        if !steps.is_empty() {
                            yield progress("Summarizing results…".to_string(), 4, 4);
                            // §32 §3c: on the apple-fm tiers the step results
                            // (already compact aggregates) narrate WITHOUT the
                            // schema cards — they inform SQL, not prose — and
                            // the last step's verified rows ride meta.table.
                            // Cloud/llama keep today's assembly byte-for-byte.
                            let tier = llm::narration_tier(&cfg);
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
                            if !tier.is_apple_fm() {
                                ctxs.extend(regs.iter().map(|r| Ctx {
                                    name: format!("{} — schema", r.file_name),
                                    text: r.card.clone(),
                                    score: 0.0,
                                }));
                            }
                            let excerpt_count = ctxs.len();
                            // Manifest (§5): the per-step query results then the
                            // schema cards — metadata of exactly what the narration
                            // saw (the already-gated set), built before `ctxs` moves
                            // into the model call below. On apple tiers no schema
                            // card was handed over, so none is listed.
                            let manifest = if tier.is_apple_fm() {
                                analytics_manifest(&ctxs, steps.len(), &[])
                            } else {
                                analytics_manifest(&ctxs, steps.len(), &regs)
                            };
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
                                Some(sink.clone()),
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
                                    crate::sqlfmt::format_sql(&steps[0].sql)
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
                                        crate::sqlfmt::format_sql(&s.sql)
                                    ));
                                }
                            }
                            let all_sql = steps
                                .iter()
                                .map(|s| s.sql.as_str())
                                .collect::<Vec<_>>()
                                .join("\n");
                            // A step FROM a saved view still stamps its SOURCE
                            // files (the expansion is freshness-only input,
                            // never rendered).
                            if let Some(fresh) = crate::analytics::freshness_line(
                                &regs,
                                &crate::analytics::expand_views_for_freshness(
                                    &all_sql, &view_regs,
                                ),
                                crate::config::now_ms(),
                            ) {
                                yield delta(fresh);
                            }
                            // Assumption ledger (openspec: add-recipes §1) for
                            // the LAST executed step: derived from its SQL +
                            // `regs`, with the threaded row facts (`last_rows`).
                            // Same disclosure the single-query path emits; the
                            // multi-step footer still lists every query above.
                            if let Some(last) = steps.last() {
                                if let Some(ledger) = crate::ledger::assumption_ledger_parts(
                                    &last.sql, &regs, last_rows,
                                ) {
                                    yield delta(format!("\n{ledger}\n"));
                                }
                            }
                            // Certified answers (openspec: add-semantic-layer §3):
                            // the metrics the LAST executed step's SQL (the query
                            // AnalyticsMeta carries) verifiably computed — emitted
                            // after the Assumptions footer, never model text.
                            let semantic_eligible =
                                crate::semantic::eligible_for_posture(is_cloud);
                            let certified = crate::analytics::certified_metrics(
                                steps.last().map(|s| s.sql.as_str()).unwrap_or(""),
                                &semantic_eligible.metrics,
                            );
                            if !certified.is_empty() {
                                yield delta(format!("\n*Certified:* {}\n", certified.join(", ")));
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
                            // truncated result. §22.6: it rides the final
                            // chunk's meta below, never the streamed text.
                            // Cost meter (openspec: add-beam-loop §3.1): the ask's
                            // summed provider-reported usage — Some(total) when a
                            // provider reported, or None when none did (§1.4,
                            // distinct from a real 0) — becomes the final chunk's
                            // honest token/dollar meter.
                            let cost = cost_meta(&cfg, sink.total());
                            // Chips act on the LAST query; the footer shows all.
                            let (refs, meta_ids) = analytics_refs(&regs);
                            let mut done =
                                final_chunk(refs, excerpt_count, &origin, cost, manifest);
                            // Trust check (openspec: add-semantic-layer §4):
                            // reconcile the last step's certified metric through
                            // the SAME guard (model-free, honest degradation).
                            // Reconciles only when a metric certified AND its
                            // result is in hand.
                            let last_sql =
                                steps.last().map(|s| s.sql.clone()).unwrap_or_default();
                            let metric_rec = certified.first().and_then(|name| {
                                semantic_eligible.metrics.iter().find(|m| &m.name == name)
                            });
                            let trust = match (metric_rec, &last_result) {
                                (Some(m), Some(res)) => Some(
                                    crate::analytics::reconcile_metric(&ctx, &last_sql, res, m)
                                        .await,
                                ),
                                _ => None,
                            };
                            if let Some(m) = done.meta.as_mut() {
                                m.chart = last_chart.clone();
                                // §32 §3c: the last step's verified rows — the
                                // prose contract's display table (apple only).
                                if tier.is_apple_fm() {
                                    m.table = last_table.clone();
                                }
                            }
                            done.analytics = Some(AnalyticsMeta {
                                sql: last_sql,
                                file_ids: meta_ids,
                                certified: (!certified.is_empty()).then(|| certified.clone()),
                                trust,
                            });
                            yield done;
                            return;
                        }
                    }

                    // A refining follow-up should adapt the conversation's
                    // previous query, not re-derive it from scratch.
                    let prior_sql = crate::analytics::last_query_used(&history);
                    // Phase 2 (openspec: add-beam-loop §4.2) also seeds the
                    // single-query path: an approved plan runs as the query with no
                    // planning call — the guard still runs in `run_query` below.
                    let mut attempt =
                        match crate::beam::step_one_plan(plan.approved_plan.as_deref()).sql {
                            Some(sql) => Some(sql),
                            None => {
                                yield progress("Writing a query…".to_string(), 2, 4);
                                let raw = collect(llm::stream_answer(
                                    crate::analytics::sql_question_for(
                                        plan_tier,
                                        &question,
                                        prior_sql.as_deref(),
                                    ),
                                    sql_ctxs.clone(),
                                    cfg.clone(),
                                    history.clone(),
                                    Some(sink.clone()),
                                ))
                                .await;
                                crate::analytics::extract_sql(&strip_markers(&raw))
                            }
                        };
                    let mut outcome: Option<(String, crate::analytics::QueryResult)> = None;
                    // §44 §1a: up to TWO correction rounds (was one). A weak
                    // on-device model often fixes a bad column/function name once
                    // the engine's own error is fed back; a second corrected
                    // attempt meaningfully lifts the on-device SQL success rate
                    // (so the §1b profile fallback and the §2 guard fire less).
                    // Round 3's failure gives up and falls through — the trust
                    // fix guarantees the fall-through never narrates a number.
                    for round in 0..3 {
                        let Some(sql) = attempt.clone() else { break };
                        yield progress("Running the query…".to_string(), 3, 4);
                        match crate::analytics::run_query(&ctx, &sql).await {
                            Ok(res) => {
                                outcome = Some((sql, res));
                                break;
                            }
                            Err(err) if round < 2 => {
                                // Feed the engine's error back as a correction hint.
                                let retry_q = format!(
                                    "{}\n\nYour previous SQL failed.\nPrevious SQL: {sql}\nError: {err}\nWrite a corrected single SELECT statement.",
                                    crate::analytics::sql_question_for(
                                        plan_tier,
                                        &question,
                                        prior_sql.as_deref(),
                                    )
                                );
                                let raw2 = collect(llm::stream_answer(
                                    retry_q,
                                    sql_ctxs.clone(),
                                    cfg.clone(),
                                    history.clone(),
                                    Some(sink.clone()),
                                ))
                                .await;
                                attempt = crate::analytics::extract_sql(&strip_markers(&raw2));
                            }
                            Err(_) => break,
                        }
                    }
                    if let Some((sql, res)) = outcome {
                        yield progress("Summarizing results…".to_string(), 4, 4);
                        // §32 §3c: the narration tier decides the assembly. The
                        // apple-fm shared-window tiers narrate over a compact
                        // FACT SHEET — no SQL text, no raw result table, no
                        // schema cards (they inform SQL, not prose), no chart
                        // card (the compact profile forbids chart markup) —
                        // and the verified rows ride `meta.table` for the
                        // renderer. Cloud and llama-6144 keep today's assembly
                        // byte-for-byte.
                        let tier = llm::narration_tier(&cfg);
                        // Never present the cap as the total: when truncated the
                        // true count (from run_query's uncapped COUNT) rides here
                        // so the narration can state it honestly.
                        let count_desc = match (res.truncated, res.total) {
                            (true, Some(t)) => format!("first {} of {} rows", res.shown, t),
                            (true, None) => format!("first {} rows, truncated", res.shown),
                            _ => format!("{} row(s)", res.shown),
                        };
                        let mut ctxs: Vec<Ctx> = if tier.is_apple_fm() {
                            vec![Ctx {
                                name: "fact sheet — computed exactly by Lighthouse".to_string(),
                                text: crate::analytics::fact_sheet(&res),
                                score: 1.0,
                            }]
                        } else {
                            vec![Ctx {
                                name: "query result — computed exactly by Lighthouse".to_string(),
                                text: format!("SQL:\n{sql}\n\nResult ({count_desc}):\n{}", res.markdown),
                                score: 1.0,
                            }]
                        };
                        if !tier.is_apple_fm() {
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
                        }
                        // §3c: the structured display table (apple tiers only —
                        // elsewhere the model types tables as before).
                        let meta_table = if tier.is_apple_fm() {
                            crate::analytics::meta_table_json(&res)
                        } else {
                            None
                        };
                        let excerpt_count = ctxs.len();
                        // Manifest (§5): metadata of exactly what the narration
                        // saw. On apple tiers that is ONE query-result block (the
                        // fact sheet) — schema cards were never handed over, so
                        // none are listed.
                        let manifest = if tier.is_apple_fm() {
                            analytics_manifest(&ctxs, 1, &[])
                        } else {
                            analytics_manifest(&ctxs, 1, &regs)
                        };
                        // The narration streams through the directive scrubber:
                        // prose forwards as it arrives, chart-request fence
                        // bytes never do (the UI strip is a second net, not
                        // the mechanism).
                        let mut scrub = crate::analytics::DirectiveScrubber::new();
                        let mut answer = llm::stream_answer(
                            question.clone(),
                            ctxs,
                            cfg.clone(),
                            history.clone(),
                            Some(sink.clone()),
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
                        // Deterministic transparency — never model-generated.
                        // Display-formatted (§1); the executed SQL is untouched.
                        yield delta(format!(
                            "\n\n*Query used:*\n```sql\n{}\n```\n",
                            crate::sqlfmt::format_sql(&sql)
                        ));
                        // …and which file versions it read, so stale-looking
                        // numbers point at the file, not the engine. A query
                        // FROM a saved view expands to its source tables here
                        // (freshness-only input, never rendered), keeping the
                        // footer on real files.
                        if let Some(fresh) = crate::analytics::freshness_line(
                            &regs,
                            &crate::analytics::expand_views_for_freshness(&sql, &view_regs),
                            crate::config::now_ms(),
                        ) {
                            yield delta(fresh);
                        }
                        // Assumption ledger (openspec: add-recipes §1): an
                        // engine-derived "Assumptions" disclosure read entirely
                        // from the executed SQL + this result's row facts, never
                        // model text. Placed after Query-used + Computed-from so
                        // the card's disclosure order is Query used → Computed
                        // from → Assumptions. Rides in the answer text, so the
                        // answer cache stores it for free.
                        if let Some(ledger) =
                            crate::ledger::assumption_ledger(&sql, &regs, &res)
                        {
                            yield delta(format!("\n{ledger}\n"));
                        }
                        // Certified answers (openspec: add-semantic-layer §3):
                        // the metric names this answer's SQL VERIFIABLY computed
                        // (AST-equality vs the posture-eligible blessed
                        // definitions) — engine-emitted AFTER the Query-used /
                        // Computed-from / Assumptions footers, deterministic,
                        // never model text. Empty ⇒ no line, so a vault with no
                        // metrics stays byte-identical.
                        let semantic_eligible =
                            crate::semantic::eligible_for_posture(is_cloud);
                        let certified = crate::analytics::certified_metrics(
                            &sql,
                            &semantic_eligible.metrics,
                        );
                        if !certified.is_empty() {
                            yield delta(format!("\n*Certified:* {}\n", certified.join(", ")));
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
                        // §22.6: the spec rides the final chunk's meta below —
                        // never the streamed text a model could mangle.
                        // Citations + structured provenance (chips/save/pins).
                        let (refs, meta_ids) = analytics_refs(&regs);
                        let mut done = final_chunk(
                            refs,
                            excerpt_count,
                            &origin,
                            cost_meta(&cfg, sink.total()),
                            manifest,
                        );
                        // Trust check (openspec: add-semantic-layer §4): re-run
                        // the certified metric's blessed definition through the
                        // SAME guard and reconcile it to this answer — model-free,
                        // honest degradation, never breaks the answer. Only a
                        // certified metric is reconciled; a non-metric answer
                        // carries no verdict (no badge).
                        let trust = match certified.first().and_then(|name| {
                            semantic_eligible.metrics.iter().find(|m| &m.name == name)
                        }) {
                            Some(m) => {
                                Some(crate::analytics::reconcile_metric(&ctx, &sql, &res, m).await)
                            }
                            None => None,
                        };
                        done.analytics = Some(AnalyticsMeta {
                            sql,
                            file_ids: meta_ids,
                            certified: (!certified.is_empty()).then(|| certified.clone()),
                            trust,
                        });
                        if let Some(m) = done.meta.as_mut() {
                            m.chart = chart;
                            // §32 §3c: the verified rows for the renderer —
                            // Some only on apple-fm tiers (set above).
                            m.table = meta_table;
                        }
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

        // --- §22.4 queue-not-fail (model warm start): every deterministic
        //     emission is behind us (meta answers returned; recipe tables and
        //     the G2 extractive draft already streamed), so nothing instant
        //     ever waited. From here every branch talks to the model — if the
        //     PRIVATE model's server is still starting or loading (fresh
        //     install, cold launch), hold here with "warming up" progress
        //     chunks rather than racing stream_answer into the
        //     "Local model unavailable → passages" fallback. Bounded: a server
        //     that never comes up proceeds into today's fallback path.
        //     KEEP IN SYNC with synth.ts (localWarmWait). ---
        {
            let mut w = local_warm_wait(&cfg);
            while let Some(c) = w.next().await {
                yield c;
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
                    Some(sink.clone()),
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
                // Manifest (§5): one retrieved-chunk per synthesized document,
                // each attributed to its source file via the flowing reference —
                // metadata only, built before `extracts` is consumed below.
                let manifest: Vec<CtxManifestEntry> = extracts
                    .iter()
                    .map(|(r, t)| {
                        manifest_entry("retrieved-chunk", &r.name, t.len(), r.score, Some(r.file_id.clone()))
                    })
                    .collect();
                let mut answer = llm::stream_answer(
                    question.clone(),
                    reduce_ctxs,
                    cfg.clone(),
                    history.clone(),
                    Some(sink.clone()),
                );
                while let Some(d) = answer.next().await {
                    yield delta(d);
                }
                yield final_chunk(
                    extracts.into_iter().map(|(r, _)| r).collect(),
                    excerpt_count,
                    &origin,
                    cost_meta(&cfg, sink.total()),
                    manifest,
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
        // §3 cross-file span: when a SECOND file is comparably relevant, skip the
        // whole-file focus read (which would single-source the dominant file) and
        // fall through to the single-shot path — that one model call already sees
        // BOTH files' top chunks, so the answer integrates them (no extra calls).
        if has_real_model(&cfg)
            && attachment_file_ids.len() <= 1
            && !cross_doc_cue(&question)
            && !multi_file_span(&initial.references)
        {
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
                    // Manifest (§5): each whole-document part is a retrieved chunk
                    // attributed to this one file — metadata only, built before
                    // `ctxs`/`reference` move into the calls below.
                    let manifest: Vec<CtxManifestEntry> = ctxs
                        .iter()
                        .map(|c| {
                            manifest_entry(
                                "retrieved-chunk",
                                &c.name,
                                c.text.len(),
                                c.score,
                                Some(reference.file_id.clone()),
                            )
                        })
                        .collect();
                    let mut answer = llm::stream_answer(
                        question.clone(),
                        ctxs,
                        cfg.clone(),
                        history.clone(),
                        Some(sink.clone()),
                    );
                    while let Some(d) = answer.next().await {
                        yield delta(d);
                    }
                    yield final_chunk(
                        vec![reference],
                        excerpt_count,
                        &origin,
                        cost_meta(&cfg, sink.total()),
                        manifest,
                    );
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
                        Some(sink.clone()),
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
                    // Manifest (§5): each synthesized segment is a retrieved chunk
                    // attributed to this one file — metadata only, built before
                    // `reduce_ctxs`/`reference` move into the calls below.
                    let manifest: Vec<CtxManifestEntry> = reduce_ctxs
                        .iter()
                        .map(|c| {
                            manifest_entry(
                                "retrieved-chunk",
                                &c.name,
                                c.text.len(),
                                c.score,
                                Some(reference.file_id.clone()),
                            )
                        })
                        .collect();
                    let mut answer = llm::stream_answer(
                        reduce_question(&question),
                        reduce_ctxs,
                        cfg.clone(),
                        history.clone(),
                        Some(sink.clone()),
                    );
                    while let Some(d) = answer.next().await {
                        yield delta(d);
                    }
                    yield final_chunk(
                        vec![reference],
                        excerpt_count,
                        &origin,
                        cost_meta(&cfg, sink.total()),
                        manifest,
                    );
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
        // §32 §5: on the apple-fm tiers the retrieved chunks digest to
        // question-relevant QUOTES (block count/order/names preserved — the
        // [n] citation contract is untouched; only each block's text shrinks
        // to verbatim quoted sentences). Engine-built blocks appended below
        // (table profiles, reliability assists) are never digested. The §1
        // clamp still runs in stream_local as the last line of defense.
        {
            let tier = llm::narration_tier(&cfg);
            if tier.is_apple_fm() {
                let b = crate::budget::segment_budgets(tier);
                contexts = crate::quotes::digest_contexts(
                    contexts,
                    &question,
                    b.ctx_block_max,
                    b.ctx_total_max,
                );
            }
        }
        // Manifest (§5): the retrieved chunks (attributed to their files via the
        // flowing references), grown alongside `contexts` with a schema-card entry
        // per appended table profile below. Metadata only.
        let mut manifest = retrieval_manifest(&initial.contexts, &initial.references);
        let mut profiled = 0;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        // §2 visual-first: the first profiled table also renders a chart, built
        // from the profile's OWN aggregates by the same emitter the analytics
        // path uses — emitted as a deterministic `lighthouse-chart` fence after
        // the narration, never from the model's text.
        let mut profile_chart_spec: Option<String> = None;
        for r in &initial.references {
            if profiled >= 2 {
                break;
            }
            if seen.contains(&r.file_id) || !is_profileable(&r.name) {
                continue;
            }
            seen.insert(r.file_id.clone());
            let Some((_, full)) = vault::doc_text(&r.file_id, None) else {
                continue;
            };
            if let Some(p) = table_profile(&r.name, &full) {
                let pname = format!("{} — table profile", r.name);
                manifest.push(manifest_entry(
                    "schema-card",
                    &pname,
                    p.len(),
                    0.0,
                    Some(r.file_id.clone()),
                ));
                contexts.push(Ctx { name: pname, text: p, score: 0.0 });
                profiled += 1;
                if profile_chart_spec.is_none() {
                    profile_chart_spec = profile_chart(&r.name, &full);
                }
            }
        }

        // §4: small-model handholding leads the context (high score survives the
        // local clamp) so a weak local model stops denying files that exist.
        let assists = reliability_blocks(&question, &cfg, &included_file_ids);
        if !assists.is_empty() {
            contexts.splice(0..0, assists);
        }
        let excerpt_count = contexts.len();
        // `cfg.clone()` (not a move) keeps `cfg` alive for the cost meter below —
        // the sink only carries this call's usage once the stream has drained.
        let mut answer =
            llm::stream_answer(question, contexts, cfg.clone(), history, Some(sink.clone()));
        while let Some(d) = answer.next().await {
            yield delta(d);
        }
        // §2 visual-first: the profiled table's chart, drawn from the engine's
        // own aggregates (see profile_chart_spec above). Deterministic engine
        // output — §22.6: it rides the final chunk's meta, never the streamed
        // text a model could mangle.
        let mut done = final_chunk(
            initial.references,
            excerpt_count,
            &origin,
            cost_meta(&cfg, sink.total()),
            manifest,
        );
        if let Some(m) = done.meta.as_mut() {
            m.chart = profile_chart_spec.clone();
        }
        yield done;
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

    // --- Context manifest (openspec: add-beam-loop §5.7) ---------------------------

    fn ctx(name: &str, text: &str, score: f64) -> Ctx {
        Ctx { name: name.into(), text: text.into(), score }
    }

    fn reg(file_id: &str, file_name: &str, card: &str) -> crate::analytics::TableReg {
        crate::analytics::TableReg {
            table: file_name.replace(['.', '-'], "_"),
            file_id: file_id.into(),
            file_name: file_name.into(),
            card: card.into(),
            modified_ms: None,
            columns: Vec::new(),
            group: None,
            capped_rows: None,
        }
    }

    fn vctx(name: &str, text: &str, score: f64, kind: crate::contracts::SourceKind) -> vault::Context {
        vault::Context { name: name.into(), text: text.into(), score, kind }
    }

    #[test]
    fn multi_file_span_needs_two_comparable_sources() {
        // §3: two comparably-relevant sources route to synthesis; a weak second
        // source (or a single source) falls through to whole-file focus. KEEP
        // ALIGNED with the TS twin test (test/synth.cues.test.mjs).
        assert!(multi_file_span(&[r("a", "a", 1.0), r("b", "b", 0.7)]));
        assert!(multi_file_span(&[r("a", "a", 1.0), r("b", "b", 0.6)])); // boundary
        assert!(!multi_file_span(&[r("a", "a", 1.0), r("b", "b", 0.4)])); // weak 2nd
        assert!(!multi_file_span(&[r("a", "a", 1.0)])); // single source
        assert!(!multi_file_span(&[]));
    }

    #[test]
    fn reliability_blocks_only_for_the_local_model() {
        let ids = vec!["a.csv".to_string(), "b.md".to_string()];
        let local = ModelCfg { provider_id: Some("local".into()), ..Default::default() };
        let cloud = ModelCfg { provider_id: Some("openai".into()), ..Default::default() };
        let keyless = ModelCfg::default(); // extractive fallback — no model runs

        // Cloud + keyless pay nothing.
        assert!(reliability_blocks("total sales", &cloud, &ids).is_empty());
        assert!(reliability_blocks("total sales", &keyless, &ids).is_empty());

        // Local gets the capability preamble (with the file count), high-scored so
        // the local context clamp can't drop it. (named_file_target reads the vault,
        // which is empty in a unit test, so only the preamble asserts here.)
        let blocks = reliability_blocks("total sales", &local, &ids);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].text.contains("2 file(s) available"), "{}", blocks[0].text);
        assert!(
            blocks[0].text.contains("never tell the user that a file or a column"),
            "{}",
            blocks[0].text
        );
        assert_eq!(blocks[0].score, 1.0);

        // No files → nothing to assert.
        assert!(reliability_blocks("hi", &local, &[]).is_empty());
    }

    #[test]
    fn manifest_is_metadata_only_never_context_text() {
        // §5.1/§5.7 — a manifest entry carries a block's NAME/KIND/length/file id,
        // never its TEXT. The manifest rides ChunkMeta into CachedAnswer.text and
        // G6 notes, so a private chunk's bytes must never appear in it.
        let secret = "SSN 123-45-6789 — the merger closes Tuesday";
        let contexts = vec![vctx("secrets.md", secret, 0.9, crate::contracts::SourceKind::File)];
        let refs = vec![r("file-42", "secrets.md", 0.9)];
        let manifest = retrieval_manifest(&contexts, &refs);
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains("123-45-6789"), "no context text bytes in the manifest");
        assert!(!json.contains("merger"), "no context text bytes in the manifest");
        // The METADATA is present: name, kind, a char COUNT (the text length), id.
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].kind, "retrieved-chunk");
        assert_eq!(manifest[0].chars, secret.len());
        assert_eq!(manifest[0].file_id.as_deref(), Some("file-42"));
    }

    #[test]
    fn retrieval_manifest_attributes_chunks_and_labels_conversations() {
        // §5.3 — each retrieved-chunk entry carries the file_id of its source file
        // (from the flowing references); a past-chat note is a conversation-note.
        let contexts = vec![
            vctx("q3.md", "prose about revenue", 0.8, crate::contracts::SourceKind::File),
            vctx("chat.md", "my earlier chat", 0.5, crate::contracts::SourceKind::Conversation),
        ];
        let refs = vec![r("id-q3", "q3.md", 0.8), r("id-chat", "chat.md", 0.5)];
        let m = retrieval_manifest(&contexts, &refs);
        assert_eq!(m[0].kind, "retrieved-chunk");
        assert_eq!(m[0].file_id.as_deref(), Some("id-q3"), "a chunk names its file");
        assert_eq!(m[1].kind, "conversation-note");
        // The conversation block's manifest name is the prompt label the model saw.
        assert_eq!(m[1].name, "from your past Lighthouse conversation");
    }

    #[test]
    fn manifest_reflects_only_the_gated_set_and_pairs_with_the_skip_note() {
        // §5.2/§5.7 — the manifest is built from the ctxs assembled AFTER the
        // shareable gate, so it lists ONLY the shared subset; a cloud ask discloses
        // what was WITHHELD separately, via the skip note. Here the gate already
        // dropped "private.md" (a local-only file), so it never reaches the builder.
        let gated = vec![
            vctx("a.csv", "rows…", 1.0, crate::contracts::SourceKind::File),
            vctx("b.md", "prose…", 0.8, crate::contracts::SourceKind::File),
        ];
        let refs = vec![r("id-a", "a.csv", 1.0), r("id-b", "b.md", 0.8)];
        let manifest = retrieval_manifest(&gated, &refs);
        let names: Vec<&str> = manifest.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(manifest.len(), 2, "only the gated (shared) entries appear");
        assert!(!names.contains(&"private.md"), "a withheld local-only file never enters the manifest");
        // The withholding is disclosed by the paired skip note, which states the
        // count of files withheld — the disclosure of "what went" + "what didn't".
        assert!(local_only_skip_note(1).contains('1'), "the skip note states the withheld count");
    }

    #[test]
    fn analytics_manifest_labels_results_schemas_and_chart_options() {
        // §5.1 — the narration ctxs split into query-result(s), then one
        // schema-card per registered table (attributed to its file), then a
        // trailing chart-options card. Kinds are byte-exact; no text bytes ride.
        let ctxs = vec![
            ctx("query result — computed exactly by Lighthouse", "SQL:\nSELECT 1\n\nResult:\n| x |", 1.0),
            ctx("sales.csv — schema", "region TEXT, amt INT", 0.0),
            ctx("chart options", "kind: bar", 0.0),
        ];
        let regs = vec![reg("id-sales", "sales.csv", "region TEXT, amt INT")];
        let m = analytics_manifest(&ctxs, 1, &regs);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].kind, "query-result");
        assert_eq!(m[1].kind, "schema-card");
        assert_eq!(m[1].file_id.as_deref(), Some("id-sales"));
        assert_eq!(m[2].kind, "chart-options");
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("SELECT 1"), "no result text in the manifest");
        assert!(!json.contains("region TEXT"), "no schema-card text in the manifest");
    }

    #[test]
    fn planning_manifest_labels_schema_view_and_join_hint_cards() {
        // §5.1 — the planning ctxs (sql_ctxs) are file schema-cards (attributed),
        // then saved-view schema-cards (virtual, no file), then a join-hints card.
        let sql_ctxs = vec![
            ctx("sales.csv", "region TEXT, amt INT", 1.0),
            ctx("monthly_view", "a saved view card", 1.0),
            ctx("join hints", "sales.region = regions.region", 0.0),
        ];
        let regs = vec![reg("id-sales", "sales.csv", "region TEXT, amt INT")];
        let m = planning_manifest(&sql_ctxs, &regs, 1, false);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].kind, "schema-card");
        assert_eq!(m[0].file_id.as_deref(), Some("id-sales"));
        assert_eq!(m[1].kind, "schema-card");
        assert!(m[1].file_id.is_none(), "a saved view is virtual — no source file");
        assert_eq!(m[2].kind, "join-hints");
    }

    #[test]
    fn planning_manifest_labels_the_semantic_block() {
        // openspec: add-semantic-layer §2.2 — the business-definitions block
        // rides between the view cards and the join-hints card and is labeled
        // its own kind (never mislabeled as a join-hints card).
        let sql_ctxs = vec![
            ctx("sales.csv", "region TEXT, amt INT", 1.0),
            ctx("business definitions", "Business definitions …", 0.0),
            ctx("join hints", "sales.region = regions.region", 0.0),
        ];
        let regs = vec![reg("id-sales", "sales.csv", "region TEXT, amt INT")];
        let m = planning_manifest(&sql_ctxs, &regs, 0, true);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].kind, "schema-card");
        assert_eq!(m[1].kind, "business-definitions");
        assert!(m[1].file_id.is_none(), "the semantic block has no source file");
        assert_eq!(m[2].kind, "join-hints");
    }

    #[test]
    fn cost_meter_sums_tokens_prices_cloud_zeroes_local_and_flags_unreported() {
        // openspec: add-beam-loop §3.1/§3.5 — the meter is built from the per-ask
        // sink's SUMMED total (the sink accumulates across every model call).
        let cloud = ModelCfg {
            provider_id: Some("anthropic".into()),
            model_id: Some("claude-sonnet-5".into()),
            api_key: None,
        };
        // A summed two-call total (100+200 in, 40+60 out) ⇒ the meter shows the
        // sum, reported, with a labeled dollar estimate.
        let m = cost_meta(&cloud, Some(llm::Usage { input: 300, output: 100 }));
        assert!(m.reported);
        assert_eq!((m.input_tokens, m.output_tokens, m.total_tokens), (300, 100, 400));
        assert!(m.cost_estimate_usd.unwrap() > 0.0, "a known cloud model is priced");

        // Local reports its tokens with $0.00 (loopback, not egress).
        let local = ModelCfg { provider_id: Some("local".into()), model_id: None, api_key: None };
        let ml = cost_meta(&local, Some(llm::Usage { input: 500, output: 20 }));
        assert!(ml.reported && ml.total_tokens == 520);
        assert_eq!(ml.cost_estimate_usd, Some(0.0));

        // A silent provider (sink None) is "not reported" — real zeros, no
        // estimate, never a chars/4 guess (§14).
        let mu = cost_meta(&cloud, None);
        assert!(!mu.reported);
        assert_eq!(mu.total_tokens, 0);
        assert_eq!(mu.cost_estimate_usd, None);
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
    fn reduce_question_appends_the_length_note_after_the_verbatim_ask() {
        let q = reduce_question("What does the lease say about renewal?");
        assert!(q.starts_with("What does the lease say about renewal?\n\n(Target length:"));
        assert!(q.ends_with("asks for depth or detail.)"));
        // One note, not stacked (the helper is applied at exactly one site).
        assert_eq!(q.matches("(Target length:").count(), 1);
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

    // §22.4 queue-not-fail: the warm-wait state machine, exhaustively.
    #[test]
    fn warm_wait_ready_always_proceeds() {
        use crate::llm::LocalHealth::*;
        for waited in [0, LOCAL_SPAWN_GRACE_MS, LOCAL_WARM_WAIT_MS] {
            for installed in [true, false] {
                assert_eq!(warm_wait_verdict(Ready, installed, waited), WarmStep::Proceed);
            }
        }
    }

    #[test]
    fn warm_wait_loading_waits_until_the_budget_then_proceeds() {
        use crate::llm::LocalHealth::*;
        assert_eq!(warm_wait_verdict(Loading, true, 0), WarmStep::Wait);
        assert_eq!(warm_wait_verdict(Loading, false, 0), WarmStep::Wait);
        assert_eq!(
            warm_wait_verdict(Loading, true, LOCAL_WARM_WAIT_MS - 1),
            WarmStep::Wait
        );
        assert_eq!(warm_wait_verdict(Loading, true, LOCAL_WARM_WAIT_MS), WarmStep::Proceed);
    }

    #[test]
    fn warm_wait_down_waits_only_for_an_installed_model_within_grace() {
        use crate::llm::LocalHealth::*;
        // Installed → the supervisor will spawn within a reconcile tick: wait.
        assert_eq!(warm_wait_verdict(Down, true, 0), WarmStep::Wait);
        assert_eq!(warm_wait_verdict(Down, true, LOCAL_SPAWN_GRACE_MS - 1), WarmStep::Wait);
        // Grace exhausted → the old immediate-fallback behavior returns.
        assert_eq!(warm_wait_verdict(Down, true, LOCAL_SPAWN_GRACE_MS), WarmStep::Proceed);
        // No installed model (BYO endpoint absent, web twin) → never wait.
        assert_eq!(warm_wait_verdict(Down, false, 0), WarmStep::Proceed);
    }

    // Byte-pinned twin label (synth.ts::warmingLabel).
    #[test]
    fn warming_label_matches_the_twin() {
        assert_eq!(warming_label(0), "Private model warming up…");
        assert_eq!(warming_label(4_500), "Private model warming up…");
        assert_eq!(warming_label(8_000), "Loading the private model into memory…");
        assert_eq!(warming_label(19_999), "Loading the private model into memory…");
        assert_eq!(
            warming_label(20_000),
            "Almost ready — the first private answer takes a moment…"
        );
        assert_eq!(
            warming_label(61_000),
            "Almost ready — the first private answer takes a moment…"
        );
    }

    // §22.6: the meta-answer fence extractor (twin: synth.ts::extractChartFence).
    #[test]
    fn extract_chart_fence_splits_an_engine_fence_out() {
        let md = "You have 12 files.\n```lighthouse-chart\n{\"kind\":\"bar\"}\n```\nMore text.";
        let (rest, spec) = extract_chart_fence(md);
        assert_eq!(spec.as_deref(), Some("{\"kind\":\"bar\"}"));
        assert_eq!(rest, "You have 12 files.\nMore text.");
    }

    #[test]
    fn extract_chart_fence_leaves_fenceless_and_unclosed_input_alone() {
        assert_eq!(extract_chart_fence("plain answer"), ("plain answer".to_string(), None));
        let unclosed = "text\n```lighthouse-chart\n{\"kind\":";
        assert_eq!(extract_chart_fence(unclosed), (unclosed.to_string(), None));
        // A stat fence is a different lang — untouched.
        let stat = "```lighthouse-stat\n{}\n```";
        assert_eq!(extract_chart_fence(stat), (stat.to_string(), None));
    }
}
