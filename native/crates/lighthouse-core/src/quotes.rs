//! §32 §5: quote-digest RAG for the apple-fm tiers — quotes, not chunks.
//!
//! A 120-word chunk carries ~20% overlap with its neighbor and plenty of
//! sentences the question never asked about. On a shared 4k window that is
//! answer room burned. The digest keeps EVERY retrieved block (order and
//! count preserved, so the `[n]` citation contract is untouched) and shrinks
//! each block's TEXT to its question-relevant sentences, quoted verbatim —
//! never paraphrased, never re-ordered inside a block.
//!
//! The splitter is CONSERVATIVE by design: it splits only on a terminator
//! followed by whitespace and a capital/digit start, refuses to split after
//! known abbreviations, initials ("U.S.", "J. Doe"), decimals ("3.14"), and
//! list numbering ("1. item") — and when a text yields fewer than two
//! sentences it rides WHOLE. Wrong joins waste a few tokens; wrong splits
//! corrupt quotes. KEEP IN SYNC with src/server/quotes.ts (same cases pinned
//! in test/quotes.test.mjs and the cargo tests below).
//!
//! Cloud and llama-6144 never enter — the caller gates on the §1 tier.

use crate::llm::Ctx;

/// Words that end with '.' without ending a sentence (lowercased, no dot).
const ABBREVS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "cf", "al",
    "inc", "ltd", "co", "corp", "no", "dept", "est", "approx", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "fig", "vol", "rev", "gen",
];

/// True when the text ENDING at terminator position `i` (exclusive of the
/// terminator) must NOT be split there.
fn suppressed(before: &str, term: char) -> bool {
    if term != '.' {
        return false;
    }
    // The word the period ends, lowercased ("U.S" stays dotted — initials).
    let word: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_alphanumeric() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let w = word.to_lowercase();
    if w.is_empty() {
        return true; // a bare "." with no word — refuse
    }
    // Single letter ("J.") or dotted run ("u.s", "e.g") — initials/abbrevs.
    if w.chars().filter(|c| c.is_alphanumeric()).count() == 1 || w.contains('.') {
        return true;
    }
    // Pure digits ("3." in "3.14" is caught by the digit-follows rule; "1."
    // list numbering is caught here when the sentence starts with it).
    if w.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    ABBREVS.contains(&w.as_str())
}

/// Conservative sentence split. Returns the text's sentences (trimmed,
/// non-empty). When in doubt it under-splits; a caller seeing < 2 sentences
/// should treat the text as unsplittable and keep it whole.
pub fn split_sentences(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '.' || c == '!' || c == '?' {
            // Absorb a closing quote/paren riding the terminator.
            let mut end = i + 1;
            while end < chars.len() && matches!(chars[end], '"' | '\'' | ')' | '”' | '’') {
                end += 1;
            }
            let ws_next = chars.get(end).map(|c| c.is_whitespace()).unwrap_or(true);
            // The next sentence must START like one: capital, digit, quote.
            let mut j = end;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let starts_new = chars
                .get(j)
                .map(|c| c.is_uppercase() || c.is_ascii_digit() || matches!(c, '"' | '“' | '‘'))
                .unwrap_or(true);
            // A digit immediately after a '.' is a decimal ("3.14") — never split.
            let decimal = c == '.' && chars.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false);
            let before: String = chars[start..i].iter().collect();
            if ws_next && starts_new && !decimal && !suppressed(&before, c) {
                let s: String = chars[start..end].iter().collect();
                let s = s.trim();
                if !s.is_empty() {
                    out.push(s.to_string());
                }
                start = j;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    let tail: String = chars[start..].iter().collect();
    let tail = tail.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    out
}

/// Whitespace-normalized form for overlap comparison.
fn normalized(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Lexical relevance of one sentence to the question tokens: matched-token
/// count, damped by length so a giant sentence can't win on volume alone.
fn sentence_score(sentence: &str, tokens: &[String]) -> f64 {
    let s = sentence.to_lowercase();
    let hits = tokens.iter().filter(|t| s.contains(t.as_str())).count() as f64;
    hits / (1.0 + (sentence.chars().count() as f64 / 200.0))
}

/// Digest ONE block's text to its question-relevant sentences, quoted and in
/// ORIGINAL order, within `budget` chars. Unsplittable or already-small text
/// rides whole (clipped to the budget only as the last resort). `skip` holds
/// normalized sentences already emitted by an earlier adjacent block — the
/// ~20% neighbor overlap is dropped from the LATER block.
fn digest_text(
    text: &str,
    tokens: &[String],
    budget: usize,
    skip: &mut std::collections::HashSet<String>,
) -> String {
    if text.chars().count() <= budget {
        // Small enough already: still register its sentences for overlap
        // dedupe, but keep the text verbatim.
        for s in split_sentences(text) {
            skip.insert(normalized(&s));
        }
        return text.to_string();
    }
    let sentences = split_sentences(text);
    if sentences.len() < 2 {
        // Unsplittable: conservative clip (whole-block head), never a re-write.
        return text.chars().take(budget).collect::<String>() + "…";
    }
    // Deduped against earlier blocks, then ranked; ties keep document order.
    let fresh: Vec<(usize, &String)> = sentences
        .iter()
        .enumerate()
        .filter(|(_, s)| !skip.contains(&normalized(s)))
        .collect();
    let scored: Vec<(usize, f64)> =
        fresh.iter().map(|(i, s)| (*i, sentence_score(s, tokens))).collect();
    // Selection order: question-RELEVANT sentences by score (ties in document
    // order). When nothing scores — a block retrieval matched semantically
    // but shares no literal token — fall back to the deduped head in document
    // order, so the block still contributes its freshest content.
    let order: Vec<usize> = if scored.iter().any(|(_, s)| *s > 0.0) {
        let mut r: Vec<(usize, f64)> = scored.into_iter().filter(|(_, s)| *s > 0.0).collect();
        r.sort_by(|a, b| {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0))
        });
        r.into_iter().map(|(i, _)| i).collect()
    } else {
        fresh.iter().map(|(i, _)| *i).collect()
    };
    let mut keep: Vec<usize> = Vec::new();
    let mut used = 0usize;
    for i in order {
        let n = sentences[i].chars().count() + 4; // "…" joiners
        if used + n > budget {
            continue;
        }
        used += n;
        keep.push(i);
    }
    if keep.is_empty() {
        // Budget too tight for any sentence — head-clip, stay honest.
        return text.chars().take(budget).collect::<String>() + "…";
    }
    keep.sort_unstable();
    let mut parts: Vec<String> = Vec::new();
    let mut prev: Option<usize> = None;
    for i in keep {
        skip.insert(normalized(&sentences[i]));
        // An ellipsis marks every gap so the model (and a reader) can see
        // the quote is excerpted, not continuous.
        if let Some(p) = prev {
            if i != p + 1 {
                parts.push("…".to_string());
            }
        } else if i != 0 {
            parts.push("…".to_string());
        }
        parts.push(sentences[i].clone());
        prev = Some(i);
    }
    if prev.map(|p| p + 1 < sentences.len()).unwrap_or(false) {
        parts.push("…".to_string());
    }
    parts.join(" ")
}

/// §5: the retrieved blocks, digested for a shared-window tier. Block COUNT
/// and ORDER are preserved (the `[n]` citation contract), names untouched;
/// only each block's text shrinks. `total_budget`/`block_budget` come from
/// the §1 segment budgets. Engine-built blocks (score-0 profiles, assists)
/// should not be passed here — quotes are for retrieved evidence.
pub fn digest_contexts(
    contexts: Vec<Ctx>,
    question: &str,
    block_budget: usize,
    total_budget: usize,
) -> Vec<Ctx> {
    if contexts.is_empty() {
        return contexts;
    }
    let tokens = crate::analytics::question_tokens(question);
    // Fair share, floored so late blocks are never starved to nothing.
    let share = (total_budget / contexts.len()).clamp(280, block_budget);
    let mut skip: std::collections::HashSet<String> = std::collections::HashSet::new();
    contexts
        .into_iter()
        .map(|c| {
            let text = digest_text(&c.text, &tokens, share, &mut skip);
            Ctx { name: c.name, text, score: c.score }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- The splitter torture suite (the streamingMarkdown-torture idiom) ----

    #[test]
    fn splitter_handles_plain_prose() {
        let s = split_sentences("Revenue rose in Q3. The west region led. Margins held steady.");
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], "Revenue rose in Q3.");
        assert_eq!(s[2], "Margins held steady.");
    }

    #[test]
    fn splitter_never_splits_abbreviations_initials_or_decimals() {
        // U.S. + decimal + Dr. + e.g. — all must survive as joins.
        let s = split_sentences(
            "The U.S. market grew 3.14 percent under Dr. Lee. Deals closed, e.g. the Acme one.",
        );
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(s[0].contains("U.S. market"), "{s:?}");
        assert!(s[0].contains("3.14"), "{s:?}");
        assert!(s[1].contains("e.g. the Acme"), "{s:?}");
    }

    #[test]
    fn splitter_keeps_numbered_lists_and_lowercase_continuations_whole() {
        // "1." list numbering and a lowercase continuation must not split.
        let s = split_sentences("Steps: 1. open the vault 2. ask a question and wait.");
        assert_eq!(s.len(), 1, "{s:?}");
        // Terminator followed by lowercase — not a sentence start.
        let s2 = split_sentences("It shipped v1.2 of the app. then everything changed.");
        assert_eq!(s2.len(), 1, "lowercase continuation refuses the split: {s2:?}");
    }

    #[test]
    fn splitter_handles_quotes_questions_and_exclaims() {
        let s = split_sentences("\"Did it work?\" She said yes! The report agrees.");
        assert_eq!(s.len(), 3, "{s:?}");
        assert_eq!(s[0], "\"Did it work?\"");
    }

    #[test]
    fn unsplittable_text_rides_whole() {
        assert_eq!(split_sentences("no terminators here at all").len(), 1);
        assert_eq!(split_sentences("").len(), 0);
    }

    // --- The digest -----------------------------------------------------------

    fn ctx(name: &str, text: &str) -> Ctx {
        Ctx { name: name.into(), text: text.into(), score: 1.0 }
    }

    #[test]
    fn digest_preserves_block_count_order_and_names() {
        let long_a = format!("Revenue was 42 in the west. {}", "Filler sentence here. ".repeat(40));
        let blocks = vec![ctx("a.md", &long_a), ctx("b.md", "Short block stays whole.")];
        let out = digest_contexts(blocks, "west revenue", 3_500, 700);
        assert_eq!(out.len(), 2, "block count preserved — the [n] contract");
        assert_eq!(out[0].name, "a.md");
        assert_eq!(out[1].name, "b.md");
        assert_eq!(out[1].text, "Short block stays whole.");
    }

    #[test]
    fn digest_keeps_question_relevant_sentences_verbatim_with_gap_marks() {
        let text = format!(
            "Intro fluff sentence first. Revenue was 42 in the west region. {}The margin was 9 percent in the west. Tail fluff closes.",
            "Unrelated filler sentence. ".repeat(30)
        );
        let out = digest_contexts(vec![ctx("r.md", &text)], "west region revenue margin", 3_500, 400);
        let t = &out[0].text;
        assert!(t.contains("Revenue was 42 in the west region."), "verbatim quote: {t}");
        assert!(t.contains("…"), "gaps are marked: {t}");
        assert!(!t.contains("Intro fluff"), "irrelevant head dropped: {t}");
        assert!(t.chars().count() <= 420, "inside budget: {}", t.chars().count());
    }

    #[test]
    fn neighbor_overlap_dedupes_from_the_later_block() {
        let shared = "The west region led all quarters this year with steady growth.";
        let a = format!("{shared} Alpha detail sentence follows. {}", "Pad sentence here. ".repeat(30));
        let b = format!("{shared} Beta detail sentence follows. {}", "More padding text. ".repeat(30));
        let out = digest_contexts(
            vec![ctx("a.md", &a), ctx("b.md", &b)],
            "west region led quarters",
            3_500,
            600,
        );
        assert!(out[0].text.contains(shared), "first block keeps the shared sentence");
        assert!(!out[1].text.contains(shared), "later block drops the duplicate: {}", out[1].text);
    }

    #[test]
    fn digest_is_deterministic() {
        let text = format!("Alpha 42 west. {}", "Filler sentence. ".repeat(50));
        let a = digest_contexts(vec![ctx("x", &text)], "west", 3_500, 300);
        let b = digest_contexts(vec![ctx("x", &text)], "west", 3_500, 300);
        assert_eq!(a[0].text, b[0].text);
    }
}
