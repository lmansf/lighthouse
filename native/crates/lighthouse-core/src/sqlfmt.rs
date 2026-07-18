//! Deterministic, AST-preserving SQL pretty-printer (usability patch §1).
//!
//! The analytics engine writes the executed SQL into every answer's
//! `*Query used:*` fence, into saved view definitions, and into evidence
//! packs. Rendered as one long line it is unreadable. This module lays that
//! SQL out — clause keywords on their own lines, indented bodies, and a wide
//! `SELECT` list broken one column per line — for DISPLAY only.
//!
//! Safety invariant (why the executed statement is never altered): the
//! formatter ONLY changes whitespace *between* tokens. It never edits the
//! bytes inside a string literal, a quoted identifier, or a comment, and it
//! never drops a separator that two adjacent tokens need. Because SQL is
//! whitespace-insensitive outside those spans, `format_sql(s)` parses to the
//! SAME statement as `s` — proven exhaustively in `tests/sqlfmt_test.rs`
//! (format → parse → identical AST) over the shapes the engine emits.
//!
//! PARITY: mirrored byte-for-byte by `src/lib/sqlFormat.ts`. The two engines
//! must produce identical output so the Edit-SQL dialog (rendered by the TS
//! UI) and the answer fence (written by the Rust engine) show the same
//! formatting for the same statement.

/// Past this rendered width (indent + `SELECT ` + the joined column list) the
/// SELECT list breaks to one column per line. PARITY: identical in the twin.
const SELECT_WRAP_WIDTH: usize = 72;

/// One indent step. Spaces, not tabs — copy/paste into any SQL console is
/// then WYSIWYG regardless of tab width. PARITY.
const INDENT: &str = "  ";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A bare word: keyword or identifier (case preserved).
    Word,
    /// `'...'` string literal — preserved verbatim, never reflowed.
    Str,
    /// `"..."` quoted identifier — preserved verbatim.
    Quoted,
    /// A numeric literal.
    Num,
    /// Operators / punctuation (`,`, `(`, `)`, `.`, `=`, `<=`, `::`, …).
    Punct,
    /// `-- ...` to end of line.
    LineComment,
    /// `/* ... */`.
    BlockComment,
}

struct Tok {
    kind: Kind,
    text: String,
}

/// Clause keywords that open a new line at the current subquery indent.
/// Uppercased before lookup, so `select` and `SELECT` both match. Two-word
/// forms (`GROUP BY`, `ORDER BY`) are recognised as a pair in `is_clause_at`.
const CLAUSE_WORDS: &[&str] = &[
    "SELECT", "FROM", "WHERE", "HAVING", "LIMIT", "OFFSET", "WINDOW", "UNION",
    "INTERSECT", "EXCEPT", "VALUES", "WITH",
];

/// JOIN-family lead words — each opens its own line (`LEFT JOIN`, `INNER
/// JOIN`, `JOIN`, `ON` …). `ON`/`USING` also break so a join predicate reads
/// under its join.
const JOIN_WORDS: &[&str] = &[
    "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "ON", "USING",
];

/// Format one SQL statement for display. Whitespace-only transform: the result
/// parses to the identical statement (see module docs). Input that fails to
/// tokenize cleanly still returns valid SQL — the layout just degrades.
pub fn format_sql(sql: &str) -> String {
    let toks = lex(sql);
    if toks.is_empty() {
        return sql.trim().to_string();
    }
    layout(&toks)
}

// --- Tokenizer --------------------------------------------------------------

fn lex(sql: &str) -> Vec<Tok> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0usize;
    let mut out: Vec<Tok> = Vec::new();
    while i < n {
        let c = b[i];
        // Whitespace is dropped; the layout re-inserts it.
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // Line comment: -- to newline (verbatim, sans the newline).
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            let start = i;
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            out.push(Tok { kind: Kind::LineComment, text: sql[start..i].to_string() });
            continue;
        }
        // Block comment: /* ... */ (verbatim).
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            let start = i;
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
            out.push(Tok { kind: Kind::BlockComment, text: sql[start..i].to_string() });
            continue;
        }
        // String literal: '...'; doubled '' is an escaped quote, not a close.
        if c == b'\'' {
            let start = i;
            i += 1;
            loop {
                if i >= n {
                    break;
                }
                if b[i] == b'\'' {
                    if i + 1 < n && b[i + 1] == b'\'' {
                        i += 2; // escaped quote
                        continue;
                    }
                    i += 1; // closing quote
                    break;
                }
                i += 1;
            }
            out.push(Tok { kind: Kind::Str, text: sql[start..i].to_string() });
            continue;
        }
        // Quoted identifier: "..."; doubled "" escapes.
        if c == b'"' {
            let start = i;
            i += 1;
            loop {
                if i >= n {
                    break;
                }
                if b[i] == b'"' {
                    if i + 1 < n && b[i + 1] == b'"' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(Tok { kind: Kind::Quoted, text: sql[start..i].to_string() });
            continue;
        }
        // Number: leading digit, or a dot immediately followed by a digit.
        if c.is_ascii_digit() || (c == b'.' && i + 1 < n && b[i + 1].is_ascii_digit()) {
            let start = i;
            i += 1;
            while i < n {
                let d = b[i];
                if d.is_ascii_digit() || d == b'.' || d == b'_' {
                    i += 1;
                } else if (d == b'e' || d == b'E')
                    && i + 1 < n
                    && (b[i + 1].is_ascii_digit() || b[i + 1] == b'+' || b[i + 1] == b'-')
                {
                    i += 2;
                } else {
                    break;
                }
            }
            out.push(Tok { kind: Kind::Num, text: sql[start..i].to_string() });
            continue;
        }
        // Word: identifier or keyword ([A-Za-z_][A-Za-z0-9_$]*).
        if c == b'_' || c.is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < n {
                let d = b[i];
                if d == b'_' || d == b'$' || d.is_ascii_alphanumeric() {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push(Tok { kind: Kind::Word, text: sql[start..i].to_string() });
            continue;
        }
        // Punctuation. Greedily take a known two-char operator, else one byte.
        let two = if i + 1 < n { &sql[i..i + 2] } else { "" };
        if matches!(two, "<=" | ">=" | "<>" | "!=" | "||" | "::" | "->") {
            out.push(Tok { kind: Kind::Punct, text: two.to_string() });
            i += 2;
            continue;
        }
        // Single-byte punctuation (UTF-8 safe: SQL punctuation is ASCII, and a
        // non-ASCII byte here can only be inside an identifier the parser
        // rejects anyway — take one full char to stay on a boundary).
        let ch_len = utf8_len(c);
        out.push(Tok { kind: Kind::Punct, text: sql[i..(i + ch_len).min(n)].to_string() });
        i += ch_len;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

// --- Layout -----------------------------------------------------------------

/// True when token `idx` begins a clause that should open its own line, given
/// the surrounding tokens. `depth` is the raw paren depth; `sub` is the paren
/// depth of the current subquery's own clauses (so `PARTITION BY`/`ORDER BY`
/// nested inside an `OVER(...)` or a function call stay inline).
fn is_clause_at(toks: &[Tok], idx: usize, depth: usize, sub: usize) -> Option<usize> {
    if depth != sub {
        return None;
    }
    let t = &toks[idx];
    if t.kind != Kind::Word {
        return None;
    }
    let w = t.text.to_ascii_uppercase();
    // Two-word clauses first.
    if (w == "GROUP" || w == "ORDER" || w == "PARTITION") && next_word_is(toks, idx, "BY") {
        return Some(2);
    }
    if w == "UNION" && (next_word_is(toks, idx, "ALL") || next_word_is(toks, idx, "DISTINCT")) {
        return Some(2);
    }
    if CLAUSE_WORDS.contains(&w.as_str()) || JOIN_WORDS.contains(&w.as_str()) {
        return Some(1);
    }
    None
}

/// The next non-comment word after `idx`, uppercased, equals `want`?
fn next_word_is(toks: &[Tok], idx: usize, want: &str) -> bool {
    let mut j = idx + 1;
    while j < toks.len() && matches!(toks[j].kind, Kind::LineComment | Kind::BlockComment) {
        j += 1;
    }
    j < toks.len() && toks[j].kind == Kind::Word && toks[j].text.eq_ignore_ascii_case(want)
}

fn layout(toks: &[Tok]) -> String {
    // Segment the token stream into clause lines. Each segment carries its own
    // indent (subquery nesting) and the tokens that belong to it. A subquery
    // is an open paren whose next significant token is SELECT/WITH — function
    // and OVER() parens do not indent, so `sum(x)` stays on one line.
    struct Seg {
        indent: usize,
        toks: Vec<usize>,
    }
    let mut segs: Vec<Seg> = Vec::new();
    let mut cur = Seg { indent: 0, toks: Vec::new() };
    let mut depth = 0usize; // raw paren depth
    let mut substack: Vec<usize> = Vec::new(); // paren depths that opened a subquery

    let mut i = 0usize;
    while i < toks.len() {
        let sub = *substack.last().unwrap_or(&0);
        // Clause break (but never as the very first token of a fresh segment,
        // so the leading SELECT keeps its keyword).
        if let Some(_span) = is_clause_at(toks, i, depth, sub) {
            if !cur.toks.is_empty() {
                segs.push(std::mem::replace(
                    &mut cur,
                    Seg { indent: substack.len(), toks: Vec::new() },
                ));
            } else {
                cur.indent = substack.len();
            }
        }

        // Track paren nesting / subquery entry for the CURRENT token.
        if toks[i].kind == Kind::Punct {
            match toks[i].text.as_str() {
                "(" => {
                    depth += 1;
                    if opens_subquery(toks, i) {
                        substack.push(depth);
                    }
                }
                ")" => {
                    if substack.last() == Some(&depth) {
                        substack.pop();
                    }
                    depth = depth.saturating_sub(1);
                }
                _ => {}
            }
        }

        cur.toks.push(i);
        i += 1;
    }
    if !cur.toks.is_empty() {
        segs.push(cur);
    }

    // Render each segment on its own line(s).
    let mut lines: Vec<String> = Vec::new();
    for seg in &segs {
        let pad = INDENT.repeat(seg.indent);
        let slice: Vec<&Tok> = seg.toks.iter().map(|&k| &toks[k]).collect();
        if is_select_seg(&slice) {
            render_select(&slice, &pad, &mut lines);
        } else {
            lines.push(format!("{pad}{}", render_inline(&slice)));
        }
    }
    lines.join("\n")
}

/// Does the paren at `idx` (a `(`) introduce a subquery — i.e. is its next
/// significant token SELECT or WITH? Then its clauses indent.
fn opens_subquery(toks: &[Tok], idx: usize) -> bool {
    let mut j = idx + 1;
    while j < toks.len() && matches!(toks[j].kind, Kind::LineComment | Kind::BlockComment) {
        j += 1;
    }
    j < toks.len()
        && toks[j].kind == Kind::Word
        && (toks[j].text.eq_ignore_ascii_case("select")
            || toks[j].text.eq_ignore_ascii_case("with"))
}

fn is_select_seg(slice: &[&Tok]) -> bool {
    slice
        .first()
        .map(|t| t.kind == Kind::Word && t.text.eq_ignore_ascii_case("select"))
        .unwrap_or(false)
}

/// Render `SELECT [DISTINCT] a, b, c`. Inline when it fits `SELECT_WRAP_WIDTH`;
/// otherwise one column per line, indented a step past `SELECT`.
fn render_select(slice: &[&Tok], pad: &str, lines: &mut Vec<String>) {
    // Split off the lead keyword(s): SELECT and an optional DISTINCT / ALL.
    let mut head_end = 1usize;
    if slice.len() > 1
        && slice[1].kind == Kind::Word
        && (slice[1].text.eq_ignore_ascii_case("distinct")
            || slice[1].text.eq_ignore_ascii_case("all"))
    {
        head_end = 2;
    }
    let head = render_inline(&slice[..head_end]);
    let body = &slice[head_end..];
    if body.is_empty() {
        lines.push(format!("{pad}{head}"));
        return;
    }
    // Split the projection on TOP-LEVEL commas (paren depth 0 within the body).
    let cols = split_top_commas(body);
    let inline = format!("{pad}{head} {}", cols.join(", "));
    if inline.chars().count() <= SELECT_WRAP_WIDTH || cols.len() < 2 {
        lines.push(inline);
        return;
    }
    lines.push(format!("{pad}{head}"));
    let col_pad = format!("{pad}{INDENT}");
    for (k, col) in cols.iter().enumerate() {
        let comma = if k + 1 < cols.len() { "," } else { "" };
        lines.push(format!("{col_pad}{col}{comma}"));
    }
}

/// Split a token slice into comma-separated pieces at paren depth 0, returning
/// each piece already rendered inline.
fn split_top_commas(body: &[&Tok]) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (k, t) in body.iter().enumerate() {
        if t.kind == Kind::Punct {
            match t.text.as_str() {
                "(" => depth += 1,
                ")" => depth -= 1,
                "," if depth == 0 => {
                    cols.push(render_inline(&body[start..k]));
                    start = k + 1;
                }
                _ => {}
            }
        }
    }
    cols.push(render_inline(&body[start..]));
    cols
}

/// Join tokens with a single space, applying tight-spacing rules that keep the
/// output conventional (and, critically, never merge two tokens illegally).
fn render_inline(slice: &[&Tok]) -> String {
    let mut out = String::new();
    for (k, t) in slice.iter().enumerate() {
        if k == 0 {
            out.push_str(&t.text);
            continue;
        }
        let prev = slice[k - 1];
        if needs_space(prev, t) {
            out.push(' ');
        }
        out.push_str(&t.text);
    }
    out
}

/// Whitespace between `prev` and `cur`. Default is one space; a small set of
/// tight cases drops it (before `,` `)` `.` `::`; after `(` `.` `::`; a
/// function-call `name(`). Dropping a space here can never change the parse:
/// none of these adjacencies form a different token.
fn needs_space(prev: &Tok, cur: &Tok) -> bool {
    let p = prev.text.as_str();
    let c = cur.text.as_str();
    // No space before these.
    if c == "," || c == ")" || c == "." || c == "::" {
        return false;
    }
    // No space after these.
    if p == "(" || p == "." || p == "::" {
        return false;
    }
    // Function/aggregate call: identifier or `)` immediately followed by `(`.
    // (`count(`, `date_trunc(` …). Keywords like IN/VALUES keep their space.
    if c == "(" {
        let call = (prev.kind == Kind::Word && !is_bare_keyword(p)) || p == ")";
        if call {
            return false;
        }
    }
    true
}

/// Keywords that should keep a space before a following `(` (so `IN (…)` and
/// `VALUES (…)` don't read as calls). Everything else that is a Word is
/// treated as a function name.
fn is_bare_keyword(w: &str) -> bool {
    let u = w.to_ascii_uppercase();
    matches!(
        u.as_str(),
        "IN" | "VALUES" | "AND" | "OR" | "NOT" | "ON" | "USING" | "FROM" | "WHERE"
            | "SELECT" | "BETWEEN" | "OVER" | "ALL" | "ANY" | "EXISTS" | "WHEN"
            | "THEN" | "ELSE" | "AS" | "BY" | "UNION" | "EXCEPT" | "INTERSECT"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keywords_break_onto_their_own_lines() {
        // Case is preserved exactly as the model wrote it — a whitespace-only
        // transform never touches token bytes.
        let got = format_sql("select a, b from t where a > 1 group by a order by b limit 10");
        assert_eq!(
            got,
            "select a, b\nfrom t\nwhere a > 1\ngroup by a\norder by b\nlimit 10"
        );
    }

    #[test]
    fn wide_select_breaks_one_column_per_line() {
        let sql = "select alpha_column, beta_column, gamma_column, delta_column, epsilon_column from wide_table";
        let got = format_sql(sql);
        assert!(got.starts_with("select\n  alpha_column,\n"), "got:\n{got}");
        assert!(got.contains("\n  beta_column,\n"), "got:\n{got}");
        assert!(got.contains("\n  epsilon_column\n"), "got:\n{got}");
        assert!(got.ends_with("from wide_table"), "got:\n{got}");
    }

    #[test]
    fn narrow_select_stays_inline() {
        let got = format_sql("select a, b, c from t");
        assert_eq!(got, "select a, b, c\nfrom t");
    }

    #[test]
    fn strings_are_never_reflowed() {
        let got = format_sql("select x from t where name = 'a,  b   from c'");
        assert!(got.contains("'a,  b   from c'"), "got:\n{got}");
    }

    #[test]
    fn function_calls_stay_tight() {
        let got = format_sql("select sum(amount), count(*) from t");
        assert!(got.contains("sum(amount)"), "got:\n{got}");
        assert!(got.contains("count(*)"), "got:\n{got}");
    }

    #[test]
    fn idempotent() {
        let sql = "select region, sum(x) from sales where y > 0 group by region order by sum(x) desc limit 5";
        let once = format_sql(sql);
        let twice = format_sql(&once);
        assert_eq!(once, twice, "format is not idempotent:\n{once}\n---\n{twice}");
    }
}
