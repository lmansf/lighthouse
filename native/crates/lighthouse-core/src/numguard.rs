//! §44 §2: the numeric TRUST GUARD — a deterministic, model-free gate that
//! keeps the constitution's promise ("every number about data is engine-
//! verified or it is not shown") at the analytics fall-through seams.
//!
//! The digit-gate that the report framer already uses (reports.rs's
//! `findings_number_set` / `framing_number_gate`) is ported HERE into a shared
//! helper so the report path and the analytics/RAG paths tokenize numbers the
//! same way and reject an unverified figure the same way. When on-device
//! NL→SQL produces no executed query and no §1b profile answer, a numeric ask
//! over tabular data must degrade to an honest number-free reply rather than
//! narrate a figure from raw chunks — this module is that enforcement.
//!
//! PARITY: byte-identical to src/server/numguard.ts (tokenizer, verified-set
//! membership, and the byte-pinned degradation copy).

use std::collections::BTreeSet;

/// Every numeric token in `text`, normalized: commas stripped, surrounding
/// dots trimmed, kept only when it carries a digit. "$4,200.50" → "4200.50",
/// "2024-10" → {"2024","10"}, "row 7." → "7". Ported verbatim from reports.rs
/// so the report framer and the §44 guard tokenize identically.
pub fn number_tokens(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut BTreeSet<String>| {
        if cur.is_empty() {
            return;
        }
        let cleaned = cur.replace(',', "");
        let trimmed = cleaned.trim_matches('.');
        if trimmed.chars().any(|c| c.is_ascii_digit()) {
            out.insert(trimmed.to_string());
        }
        cur.clear();
    };
    for c in text.chars() {
        if c.is_ascii_digit() || ((c == '.' || c == ',') && !cur.is_empty()) {
            cur.push(c);
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// A token set plus each token's integer part, so "400" faithfully cites
/// "400.25" without loosening the gate to arbitrary rounding.
pub fn with_integer_parts(tokens: BTreeSet<String>) -> BTreeSet<String> {
    let mut out = tokens.clone();
    for t in &tokens {
        if let Some((int, _)) = t.split_once('.') {
            if !int.is_empty() {
                out.insert(int.to_string());
            }
        }
    }
    out
}

/// The engine-verified number set drawn from one or more AUTHORITATIVE sources
/// (a SQL result table's markdown, a `table_profile()` block) — the only
/// digits an answer about tabular data may state. Integer parts included so a
/// rounded citation of a verified decimal still passes.
pub fn verified_set(sources: &[&str]) -> BTreeSet<String> {
    let mut all = BTreeSet::new();
    for s in sources {
        all.extend(number_tokens(s));
    }
    with_integer_parts(all)
}

/// Remove `[n]` / `[1, 2]` citation markers so a reference index never reads as
/// a data figure — otherwise a faithful, number-free qualitative answer that
/// merely carries a `[1]` citation would be degraded. Only bracketed spans
/// that are ENTIRELY digits/commas/spaces (and carry at least one digit) are
/// stripped; `[note]` and prose brackets are untouched.
pub fn strip_citation_markers(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            // Look for a nearby closing ']' (citation markers are short).
            if let Some(j) = (i + 1..chars.len()).take(24).find(|&k| chars[k] == ']') {
                let inner: String = chars[i + 1..j].iter().collect();
                let citation = !inner.is_empty()
                    && inner.chars().all(|c| c.is_ascii_digit() || c == ',' || c == ' ')
                    && inner.chars().any(|c| c.is_ascii_digit());
                if citation {
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// True when `answer` states a numeric token the engine did not produce — a
/// number absent from the verified set (after citation markers are stripped).
/// This is the `!cited.is_subset(findings)` test of the report framer's gate,
/// generalized to any answer + any engine-verified source set.
pub fn answer_has_unverified_number(answer: &str, verified: &BTreeSet<String>) -> bool {
    let cited = number_tokens(&strip_citation_markers(answer));
    !cited.is_subset(verified)
}

/// The byte-pinned honest degradation: when a numeric ask over tabular data
/// could not be verified (no executed SQL, no §1b profile), we say so and name
/// columns to retry with, rather than narrate a figure the engine never
/// computed. `columns` guides the retry; empty falls back to the generic
/// placeholders. KEEP IN SYNC with numguard.ts::numberFreeDegradation.
pub fn number_free_degradation(file: &str, columns: &[String]) -> String {
    let file = if file.is_empty() { "this file" } else { file };
    let examples = match columns {
        [c0, c1, c2, ..] => format!("\"average {c0}\" or \"total {c1} by {c2}\""),
        [c0, c1] => format!("\"average {c0}\" or \"total {c1}\""),
        [c0] => format!("\"average {c0}\""),
        [] => "\"average <column>\" or \"total <x> by <y>\"".to_string(),
    };
    format!(
        "I can read {file}, but I couldn't compute a verified statistic for that. \
         Try phrasing it as {examples} — I only show numbers Lighthouse computed from the data."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_tokens_match_the_report_framers_tokenizer() {
        // The same fixture reports.rs pins — the port must not drift.
        let toks = number_tokens("$4,200.50 rose +2.85σ over 2024-10; see row 7.");
        for t in ["4200.50", "2.85", "2024", "10", "7"] {
            assert!(toks.contains(t), "{t} missing from {toks:?}");
        }
        assert!(!toks.contains("4,200.50"), "separators are stripped");
        assert!(!toks.contains("7."), "sentence punctuation is trimmed");
        assert!(number_tokens("no digits here").is_empty());
    }

    #[test]
    fn verified_set_admits_integer_parts_only() {
        let v = verified_set(&["mean 7.25, sum 210"]);
        assert!(v.contains("7.25") && v.contains("7"), "decimal and its integer part");
        assert!(v.contains("210"));
        assert!(!v.contains("8"), "an unrelated number is not admitted");
    }

    #[test]
    fn unverified_number_is_caught_and_faithful_citation_passes() {
        let verified = verified_set(&["mean 7.25 min 5 max 9"]);
        // A faithful narration (only verified figures, integer part allowed).
        assert!(
            !answer_has_unverified_number("Your nightly average is about 7 hours.", &verified),
            "7 is the integer part of the verified 7.25"
        );
        // An invented figure the engine never produced.
        assert!(
            answer_has_unverified_number("Your average is 6.5 hours across 42 nights.", &verified),
            "6.5 and 42 appear nowhere in the verified set"
        );
        // A purely qualitative answer states no number and passes even with an
        // empty verified set.
        assert!(!answer_has_unverified_number("This file tracks nightly sleep.", &verified));
    }

    #[test]
    fn citation_markers_are_not_data_numbers() {
        let empty = BTreeSet::new();
        // A number-free qualitative answer carrying citations must NOT degrade.
        assert!(!answer_has_unverified_number(
            "The log records bedtime and wake time [1], plus a quality note [2, 3].",
            &empty,
        ));
        // But a real figure outside the citations still trips the guard.
        assert!(answer_has_unverified_number("The average was 7.2 hours [1].", &empty));
    }

    #[test]
    fn degradation_names_columns_and_is_byte_pinned() {
        let cols = vec!["sleep_hours".to_string(), "quality".to_string(), "weekday".to_string()];
        assert_eq!(
            number_free_degradation("sleep.csv", &cols),
            "I can read sleep.csv, but I couldn't compute a verified statistic for that. \
             Try phrasing it as \"average sleep_hours\" or \"total quality by weekday\" — \
             I only show numbers Lighthouse computed from the data."
        );
        // No columns → the generic placeholders; empty file name → "this file".
        assert_eq!(
            number_free_degradation("", &[]),
            "I can read this file, but I couldn't compute a verified statistic for that. \
             Try phrasing it as \"average <column>\" or \"total <x> by <y>\" — \
             I only show numbers Lighthouse computed from the data."
        );
    }
}
