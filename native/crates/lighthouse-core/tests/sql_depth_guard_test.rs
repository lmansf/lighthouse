//! The read-only SQL guard must REFUSE a pathologically deep statement, not
//! die on it.
//!
//! `analytics::guard_sql` is the single door every executed query goes through
//! — the model's `NEXT_SQL:` reply (`parse_step_reply` → `run_query`), a saved
//! view, a semantic metric, and the MCP `run_analytics_sql` tool, which hands
//! an MCP client's raw SQL straight to `run_direct` → `run_query` → `guard_sql`.
//! All of those are bytes we did not write.
//!
//! sqlparser parses a CHAINED SET OPERATION iteratively — `parse_remaining_set_exprs`
//! loops, re-entering `parse_query_body` only at equal precedence, which breaks
//! immediately — so the parser's own recursion counter (DEFAULT_REMAINING_DEPTH
//! = 50, the thing that stops `((((SELECT 1))))`) never fires, and it happily
//! returns a left-nested `SetExpr::SetOperation` spine N levels deep for N
//! `UNION ALL`s. `guard_sql`'s `set_expr_is_read_only` then walks that spine
//! with unbounded recursion: the attacker's byte count picks our stack depth.
//!
//! A stack overflow is NOT a catchable panic. The thread touches its guard
//! page, the runtime prints "has overflowed its stack" and SIGABRTs the WHOLE
//! process — before the query ever executes, with no dialog, no log line the
//! user sees, and nothing `catch_unwind` can hold. So these tests cannot
//! assert-on-panic: they assert the guard returns a clean `Err`, and on
//! unfixed code the test BINARY dies (signal 6) at the first case that runs.
//! That death is the finding.
//!
//! The safe property pinned here: for any input at all, `guard_sql` returns —
//! `Ok` or `Err`, never a process abort.

use lighthouse_core::analytics::{guard_metric_expression, guard_sql, propose_metric};

/// The stack the guard actually runs on in the app: 2 MiB is Rust's default
/// for a spawned thread and tokio's default for a worker / `spawn_blocking`
/// thread, which is where the shell's commands run. Pinning it explicitly
/// keeps the test independent of the harness's own stack size.
const WORKER_STACK: usize = 2 * 1024 * 1024;

/// Run `f` on a worker-sized stack and return its value. On unfixed code this
/// never returns: the overflow takes the process down, join and all.
fn on_worker_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(WORKER_STACK)
        .spawn(f)
        .expect("spawn worker-stack thread")
        .join()
        .expect("guard thread must not die")
}

/// `SELECT 1 UNION ALL SELECT 1 …` with `n` set operations — a read-only
/// SELECT by every rule the guard has, and an `n`-deep AST.
fn union_chain(n: usize) -> String {
    let mut sql = String::with_capacity(19 * n + 8);
    sql.push_str("SELECT 1");
    for _ in 0..n {
        sql.push_str(" UNION ALL SELECT 1");
    }
    sql
}

/// The same chain smuggled through the semantic layer's metric door, which
/// synthesizes `SELECT {expression} AS metric_value FROM {entity}` and then
/// walks the result twice — `guard_sql`, then `views::collect_table_names`,
/// whose `walk_set_expr` recurses on the same unbounded spine.
fn metric_expression(n: usize) -> String {
    let mut expr = String::with_capacity(26 * n + 2);
    for _ in 0..n {
        expr.push_str("1 FROM t UNION ALL SELECT ");
    }
    expr.push('1');
    expr
}

#[test]
fn a_deep_union_chain_is_refused_instead_of_overflowing_the_stack() {
    // Control: the shape is an ordinary read-only SELECT the guard accepts,
    // so the deep case below cannot pass vacuously on a parse error.
    assert!(guard_sql(&union_chain(3)).is_ok(), "control chain must pass");

    // ~190 KB of model output. Well under any prompt or reply cap, and past
    // the depth a 2 MiB stack survives (measured: 5_000 returns Ok, 10_000
    // aborts).
    let sql = union_chain(10_000);
    let verdict = on_worker_stack(move || guard_sql(&sql));
    assert!(
        verdict.is_err(),
        "a 10_000-deep UNION chain must be REFUSED by the guard, not walked; got {verdict:?}"
    );
}

#[test]
fn over_long_sql_is_refused_before_it_is_ever_parsed() {
    // ~950 KB. Bounding the WALK is not enough here: sqlparser's AST has
    // recursive drop glue, so once a spine this deep exists, merely dropping
    // it overflows the same 2 MiB stack (measured: parse-then-drop alone,
    // with no walk at all, SIGABRTs at 50_000). The only way to return from
    // this call is to refuse the input BEFORE parsing it.
    let sql = union_chain(50_000);
    let verdict = on_worker_stack(move || guard_sql(&sql));
    assert!(
        verdict.is_err(),
        "SQL this size must be refused up front; got {verdict:?}"
    );
}

#[test]
fn a_deep_metric_expression_is_refused_instead_of_overflowing_the_stack() {
    // Control: the injected shape is parseable SQL, so the deep case cannot
    // pass vacuously. (Whether the guard ACCEPTS the shallow injection is a
    // separate question this test deliberately does not pin.)
    let shallow = guard_metric_expression(&metric_expression(3), "ent");
    assert!(
        !format!("{shallow:?}").contains("parse error"),
        "control expression must parse, else the deep case proves nothing; got {shallow:?}"
    );

    let expr = metric_expression(10_000);
    let verdict = on_worker_stack(move || guard_metric_expression(&expr, "ent"));
    assert!(
        verdict.is_err(),
        "a 10_000-deep metric expression must be REFUSED, not walked; got {verdict:?}"
    );
}

/// `propose_metric` is the one remaining door on this surface that reaches
/// `DFParser::parse_sql` WITHOUT passing `guard_sql` — and it additionally
/// CLONES the parsed body (`answer_select`), so a deep spine costs a recursive
/// clone plus two recursive drops. Its input is second-hand (an executed
/// answer's SQL, or a stored pin's, replayed by `semantic::propose_metrics`),
/// but second-hand model output is still model output. Measured: with the
/// guard's caps in place but this door open, a 5.7 MB chain here SIGABRTs the
/// process; it must return an honest "nothing to propose" instead.
#[test]
fn metric_mining_refuses_over_long_sql_instead_of_parsing_it() {
    // Control: an ordinary answer still yields a proposal, so the refusal
    // below cannot pass vacuously.
    assert_eq!(
        propose_metric("SELECT SUM(amount) AS total FROM sales"),
        Some(("SUM(amount)".to_string(), "sales".to_string()))
    );

    let sql = union_chain(300_000);
    let verdict = on_worker_stack(move || propose_metric(&sql));
    assert!(
        verdict.is_none(),
        "over-long SQL must never reach the parser here; got {verdict:?}"
    );
}

/// The over-rejection sentinel: a cap that refuses real SQL is its own outage.
/// Nothing else in the suite pins the widest chain this app GENERATES — the
/// data-quality recipe unions one arm per column up to DQ_MAX_COLS = 40, while
/// the recipe tests only resolve a 4-column fixture.
#[test]
fn ordinary_and_recipe_width_sql_still_passes() {
    guard_sql("SELECT 1").unwrap();
    guard_sql("SELECT 1 UNION ALL SELECT 2").unwrap();
    guard_sql("WITH c AS (SELECT 1 AS a) SELECT a FROM c").unwrap();
    // `union_chain(n)` is n set operations, i.e. n + 1 arms: 39 => the
    // production maximum of 40.
    guard_sql(&format!("{} ORDER BY 1", union_chain(39))).unwrap();
}
