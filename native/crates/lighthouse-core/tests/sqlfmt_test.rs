//! §1 proof gate: the display pretty-printer is a WHITESPACE-ONLY transform.
//!
//! For every statement the engine could show, `format_sql(sql)` must parse to
//! the identical AST as `sql` — same parser the guard/executor uses
//! (`DFParser`), so the formatted text and the executed text can never mean
//! different things. We compare the parsed statements' `Debug` form with the
//! source SPANS stripped: sqlparser records each token's byte position
//! (`Span(Location(line,col)..)`) in the AST, and those positions necessarily
//! move when the pretty-printer reflows whitespace — so a raw `Debug` compare
//! would flag a correct whitespace-only reformat as an AST change. With the
//! spans normalized away, equality here IS AST-equivalence (a real structural
//! change still differs in non-span content).

use lighthouse_core::sqlfmt::format_sql;

fn ast_debug(sql: &str) -> String {
    let stmts = datafusion::sql::parser::DFParser::parse_sql(sql)
        .unwrap_or_else(|e| panic!("parse failed for {sql:?}: {e}"));
    strip_spans(&format!("{stmts:?}"))
}

/// Drop every `Span(Location(l,c)..Location(l,c))` sub-string from a parsed
/// statement's `Debug` output. Spans are the byte positions of tokens — exactly
/// what a whitespace reflow changes — so removing them makes the compare
/// structural rather than positional.
fn strip_spans(debug: &str) -> String {
    let mut out = String::with_capacity(debug.len());
    let mut rest = debug;
    while let Some(i) = rest.find("Span(Location(") {
        out.push_str(&rest[..i]);
        let after = &rest[i..];
        match after.find("))") {
            Some(j) => {
                out.push_str("Span(_)");
                rest = &after[j + 2..];
            }
            None => {
                out.push_str(after);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A corpus spanning the shapes the analytics engine actually emits (the
/// SQL_FEWSHOTS + recipe planners) plus the adversarial cases the formatter
/// must not break: strings containing SQL keywords and commas, quoted
/// identifiers, subqueries, CTEs, window functions, CASE, JOINs.
const CORPUS: &[&str] = &[
    "SELECT * FROM sales",
    "SELECT region, SUM(amount) AS total FROM sales GROUP BY region ORDER BY total DESC LIMIT 10",
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'open'",
    "SELECT a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p FROM very_wide_table WHERE x > 0",
    "SELECT date_trunc('month', ts) AS m, SUM(x) FROM t GROUP BY 1 ORDER BY 1",
    "SELECT name FROM t WHERE note = 'total, from where group by order'",
    "SELECT \"weird col\", \"from\" FROM \"my table\"",
    "SELECT c.name, o.total FROM customers c INNER JOIN orders o ON c.id = o.customer_id",
    "SELECT r, SUM(x) FROM (SELECT region AS r, amount AS x FROM sales WHERE amount > 0) sub GROUP BY r",
    "WITH monthly AS (SELECT date_trunc('month', ts) AS m, SUM(x) AS s FROM t GROUP BY 1) SELECT m, s FROM monthly ORDER BY m",
    "SELECT region, SUM(x) OVER (PARTITION BY region ORDER BY ts) AS running FROM t",
    "SELECT CASE WHEN x > 0 THEN 'pos' WHEN x < 0 THEN 'neg' ELSE 'zero' END AS sign, COUNT(*) FROM t GROUP BY 1",
    "SELECT a FROM t WHERE b IN (1, 2, 3) AND c BETWEEN 10 AND 20",
    "SELECT AVG(price), MIN(price), MAX(price), STDDEV(price) FROM products WHERE category = 'widgets'",
    "SELECT a.x, b.y, c.z FROM a LEFT JOIN b ON a.id = b.a_id LEFT JOIN c ON b.id = c.b_id WHERE a.active",
    "SELECT 1.5e-3 AS tiny, 1_000_000 AS big, -42 AS neg FROM dual",
];

#[test]
fn formatting_preserves_the_statement_ast() {
    for sql in CORPUS {
        let formatted = format_sql(sql);
        assert_eq!(
            ast_debug(&formatted),
            ast_debug(sql),
            "format_sql changed the AST!\n--- input ---\n{sql}\n--- formatted ---\n{formatted}"
        );
    }
}

#[test]
fn formatting_is_idempotent() {
    for sql in CORPUS {
        let once = format_sql(sql);
        let twice = format_sql(&once);
        assert_eq!(once, twice, "not idempotent for {sql:?}:\n{once}\n---\n{twice}");
    }
}

#[test]
fn multi_clause_queries_gain_line_breaks() {
    // The whole point: a one-line query becomes several lines.
    let one_liner = "SELECT region, SUM(amount) FROM sales GROUP BY region ORDER BY 2 DESC";
    let formatted = format_sql(one_liner);
    assert!(
        formatted.matches('\n').count() >= 3,
        "expected clause breaks, got:\n{formatted}"
    );
    assert!(formatted.starts_with("SELECT region, SUM(amount)"), "got:\n{formatted}");
    assert!(formatted.contains("\nFROM sales"), "got:\n{formatted}");
    assert!(formatted.contains("\nGROUP BY region"), "got:\n{formatted}");
    assert!(formatted.contains("\nORDER BY 2 DESC"), "got:\n{formatted}");
}

#[test]
fn a_subquery_indents_its_clauses() {
    let sql = "SELECT r FROM (SELECT region AS r FROM sales WHERE amount > 0) sub";
    let formatted = format_sql(sql);
    // The inner FROM/WHERE sit a step in from the outer query.
    assert!(formatted.contains("\n  FROM sales"), "got:\n{formatted}");
    assert!(formatted.contains("\n  WHERE amount > 0"), "got:\n{formatted}");
}
