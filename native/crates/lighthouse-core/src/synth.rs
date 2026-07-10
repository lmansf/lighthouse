//! Multi-document synthesis pipeline (Phase 1 — docs/multi-doc-synthesis.md),
//! the Rust twin of src/server/synth.ts. One entry point for the whole ask
//! path: single-shot RAG (with exact table profiles for CSV hits) or a
//! map→reduce plan over 2..6 documents, streamed as ChatChunks with
//! pre-answer `progress` notes. Prompts, trigger rules, and formats MUST stay
//! byte-identical with the TS side.

use std::pin::Pin;

use futures::{Stream, StreamExt};

use crate::contracts::{AnalyticsMeta, ChatChunk, ChatProgress, ChatTurn, RagReference};
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

fn progress(label: String, step: usize, total: usize) -> ChatChunk {
    ChatChunk {
        delta: String::new(),
        references: None,
        progress: Some(ChatProgress { label, step, total }),
        analytics: None,
        done: false,
    }
}

fn delta(d: String) -> ChatChunk {
    ChatChunk { delta: d, references: None, progress: None, analytics: None, done: false }
}

fn final_chunk(references: Vec<RagReference>) -> ChatChunk {
    ChatChunk {
        delta: String::new(),
        references: Some(references),
        progress: None,
        analytics: None,
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

/// The full ask path — see the module docs. Every surface (axum route,
/// desktop IPC) forwards these chunks verbatim.
pub fn answer_pipeline(
    question: String,
    included_file_ids: Vec<String>,
    attachment_file_ids: Vec<String>,
    history: Vec<ChatTurn>,
    cfg: ModelCfg,
) -> Pin<Box<dyn Stream<Item = ChatChunk> + Send>> {
    Box::pin(async_stream::stream! {
        // Blend the previous user turn into retrieval so bare follow-ups anchor
        // to the topic (identical to the TS pipeline).
        let last_user_turn = history.iter().rev().find(|t| t.role == "user");
        let retrieval_query = match last_user_turn {
            Some(t) => format!("{}\n{}", t.content, question),
            None => question.clone(),
        };

        let initial =
            sources::retrieve(&retrieval_query, &included_file_ids, &attachment_file_ids, 5).await;

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
                    crate::meta::render_meta(&intent, &ids, crate::config::now_ms())
                })
                .await
                .ok()
                .and_then(|r| r.ok());
                if let Some(ans) = rendered {
                    yield delta(ans.markdown);
                    yield final_chunk(ans.references);
                    return;
                }
            }
        }

        // --- Analytics branch (docs/analytics-genie.md): aggregate ask over
        //     tabular files → model writes SQL, DataFusion executes, the model
        //     narrates the verified result. Any failure falls through silently
        //     to the paths below — analytics can only add capability. ---
        if has_real_model(&cfg) && crate::analytics::analytics_cue(&question) {
            let candidate_ids: Vec<String> = if !attachment_file_ids.is_empty() {
                attachment_file_ids.clone()
            } else {
                let active: std::collections::HashSet<String> =
                    vault::active_included_file_ids().into_iter().collect();
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
                    if crate::analytics::is_tabular(&name) {
                        files.push((id, name, abs));
                    }
                }
            }
            if !files.is_empty() {
                yield progress("Reading table schemas…".to_string(), 1, 4);
                let ctx = datafusion::prelude::SessionContext::new();
                let regs = crate::analytics::register_tables(&ctx, &files).await;
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
                        let mut ctxs: Vec<Ctx> = vec![Ctx {
                            name: "query result — computed exactly by Lighthouse".to_string(),
                            text: format!(
                                "SQL:\n{sql}\n\nResult ({} row(s){}):\n{}",
                                res.shown,
                                if res.truncated { ", truncated" } else { "" },
                                res.markdown
                            ),
                            score: 1.0,
                        }];
                        ctxs.extend(regs.iter().map(|r| Ctx {
                            name: format!("{} — schema", r.file_name),
                            text: r.card.clone(),
                            score: 0.0,
                        }));
                        let mut answer =
                            llm::stream_answer(question.clone(), ctxs, cfg.clone(), history.clone());
                        while let Some(d) = answer.next().await {
                            yield delta(d);
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
                        // Chartable result → engine-built spec the chat renders
                        // as SVG (Phase C). Data comes straight from the query
                        // batches; the model never sees or writes this block.
                        if let Some(chart) = &res.chart {
                            yield delta(format!("\n```lighthouse-chart\n{chart}\n```\n"));
                        }
                        let mut seen: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        let mut refs: Vec<RagReference> = Vec::new();
                        for r in &regs {
                            let snippet: String = r.card.chars().take(240).collect();
                            match &r.group {
                                // A unioned family cites its first members —
                                // real ids the explorer can open.
                                Some(g) => {
                                    for (id, name) in
                                        g.file_ids.iter().zip(&g.file_names).take(3)
                                    {
                                        if seen.insert(id.clone()) {
                                            refs.push(RagReference {
                                                file_id: id.clone(),
                                                name: name.clone(),
                                                snippet: snippet.clone(),
                                                score: 0.9,
                                            });
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
                                        });
                                    }
                                }
                            }
                        }
                        // Structured provenance for chips / Save-as-CSV /
                        // pins: EVERY file read (all group members), not just
                        // the cited sample.
                        let mut meta_seen: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        let mut meta_ids: Vec<String> = Vec::new();
                        for r in &regs {
                            match &r.group {
                                Some(g) => {
                                    for id in &g.file_ids {
                                        if meta_seen.insert(id.clone()) {
                                            meta_ids.push(id.clone());
                                        }
                                    }
                                }
                                None => {
                                    if meta_seen.insert(r.file_id.clone()) {
                                        meta_ids.push(r.file_id.clone());
                                    }
                                }
                            }
                        }
                        let mut done = final_chunk(refs);
                        done.analytics = Some(AnalyticsMeta { sql, file_ids: meta_ids });
                        yield done;
                        return;
                    }
                }
            }
        }

        // --- Decide: synthesis or single-shot ---
        let mut docs: Vec<DocCandidate> = Vec::new();
        if has_real_model(&cfg) {
            if attachment_file_ids.len() >= MIN_MAP_DOCS {
                docs = attachment_file_ids
                    .iter()
                    .take(MAX_MAP_DOCS)
                    .map(|id| DocCandidate { id: id.clone(), name: String::new(), score: ASSUMED_DOC_SCORE })
                    .collect();
            } else if attachment_file_ids.is_empty() && cross_doc_cue(&question) {
                let wide =
                    sources::retrieve(&retrieval_query, &included_file_ids, &[], WIDE_K).await;
                docs = rank_docs_from_hits(&wide.references, MAX_MAP_DOCS);
                let active: std::collections::HashSet<String> =
                    vault::active_included_file_ids().into_iter().collect();
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
                let per_doc = vault::retrieve(
                    &retrieval_query,
                    &[],
                    PER_DOC_CHUNKS,
                    &[],
                    std::slice::from_ref(&doc.id),
                );
                let mut ctxs: Vec<Ctx> = if per_doc.contexts.is_empty() {
                    vec![Ctx { name: name.clone(), text: preview_text.clone(), score: 1.0 }]
                } else {
                    per_doc
                        .contexts
                        .iter()
                        .map(|c| Ctx { name: c.name.clone(), text: c.text.clone(), score: c.score })
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
                if extract.is_empty()
                    || extract.starts_with("NO_RELEVANT_CONTENT")
                    || extract.contains("_(Local model unavailable")
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
                    RagReference { file_id: doc.id.clone(), name, snippet, score: doc.score },
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
                let mut answer =
                    llm::stream_answer(question.clone(), reduce_ctxs, cfg.clone(), history.clone());
                while let Some(d) = answer.next().await {
                    yield delta(d);
                }
                yield final_chunk(extracts.into_iter().map(|(r, _)| r).collect());
                return;
            }
            // Fewer than two documents had anything to say — fall through.
        }

        // --- Single-shot path + exact table stats for CSV hits ---
        let mut contexts: Vec<Ctx> = initial
            .contexts
            .iter()
            .map(|c| Ctx { name: c.name.clone(), text: c.text.clone(), score: c.score })
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

        let mut answer = llm::stream_answer(question, contexts, cfg, history);
        while let Some(d) = answer.next().await {
            yield delta(d);
        }
        yield final_chunk(initial.references);
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
}
