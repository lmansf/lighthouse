//! Retrieval engine — the ranker, the chunker, and the text/name matching that
//! feed it.
//!
//! This is what survived `vault.rs` when the persistent vault was deleted in
//! 0.15.0 (openspec: refocus-chat-attachments). Everything here is
//! CORPUS-AGNOSTIC by construction: `retrieve_items` takes the candidates a
//! caller has already resolved and ranks them, so the workspace (a
//! conversation's attachments) runs the identical scoring the vault walk used
//! to feed it. What went was the folder half — the walk, `state.json`,
//! inclusion flags, local-only marks, curation rules, references,
//! move/rename/trash, and the artifact writers.
//!
//! Retrieval is a hybrid of TF-IDF cosine over chunk text and name matching,
//! with a conservative "the question NAMES this file" pin so a keyword-heavy
//! chunk from another file cannot crowd out the file the user asked about.
//!
//! PARITY: the TS twin's ranker is `src/server/retrieval.ts::retrieveItems` and the
//! helpers around it — the scoring, the chunker and the listing-intent phrases
//! stay byte-compatible.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::contracts::RagReference;
use crate::extract::{extract_rich_text, is_rich_file};

/// Extensions read directly as UTF-8 text (rich binary formats go via extract).
const TEXT_EXT: &[&str] = &[
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".rst",
    ".csv",
    ".tsv",
    ".json",
    ".yaml",
    ".yml",
    ".log",
    ".html",
    ".htm",
    // .xml deliberately absent: app-generated sidecar/config XML in linked
    // folders kept surfacing as AI sources (0.6.x field report). The files
    // stay visible in the explorer — they just never become chunks.
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".py",
    ".java",
    ".go",
    ".rb",
    ".rs",
    ".c",
    ".h",
    ".cpp",
    ".sh",
    ".sql",
    ".toml",
    ".ini",
    ".env",
    ".css",
];


// --- tokenization & scoring ------------------------------------------------------

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "as", "at",
    "by", "from", "this", "that", "it", "be", "do", "does", "have", "any", "there", "my", "our",
    "your", "you", "me", "i",
];


/// Extension-ish tokens that don't count as "naming" a file in a question.
const EXT_TOKENS: &[&str] = &[
    "xlsx", "xlsm", "xls", "csv", "tsv", "pdf", "docx", "doc", "md", "txt", "parquet",
    "pptx", "json", "html", "log",
];



fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{}", ext.to_lowercase()),
        _ => String::new(),
    }
}


fn is_text_file(name: &str) -> bool {
    TEXT_EXT.contains(&ext_of(name).as_str())
}


/// Classify a retrieved node id as a past-conversation note or an ordinary
/// file — purely by its vault-relative path. The trailing slash matters:
/// `Lighthouse Notes/Chats/x.md` is a conversation, `Lighthouse Notes/Chatsz`
/// is not. KEEP IN SYNC with src/server/retrieval.ts::sourceKindOf.
pub fn source_kind_of(file_id: &str) -> crate::contracts::SourceKind {
    if file_id.starts_with("Lighthouse Notes/Chats/") {
        crate::contracts::SourceKind::Conversation
    } else {
        crate::contracts::SourceKind::File
    }
}


/// The 8-hex conversation key a conversation-note filename is bracketed with
/// (the `write_conversation_note` format). KEEP IN SYNC with
/// src/server/retrieval.ts::conversationCid8.
fn conversation_cid8(conversation_id: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(conversation_id.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// The `[cid8]` key a conversation-note FILENAME carries (the
/// `"<title> [<cid8>].md"` format `write_conversation_note` produces), or
/// `None` for any other id. The LAST ` [` wins, so a title that itself
/// contains brackets still yields the engine-appended key. KEEP IN SYNC with
/// src/server/retrieval.ts::noteCid8Of.
fn note_cid8_of(file_id: &str) -> Option<&str> {
    let stem = file_id.strip_suffix("].md")?;
    stem.rsplit_once(" [").map(|(_, cid)| cid)
}


// --- text reading ---------------------------------------------------------------

/// Read text from an absolute path — rich formats (pdf/docx/xlsx) go through
/// the extractor with its own size handling and cache; plain text is read
/// directly, capped at `cap` bytes so one pathological file can't dominate
/// memory. The index (Phase 5) passes a generous, env-tunable cap; the legacy
/// 1 MB bound existed only to protect the per-query read path that no longer
/// exists.
pub fn read_text_abs_capped(abs: &Path, cap: u64) -> String {
    let name = abs.to_string_lossy();
    if is_rich_file(&name) {
        return extract_rich_text(abs, &ext_of(&name));
    }
    if !is_text_file(&name) {
        return String::new();
    }
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    if size <= cap {
        return fs::read(abs)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
    }
    // Large file: read only the first `cap` bytes.
    use std::io::Read;
    let Ok(f) = fs::File::open(abs) else {
        return String::new();
    };
    let mut buf = vec![0u8; cap as usize];
    let mut taken = f.take(cap);
    let mut read = 0usize;
    loop {
        match taken.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return String::new(),
        }
    }
    String::from_utf8_lossy(&buf[..read]).into_owned()
}


/// Lowercased runs of `[a-z0-9]{2,}` minus stop words (port of `tokenize`).
pub fn tokenize(s: &str) -> Vec<String> {
    word_runs(&s.to_lowercase())
        .into_iter()
        .filter(|t| t.len() >= 2 && !STOP_WORDS.contains(&t.as_str()))
        .collect()
}


/// All maximal runs of ascii `[a-z0-9]` in an (already lowercased) string.
fn word_runs(lower: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}


/// Crude singularizer so "cards" matches "card".
fn singular(t: &str) -> &str {
    if t.len() > 3 && t.ends_with('s') {
        &t[..t.len() - 1]
    } else {
        t
    }
}


/// Searchable tokens from a file's name and path.
pub fn name_tokens_of(id: &str, name: &str) -> Vec<String> {
    tokenize(&format!("{} {}", id.replace('/', " "), name))
}


/// How strongly the query matches a file's name/path tokens.
fn name_match(q_tokens: &[String], name_toks: &[String]) -> (usize, bool) {
    let mut hits = 0usize;
    let mut strong = false;
    for raw in q_tokens {
        let q = singular(raw);
        if q.len() < 3 {
            continue;
        }
        let hit = name_toks.iter().any(|nt0| {
            let nt = singular(nt0);
            nt == q || nt.contains(q) || (nt.len() >= 3 && q.contains(nt))
        });
        if hit {
            hits += 1;
            if raw.len() >= 4 {
                strong = true;
            }
        }
    }
    (hits, strong)
}


/// The named-file pin's target, if any: the single file whose meaningful
/// name/path tokens the question covers substantially enough to read as
/// "the user named this file". Deliberately conservative — the pin FORCES a
/// file into the top-k, so a weak or ambiguous match must select nothing
/// (0.6.2 field report: a lone generic token shared with a filename pinned
/// irrelevant files — "quoting the right documents but recommending the
/// wrong ones"). KEEP IN SYNC with retrieval.ts::pinnedNamedFile. Rules:
///   - coverage: the question must mention at least half of the file's
///     unique meaningful name tokens (len ≥ 3, extension tokens dropped);
///   - specificity: ≥ 2 covered tokens, or a single-token name whose token
///     is ≥ 5 chars ("resume" can pin, "plan" never does);
///   - uniqueness: two files with the same coverage signature mean the
///     phrase is generic (meeting-notes-1/2/3…) — pin nothing.
fn pinned_named_file<'a>(
    qtokens: &[String],
    files: impl Iterator<Item = (&'a str, &'a [String])>,
) -> Option<&'a str> {
    let mut best: Option<(&str, usize, usize)> = None; // (id, covered, total)
    let mut ambiguous = false;
    for (id, name_toks) in files {
        let mut uniq: Vec<&str> = name_toks
            .iter()
            .map(|t| singular(t))
            .filter(|t| t.len() >= 3 && !EXT_TOKENS.contains(t))
            .collect();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.is_empty() {
            continue;
        }
        let covered: Vec<&str> = uniq
            .iter()
            .copied()
            .filter(|&nt| {
                qtokens.iter().any(|q0| {
                    let q = singular(q0);
                    q.len() >= 3 && (q == nt || nt.contains(q) || q.contains(nt))
                })
            })
            .collect();
        let (c, m) = (covered.len(), uniq.len());
        let specific = c >= 2 || (m == 1 && covered.first().is_some_and(|t| t.len() >= 5));
        if c * 2 < m || !specific {
            continue;
        }
        match best {
            None => best = Some((id, c, m)),
            Some((_, bc, bm)) => {
                // Compare coverage fractions via cross-multiplication (c/m
                // vs bc/bm), then absolute covered count. An exact tie on
                // both is the generic-siblings case.
                let (lhs, rhs) = (c * bm, bc * m);
                if lhs > rhs || (lhs == rhs && c > bc) {
                    best = Some((id, c, m));
                    ambiguous = false;
                } else if lhs == rhs && c == bc {
                    ambiguous = true;
                }
            }
        }
    }
    if ambiguous {
        return None;
    }
    best.map(|(id, _, _)| id)
}


// --- chunking & retrieval -----------------------------------------------------------

/// Split like JS `text.split(/\s+/)` (leading/trailing empties preserved so
/// window alignment matches the TS chunker exactly).
fn js_split_ws(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    if rest.is_empty() {
        return vec![""];
    }
    let starts_ws = rest
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(false);
    if starts_ws {
        out.push(&text[0..0]); // JS yields a leading ""
    }
    while !rest.is_empty() {
        let ws_at = rest.find(char::is_whitespace);
        match ws_at {
            Some(0) => {
                let next = rest
                    .char_indices()
                    .find(|(_, c)| !c.is_whitespace())
                    .map(|(i, _)| i)
                    .unwrap_or(rest.len());
                rest = &rest[next..];
                if rest.is_empty() {
                    out.push(&text[0..0]); // trailing ""
                }
            }
            Some(i) => {
                out.push(&rest[..i]);
                rest = &rest[i..];
            }
            None => {
                out.push(rest);
                rest = &rest[rest.len()..];
            }
        }
    }
    out
}


/// Structure-aware chunking (docs/analytics-beam.md, B1): tabular extracts
/// chunk by ROWS with the header line(s) prepended to every chunk, so a chunk
/// holding row 400 still carries its column names; prose keeps the word
/// windows below. KEEP BYTE-IDENTICAL with the TS chunker (retrieval.ts chunksOf).
pub fn chunk_texts_named(name: &str, text: &str) -> Vec<String> {
    if crate::analytics::is_tabular(name) {
        return chunk_tabular(name, text);
    }
    chunk_texts_of(text)
}


fn chunk_tabular(name: &str, text: &str) -> Vec<String> {
    const ROWS: usize = 30;
    const ROW_OVERLAP: usize = 5;
    let lower = name.to_lowercase();
    // Workbook extracts prepend the sheet name above each sheet's CSV; carry
    // BOTH the sheet line and the header row into every chunk.
    let header_lines =
        if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") { 2 } else { 1 };
    let mut chunks: Vec<String> = Vec::new();
    // Blank-line-separated blocks (one per sheet for workbooks).
    for block in text.split("\n\n") {
        // Trim trailing whitespace INCLUDING U+FEFF (BOM/ZWNBSP): JS `\s` and
        // `String.trim` strip it but Rust's `char::is_whitespace` does not, so a
        // tabular line ending in a mid-file BOM would chunk differently across
        // the twins. Match JS so the chunkers stay byte-identical (parity).
        let ws = |c: char| c.is_whitespace() || c == '\u{feff}';
        let lines: Vec<&str> = block
            .split('\n')
            .map(|l| l.trim_end_matches(ws))
            .filter(|l| !l.trim_matches(ws).is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let h = header_lines.min(lines.len().saturating_sub(1));
        if lines.len() <= h + 1 {
            chunks.push(lines.join("\n"));
            continue;
        }
        let header = lines[..h].join("\n");
        let data = &lines[h..];
        let mut i = 0usize;
        while i < data.len() {
            let end = (i + ROWS).min(data.len());
            let body = data[i..end].join("\n");
            chunks.push(if header.is_empty() { body } else { format!("{header}\n{body}") });
            if i + ROWS >= data.len() {
                break;
            }
            i += ROWS - ROW_OVERLAP;
        }
    }
    chunks
}


/// 120-word chunks with 25-word overlap — identical windows to the TS engine.
/// Term frequencies are attached by the index at build time.
pub fn chunk_texts_of(text: &str) -> Vec<String> {
    let words = js_split_ws(text);
    const SIZE: usize = 120;
    const OVERLAP: usize = 25;
    let mut chunks = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        let end = (i + SIZE).min(words.len());
        let slice = words[i..end].join(" ").trim().to_string();
        if !slice.is_empty() {
            chunks.push(slice);
        }
        if i + SIZE >= words.len() {
            break;
        }
        i += SIZE - OVERLAP;
    }
    chunks
}


#[derive(Debug, Clone, Serialize)]
pub struct Context {
    pub name: String,
    pub text: String,
    pub score: f64,
    /// G6: `Conversation` for a past-chat note, else `File`. Internal to synth
    /// (drives the prompt label); not serialized to the client. Defaults to File.
    #[serde(default)]
    pub kind: crate::contracts::SourceKind,
}


#[derive(Debug, Clone, Serialize)]
pub struct Retrieved {
    pub references: Vec<RagReference>,
    pub contexts: Vec<Context>,
}


/// Score `items` for `query` and build the answer's references + contexts.
/// Extracted from [`retrieve`] so the corpus that supplies the items is a
/// caller's choice: the session workspace resolves them from a conversation
/// manifest (workspace::retrieve), and nothing here walks a directory or
/// reads vault state.
pub(crate) fn retrieve_items(
    query: &str,
    items: &[crate::index::IndexItem],
    k: usize,
    preferred_conversation_ids: &[String],
) -> Retrieved {
    let qtokens = tokenize(query);
    if qtokens.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    // Unified retrieval items served by the persistent index (Phase 5): vault
    // files by node id, mirrored cloud files by absolute mirror path. Stale or
    // missing entries are rebuilt in parallel inside `entries_for`.
    let entries = crate::index::entries_for(&items);

    // Chunks scored this query. The legacy 4,000-chunk cap protected the
    // per-query read loop; from the index a far larger budget is cheap, and
    // hitting it is logged instead of silent.
    let max_chunks = crate::index::max_query_chunks();
    type ChunkRef<'a> = (
        &'a str,
        &'a crate::index::FileEntry,
        &'a crate::index::IndexedChunk,
    );
    let mut chunk_refs: Vec<ChunkRef> = Vec::new();
    'items: for item in items {
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        for c in &entry.chunks {
            if chunk_refs.len() >= max_chunks {
                eprintln!(
                    "retrieve: chunk budget {max_chunks} reached; some included content was not scored this query"
                );
                break 'items;
            }
            chunk_refs.push((item.id.as_str(), entry, c));
        }
    }

    // --- content scoring (TF-IDF cosine over chunks; identical math to TS) ---
    struct Scored<'a> {
        file_id: &'a str,
        name: &'a str,
        text: &'a str,
        score: f64,
    }
    let mut scored: Vec<Scored> = Vec::new();
    if !chunk_refs.is_empty() {
        let mut df: HashMap<&str, f64> = HashMap::new();
        for (_, _, c) in &chunk_refs {
            for t in c.tf.keys() {
                *df.entry(t.as_str()).or_insert(0.0) += 1.0;
            }
        }
        let n = chunk_refs.len() as f64;
        // idf precomputed ONCE per unique corpus term. The old closure recomputed
        // ((n+1)/(df+1)).ln()+1 for every term-occurrence of every chunk on every
        // query; the fallback here reproduces the old df.get(..).unwrap_or(0.0)
        // path for query terms absent from the corpus. Scores are bit-identical.
        let idf_fallback = (n + 1.0).ln() + 1.0;
        let idf_map: HashMap<&str, f64> = df
            .iter()
            .map(|(&t, &d)| (t, ((n + 1.0) / (d + 1.0)).ln() + 1.0))
            .collect();
        let idf = |t: &str| idf_map.get(t).copied().unwrap_or(idf_fallback);
        // Query vector — small (only the query's own terms), materialized once.
        let mut qtf: HashMap<&str, f64> = HashMap::new();
        for t in &qtokens {
            *qtf.entry(t.as_str()).or_insert(0.0) += 1.0;
        }
        let mut qv: Vec<(&str, f64)> = Vec::with_capacity(qtf.len());
        let mut qnorm_sq = 0.0;
        for (t, f) in &qtf {
            let w = f * idf(t);
            qv.push((*t, w));
            qnorm_sq += w * w;
        }
        let qnorm = if qnorm_sq.sqrt() == 0.0 { 1.0 } else { qnorm_sq.sqrt() };
        let mut lex: Vec<f64> = Vec::with_capacity(chunk_refs.len());
        for (_, _, c) in &chunk_refs {
            // Document norm: allocation-free fold over the chunk's own terms
            // (was a full HashMap<String,f64> clone-and-insert per chunk).
            let mut dnorm_sq = 0.0;
            for (t, f) in &c.tf {
                let w = f * idf(t);
                dnorm_sq += w * w;
            }
            let dnorm = if dnorm_sq.sqrt() == 0.0 { 1.0 } else { dnorm_sq.sqrt() };
            // Dot product touches only the query's ~few terms, looked up in the
            // chunk — not a full document vector. dv[t] was c.tf[t]*idf(t) or 0.
            let mut dot = 0.0;
            for (t, qw) in &qv {
                if let Some(f) = c.tf.get(*t) {
                    dot += qw * (f * idf(*t));
                }
            }
            lex.push(dot / (qnorm * dnorm));
        }
        // Hybrid search (B2): when the local embedding server is up and the
        // scored chunks have current vectors, replace the raw lexical scores
        // with RRF-fused lexical+vector scores. None ⇒ exactly today's path.
        let chunk_meta: Vec<(String, String, usize)> = {
            let mut ord: HashMap<&str, usize> = HashMap::new();
            chunk_refs
                .iter()
                .map(|(id, entry, _)| {
                    let o = ord.entry(id).or_insert(0);
                    let meta = (id.to_string(), entry.key.clone(), *o);
                    *o += 1;
                    meta
                })
                .collect()
        };
        let base = crate::embed::hybrid_scores(query, &chunk_meta, &lex).unwrap_or(lex);
        for (i, (file_id, entry, c)) in chunk_refs.iter().enumerate() {
            let mut score = base[i];
            // Nudge a chunk up when its file also matches by name.
            let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
            if strong {
                score += 0.2 * (hits as f64 / qtokens.len() as f64);
            }
            scored.push(Scored {
                file_id,
                name: entry.name.as_str(),
                text: c.text.as_str(),
                score,
            });
        }
    }

    // Merged candidates: scored content chunks, plus a synthetic entry for any
    // file that matches by name but isn't already represented by its content.
    struct Cand {
        file_id: String,
        name: String,
        text: String,
        score: f64,
    }
    let mut cands: Vec<Cand> = scored
        .iter()
        .filter(|s| s.score > 0.0)
        .map(|s| Cand {
            file_id: s.file_id.to_string(),
            name: s.name.to_string(),
            text: s.text.to_string(),
            score: s.score,
        })
        .collect();
    let present: HashSet<String> = cands.iter().map(|c| c.file_id.clone()).collect();
    for item in items {
        if present.contains(&item.id) {
            continue;
        }
        let Some(entry) = entries.get(&item.id) else {
            continue;
        };
        let (hits, strong) = name_match(&qtokens, &entry.name_tokens);
        if hits == 0 || !strong {
            continue;
        }
        let pv = entry.preview.clone();
        cands.push(Cand {
            file_id: item.id.clone(),
            name: item.name.clone(),
            text: if pv.is_empty() {
                "(matched by file name; no readable text could be extracted)".to_string()
            } else {
                pv
            },
            score: 0.5 + 0.4 * (hits as f64 / qtokens.len() as f64), // 0.5..0.9
        });
    }

    // G6 recall cue: a "what did I ask/conclude about X" question biases toward
    // past-conversation notes so synthesis draws on them. Deterministic — it only
    // scales existing conversation-kind candidates before the sort, never invents
    // a cand and never asks the model to rank. Runs on every retrieve pass (both
    // the initial k and the wide pass) since it's inside `retrieve`.
    //
    // Investigation preference (openspec: add-investigations): where the cue
    // boosts conversation notes, a note BELONGING to the ask's investigation
    // — its filename's [cid8] matches a preferred conversation id, the same
    // derivation write_conversation_note bracketed in — is lifted a further
    // INVESTIGATION_BOOST. Preference, not exclusion: global notes keep
    // their CONV_BOOST and still surface, ordered after.
    if crate::synth::recall_cue(query) {
        let preferred_cid8s: HashSet<String> = preferred_conversation_ids
            .iter()
            .map(|id| conversation_cid8(id))
            .collect();
        for c in &mut cands {
            if source_kind_of(&c.file_id) == crate::contracts::SourceKind::Conversation {
                c.score *= crate::synth::CONV_BOOST;
                if !preferred_cid8s.is_empty()
                    && note_cid8_of(&c.file_id)
                        .is_some_and(|cid| preferred_cid8s.contains(cid))
                {
                    c.score *= crate::synth::INVESTIGATION_BOOST;
                }
            }
        }
    }
    cands.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut top: Vec<&Cand> = cands.iter().take(k).collect();
    // Named-file guarantee: a question that strongly names a file MUST surface
    // that file. Before hybrid search this held by accident — name-matched
    // candidates (0.5–0.9) always beat lexical cosines (~0.05–0.3). RRF fused
    // scores fill the 0.9–1.0 band, so topically-similar chunks from OTHER
    // files can crowd the named file out of the top-k (0.6.0 field report:
    // "the file is not present in the provided context" — about a file named
    // verbatim in the question). Pin the best-named file's best candidate
    // into the last slot when ranking dropped it.
    let named = pinned_named_file(
        &qtokens,
        items.iter().filter_map(|item| {
            entries
                .get(&item.id)
                .map(|e| (item.id.as_str(), e.name_tokens.as_slice()))
        }),
    );
    if let Some(named_id) = named {
        if !top.iter().any(|c| c.file_id == named_id) {
            if let Some(best) = cands.iter().find(|c| c.file_id == named_id) {
                if top.len() >= k && !top.is_empty() {
                    top.pop();
                }
                top.push(best);
            }
        }
    }
    if top.is_empty() {
        return Retrieved {
            references: vec![],
            contexts: vec![],
        };
    }

    let max = if top[0].score == 0.0 {
        1.0
    } else {
        top[0].score
    };
    // One reference per file (best chunk), but keep all top chunks as context.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut references: Vec<RagReference> = Vec::new();
    for c in &top {
        if seen.contains(c.file_id.as_str()) {
            continue;
        }
        seen.insert(&c.file_id);
        let snippet: String = c.text.chars().take(240).collect();
        let truncated = c.text.chars().count() > 240;
        references.push(RagReference {
            file_id: c.file_id.clone(),
            name: c.name.clone(),
            snippet: format!("{}{}", snippet.trim(), if truncated { "…" } else { "" }),
            score: (c.score / max).min(1.0),
            kind: source_kind_of(&c.file_id),
        });
    }
    let contexts: Vec<Context> = top
        .iter()
        .map(|c| Context {
            name: c.name.clone(),
            text: c.text.clone(),
            score: (c.score / max).min(1.0),
            kind: source_kind_of(&c.file_id),
        })
        .collect();
    Retrieved {
        references,
        contexts,
    }
}


/// The same conservative matcher over an explicit `(id, name)` candidate set,
/// so a corpus that doesn't walk a directory (the session workspace) shares
/// one implementation with the vault. Ambiguity ⇒ None, as always.
pub fn named_file_target_over(
    question: &str,
    files: &[(String, String)],
) -> Option<(String, String)> {
    let qtokens = tokenize(question);
    if qtokens.is_empty() {
        return None;
    }
    let tokened: Vec<(String, String, Vec<String>)> = files
        .iter()
        .map(|(id, name)| (id.clone(), name.clone(), name_tokens_of(id, name)))
        .collect();
    let id = pinned_named_file(
        &qtokens,
        tokened.iter().map(|(id, _, t)| (id.as_str(), t.as_slice())),
    )?;
    tokened
        .iter()
        .find(|(fid, _, _)| fid == id)
        .map(|(fid, name, _)| (fid.clone(), name.clone()))
}

// The ranker's own unit tests. These moved here WITH the code they cover when
// `retrieval.rs` was split in 0.15.0 — `pinned_named_file` and `chunk_texts_named`
// are the two functions the twins must agree on byte-for-byte, and these are
// the Rust half of that agreement (test/namedFile.test.mjs and
// test/chunker.test.mjs are the TS half, fixture-for-fixture).
#[cfg(test)]
mod named_pin_tests {
    use super::{name_tokens_of, pinned_named_file, tokenize};

    fn files(ids: &[&str]) -> Vec<(String, Vec<String>)> {
        ids.iter().map(|id| (id.to_string(), name_tokens_of(id, id))).collect()
    }

    fn pick<'a>(question: &str, fs: &'a [(String, Vec<String>)]) -> Option<&'a str> {
        let q = tokenize(question);
        pinned_named_file(&q, fs.iter().map(|(id, t)| (id.as_str(), t.as_slice())))
    }

    #[test]
    fn a_verbatim_name_pins() {
        let fs = files(&["1 Galaxy Servers.md", "meeting-notes-1.md", "recipes.md"]);
        assert_eq!(pick("what is inside 1 Galaxy Servers", &fs), Some("1 Galaxy Servers.md"));
    }

    /// 0.6.2 field report: right quotes, wrong recommended files — a lone
    /// generic token ("plan") shared with a filename must never force it in.
    #[test]
    fn a_lone_generic_token_never_pins() {
        let fs = files(&["plan.md", "roadmap.md"]);
        assert_eq!(pick("what is the plan for the rollout", &fs), None);
    }

    #[test]
    fn a_distinctive_single_token_name_still_pins() {
        let fs = files(&["resume.pdf", "recipes.md"]);
        assert_eq!(pick("can you summarize my resume", &fs), Some("resume.pdf"));
    }

    /// Same coverage signature across sibling files = a generic phrase, not
    /// a named file — nothing may be pinned arbitrarily.
    #[test]
    fn generic_siblings_tie_and_nothing_pins() {
        let fs = files(&["meeting-notes-1.md", "meeting-notes-2.md"]);
        assert_eq!(pick("what did the meeting notes say", &fs), None);
    }

    #[test]
    fn fuller_name_coverage_wins_over_partial() {
        let fs = files(&["galaxy servers rollout plan.md", "1 Galaxy Servers.md"]);
        assert_eq!(pick("what is inside 1 galaxy servers", &fs), Some("1 Galaxy Servers.md"));
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::chunk_texts_named;

    /// PARITY FIXTURE — mirrored in test/chunker.test.mjs. 70 data rows chunk
    /// as 1-30 / 26-55 / 51-70, every chunk led by the header line.
    #[test]
    fn csv_rows_chunk_with_header_prepended() {
        let mut text = String::from("region,amount\n");
        for i in 1..=70 {
            text.push_str(&format!("r{i},{i}\n"));
        }
        let chunks = chunk_texts_named("sales.csv", &text);
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert!(c.starts_with("region,amount\n"), "{c}");
        }
        assert!(chunks[0].ends_with("r30,30"));
        assert!(chunks[1].contains("r26,26") && chunks[1].ends_with("r55,55"));
        assert!(chunks[2].contains("r51,51") && chunks[2].ends_with("r70,70"));
    }

    #[test]
    fn workbook_blocks_carry_sheet_and_header_lines() {
        let mut text = String::from("Sheet1\nh1,h2\na,1\nb,2\nc,3\n\nSheet2\nh1,h2\n");
        for i in 1..=40 {
            text.push_str(&format!("x{i},{i}\n"));
        }
        let chunks = chunk_texts_named("book.xlsx", &text);
        assert_eq!(chunks.len(), 3); // sheet1: 1 chunk · sheet2: rows 1-30, 26-40
        assert!(chunks[0].starts_with("Sheet1\nh1,h2\n"));
        assert!(chunks[1].starts_with("Sheet2\nh1,h2\n") && chunks[1].ends_with("x30,30"));
        assert!(chunks[2].starts_with("Sheet2\nh1,h2\n") && chunks[2].ends_with("x40,40"));
    }

    #[test]
    fn prose_keeps_word_windows() {
        let text = (1..=300).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let chunks = chunk_texts_named("notes.md", &text);
        assert_eq!(chunks.len(), 3); // 120-word windows, 95-word step
        assert!(chunks[0].starts_with("w1 ") && chunks[0].ends_with("w120"));
    }

    #[test]
    fn tabular_line_trailing_bom_is_trimmed_for_parity() {
        // A mid-file U+FEFF (BOM/ZWNBSP) at a line end: Rust's char::is_whitespace
        // doesn't strip it but JS `\s`/trim do, which would drift the twins. Both
        // now trim it, so the chunk equals the BOM-free version byte-for-byte.
        let with_bom = "region,amount\nNE,1\u{feff}\nNW,2\n";
        let plain = "region,amount\nNE,1\nNW,2\n";
        assert_eq!(chunk_texts_named("t.csv", with_bom), chunk_texts_named("t.csv", plain));
        assert!(!chunk_texts_named("t.csv", with_bom)[0].contains('\u{feff}'));
    }
}
