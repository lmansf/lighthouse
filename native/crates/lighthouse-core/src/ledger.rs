//! Assumption ledger — an engine-derived "Assumptions" disclosure carried by
//! every analytics answer (openspec: add-recipes §1).
//!
//! The ledger is built ENTIRELY by inspecting the executed SQL — parsed with
//! the SAME `DFParser` as `guard_sql`, so the two can never disagree about what
//! the query says — plus the `QueryResult`'s row facts. The model contributes
//! nothing: the same `(sql, regs, result)` always yields byte-identical output
//! (a snapshot test pins this), and no narration text is ever read. When the
//! SQL doesn't parse, isn't a query, or reads no table (a bare `SELECT 1`), the
//! ledger degrades to the entries it can derive and omits the rest — it never
//! fabricates.
//!
//! PARITY: Rust-only, like the rest of analytics. The TS twin never takes the
//! analytics branch, so it emits no ledger (noted in `src/server/synth.ts`).

use datafusion::sql::parser::{DFParser, Statement as DFStatement};
use datafusion::sql::sqlparser::ast::{
    Expr, Function, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Select,
    SelectItem, SetExpr, Statement as SqlStatement,
};

use crate::analytics::{commafy, QueryResult, TableReg};

/// The row-count facts the ledger reads from an executed query — the ONLY part
/// of a `QueryResult` it needs. Threaded directly on the multi-step path, where
/// the last step's full `QueryResult` is consumed into a `StepRecord` before the
/// footer is emitted.
#[derive(Clone, Copy)]
pub struct RowFacts {
    pub shown: usize,
    pub truncated: bool,
    pub total: Option<usize>,
}

impl RowFacts {
    pub fn of(result: &QueryResult) -> Self {
        RowFacts {
            shown: result.shown,
            truncated: result.truncated,
            total: result.total,
        }
    }
}

/// Single-query entry: derive the ledger from the executed SQL + the result's
/// row facts. Returns an `*Assumptions:*` label followed by a markdown bullet
/// list, or `None` when nothing is derivable (unparseable SQL, a non-query
/// statement, or a bare `SELECT 1` that reads no table).
pub fn assumption_ledger(sql: &str, regs: &[TableReg], result: &QueryResult) -> Option<String> {
    build_ledger(sql, regs, Some(RowFacts::of(result)))
}

/// Multi-step entry: the last step's `QueryResult` is consumed into a
/// `StepRecord` before the footer is emitted, so its row facts are threaded in
/// as `RowFacts` (`Some`) — or `None`, which simply omits the rows-considered
/// bullet. Every OTHER bullet is derived from `sql` + `regs` exactly as the
/// single-query path does, so the ledger is never weakened beyond the one bullet
/// that genuinely needs the result.
pub fn assumption_ledger_parts(
    sql: &str,
    regs: &[TableReg],
    rows: Option<RowFacts>,
) -> Option<String> {
    build_ledger(sql, regs, rows)
}

/// Fixed bullet order — date, grouped-by, filtered, null-handling, rows — so
/// the ledger is byte-stable across runs and snapshot-testable.
fn build_ledger(sql: &str, regs: &[TableReg], rows: Option<RowFacts>) -> Option<String> {
    // Same parser as guard_sql: the ledger can never claim something the guard
    // didn't parse.
    let stmts = DFParser::parse_sql(sql).ok()?;
    let body = match stmts.front()? {
        DFStatement::Statement(s) => match &**s {
            SqlStatement::Query(q) => &q.body,
            _ => return None,
        },
        _ => return None,
    };
    let select = outer_select(body);

    // Registered column names (already lowercased at registration) — the ground
    // truth for what a bare identifier can honestly be called.
    let known: Vec<&str> = regs
        .iter()
        .flat_map(|r| r.columns.iter().map(String::as_str))
        .collect();

    let mut bullets: Vec<String> = Vec::new();

    // 1) Date column — the month-bucket idiom (SQL-certain) or a date-named
    //    GROUP BY key.
    let date = select.and_then(|s| date_column(s, &known));
    if let Some((col, by_month)) = &date {
        bullets.push(if *by_month {
            format!("Date column: `{col}` (grouped by month)")
        } else {
            format!("Date column: `{col}`")
        });
    }

    if let Some(s) = select {
        // 2) Grouped-by columns (excluding the date column, named above).
        let date_name = date.as_ref().map(|(c, _)| c.as_str());
        let groups = group_columns(s, date_name);
        if !groups.is_empty() {
            let cols = groups
                .iter()
                .map(|c| format!("`{c}`"))
                .collect::<Vec<_>>()
                .join(", ");
            bullets.push(format!("Grouped by: {cols}"));
        }
        // 3) Filters — the WHERE predicate rendered back to compact SQL via the
        //    AST's own Display (never our own paraphrase).
        if let Some(pred) = s.selection.as_ref() {
            let rendered = pred.to_string();
            let rendered = rendered.trim();
            if !rendered.is_empty() {
                bullets.push(format!("Filtered where: `{rendered}`"));
            }
        }
        // 4) Null handling implied by the aggregates actually present.
        if let Some(note) = null_handling(s) {
            bullets.push(note);
        }
    }

    // 5) Rows considered — only for a query that actually read a table (a bare
    //    `SELECT 1` reads none, so it derives nothing and yields no ledger).
    let reads_data = select.map(|s| !s.from.is_empty()).unwrap_or(true);
    if reads_data {
        if let Some(rf) = rows {
            bullets.push(rows_considered(rf));
        }
    }

    if bullets.is_empty() {
        return None;
    }
    let mut out = String::from("*Assumptions:*\n");
    for b in &bullets {
        out.push_str("- ");
        out.push_str(b);
        out.push('\n');
    }
    // The caller wraps this in `\n{ledger}\n`, so leave no trailing newline.
    Some(out.trim_end().to_string())
}

/// The outermost simple `SELECT`, unwrapping a parenthesized/subquery-wrapped
/// query. A UNION or VALUES body has no single Select to read — the caller then
/// derives only what the result affords (rows considered) and omits the rest.
fn outer_select(body: &SetExpr) -> Option<&Select> {
    match body {
        SetExpr::Select(s) => Some(&**s),
        SetExpr::Query(inner) => outer_select(&inner.body),
        _ => None,
    }
}

/// The date/period column the query pivots on, and whether it's the month
/// bucket. Priority: the `substr(<col>, 1, 7)` / `substr(CAST(<col> AS ...), 1,
/// 7)` month idiom (SQL-certain — in projection or GROUP BY), then a GROUP BY
/// key that is a registered, date/period-named column.
///
/// NOTE (deviation from the design's `ColumnKind::Date` match): `TableReg`
/// carries column NAMES but not their catalog `ColumnKind`, and threading typed
/// columns into the fixed `assumption_ledger(sql, regs, result)` signature is
/// out of §1's file scope. The month idiom needs no kind; the second path is
/// grounded (a REGISTERED column used as a grouping key, with a date/period
/// name) so it never fabricates a date claim for a plainly non-temporal column.
fn date_column(s: &Select, known: &[&str]) -> Option<(String, bool)> {
    let mut exprs: Vec<&Expr> = Vec::new();
    for item in &s.projection {
        if let Some(e) = select_item_expr(item) {
            exprs.push(e);
        }
    }
    if let GroupByExpr::Expressions(gs, _) = &s.group_by {
        exprs.extend(gs.iter());
    }
    for e in &exprs {
        if let Some(col) = month_bucket_column(e) {
            return Some((col, true));
        }
    }
    if let GroupByExpr::Expressions(gs, _) = &s.group_by {
        for e in gs {
            if let Some(col) = simple_column(e) {
                let lc = col.to_lowercase();
                if known.iter().any(|k| *k == lc) && is_date_name(&lc) {
                    return Some((lc, false));
                }
            }
        }
    }
    None
}

/// The simple (nameable) GROUP BY keys, lowercased and deduped, excluding the
/// date column (named by its own bullet) and any expression key (e.g. the month
/// bucket) that can't be named simply.
fn group_columns(s: &Select, date_col: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let GroupByExpr::Expressions(gs, _) = &s.group_by {
        for e in gs {
            if let Some(col) = simple_column(e) {
                let lc = col.to_lowercase();
                if Some(lc.as_str()) == date_col || out.contains(&lc) {
                    continue;
                }
                out.push(lc);
            }
        }
    }
    out
}

/// Null-handling honesty from the aggregates the projection actually uses.
/// SUM/AVG/MIN/MAX skip null cells; COUNT counts non-null values. Names only the
/// aggregates present, in a fixed order; `None` when there are none.
fn null_handling(s: &Select) -> Option<String> {
    let mut calls: Vec<&Function> = Vec::new();
    for item in &s.projection {
        if let Some(e) = select_item_expr(item) {
            collect_calls(e, &mut calls);
        }
    }
    let present: std::collections::HashSet<String> = calls.iter().map(|f| fn_name(f)).collect();
    let ordered: Vec<&str> = ["SUM", "AVG", "MIN", "MAX"]
        .into_iter()
        .filter(|a| present.contains(*a))
        .collect();
    let has_count = present.contains("COUNT");
    match (ordered.is_empty(), has_count) {
        (true, false) => None,
        (false, false) => Some(format!(
            "Aggregates ({}) skip null cells.",
            backtick_join(&ordered)
        )),
        (false, true) => Some(format!(
            "Aggregates ({}) skip null cells; `COUNT` counts non-null values.",
            backtick_join(&ordered)
        )),
        (true, true) => Some("`COUNT` counts non-null values.".to_string()),
    }
}

/// "Considered N rows" honesty, matching the truncation footer's comma style.
fn rows_considered(rf: RowFacts) -> String {
    match (rf.truncated, rf.total) {
        (true, Some(t)) => format!(
            "Considered `{}` rows (showing the first `{}`).",
            commafy(t),
            commafy(rf.shown)
        ),
        _ => format!("Considered `{}` rows.", commafy(rf.total.unwrap_or(rf.shown))),
    }
}

// --- AST helpers ------------------------------------------------------------------

fn select_item_expr(item: &SelectItem) -> Option<&Expr> {
    match item {
        SelectItem::UnnamedExpr(e) => Some(e),
        SelectItem::ExprWithAlias { expr, .. } => Some(expr),
        _ => None,
    }
}

fn simple_column(e: &Expr) -> Option<String> {
    match e {
        Expr::Identifier(id) => Some(id.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|i| i.value.clone()),
        _ => None,
    }
}

/// The column inside a `substr(<expr>, 1, 7)` month bucket, if `e` is (or
/// contains) that idiom. Requires the `1, 7` window so a `substr(name, 1, 3)`
/// prefix is never mistaken for a month. DataFusion's parser lowers
/// `substr(x, 1, 7)` to the dedicated `Expr::Substring` node (its `1`/`7` land
/// in `substring_from`/`substring_for`); a plain `SUBSTR(...)` function call is
/// handled too for robustness.
fn month_bucket_column(e: &Expr) -> Option<String> {
    match e {
        Expr::Substring {
            expr,
            substring_from,
            substring_for,
            ..
        } => {
            let from = substring_from.as_ref().map(|x| x.to_string());
            let for_ = substring_for.as_ref().map(|x| x.to_string());
            if from.as_deref() == Some("1") && for_.as_deref() == Some("7") {
                return leftmost_col(expr).map(|c| c.to_lowercase());
            }
            None
        }
        Expr::Function(f) => {
            let name = fn_name(f);
            let args = fn_arg_exprs(f);
            if (name == "SUBSTR" || name == "SUBSTRING")
                && args.len() == 3
                && args[1].to_string() == "1"
                && args[2].to_string() == "7"
            {
                return leftmost_col(args[0]).map(|c| c.to_lowercase());
            }
            args.into_iter().find_map(month_bucket_column)
        }
        Expr::Cast { expr, .. } | Expr::Nested(expr) | Expr::UnaryOp { expr, .. } => {
            month_bucket_column(expr)
        }
        Expr::BinaryOp { left, right, .. } => {
            month_bucket_column(left).or_else(|| month_bucket_column(right))
        }
        _ => None,
    }
}

/// The leftmost column an expression bottoms out on, unwrapping CAST / nesting /
/// a wrapping function's first argument. Used to name the column inside a month
/// bucket.
fn leftmost_col(e: &Expr) -> Option<String> {
    match e {
        Expr::Identifier(id) => Some(id.value.clone()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|i| i.value.clone()),
        Expr::Cast { expr, .. } | Expr::Nested(expr) => leftmost_col(expr),
        Expr::Function(f) => fn_arg_exprs(f).into_iter().next().and_then(leftmost_col),
        _ => None,
    }
}

/// Every function call reachable through the common analytics expression shapes
/// (a call, a binary/unary op, a nest, a cast, or a wrapping call's args).
/// Unhandled variants end the descent — the ledger under-reports rather than
/// guesses.
fn collect_calls<'a>(e: &'a Expr, out: &mut Vec<&'a Function>) {
    match e {
        Expr::Function(f) => {
            out.push(f);
            for a in fn_arg_exprs(f) {
                collect_calls(a, out);
            }
        }
        Expr::BinaryOp { left, right, .. } => {
            collect_calls(left, out);
            collect_calls(right, out);
        }
        Expr::UnaryOp { expr, .. } | Expr::Cast { expr, .. } | Expr::Nested(expr) => {
            collect_calls(expr, out)
        }
        _ => {}
    }
}

/// A function's bare name, uppercased (the last path segment of a possibly
/// qualified name).
fn fn_name(f: &Function) -> String {
    f.name
        .0
        .last()
        .and_then(|p| p.as_ident())
        .map(|i| i.value.to_uppercase())
        .unwrap_or_default()
}

/// The positional/named argument EXPRESSIONS of a call (wildcards like
/// `COUNT(*)` carry no expression and are skipped).
fn fn_arg_exprs(f: &Function) -> Vec<&Expr> {
    let mut v = Vec::new();
    if let FunctionArguments::List(list) = &f.args {
        for a in &list.args {
            let fae = match a {
                FunctionArg::Unnamed(fae) => Some(fae),
                FunctionArg::Named { arg, .. } => Some(arg),
                FunctionArg::ExprNamed { arg, .. } => Some(arg),
            };
            if let Some(FunctionArgExpr::Expr(e)) = fae {
                v.push(e);
            }
        }
    }
    v
}

fn backtick_join(names: &[&str]) -> String {
    names
        .iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A conservative "does this name read as a date/period dimension" test, used
/// only to name a REGISTERED GROUP BY key (see `date_column`). Deliberately
/// tight so ordinary dimensions (`region`, `amount`, `customer`) never match.
fn is_date_name(n: &str) -> bool {
    matches!(
        n,
        "date" | "month" | "day" | "year" | "week" | "quarter" | "period" | "timestamp"
            | "datetime"
    ) || n.ends_with("_date")
        || n.starts_with("date_")
        || n.ends_with("_month")
        || n.ends_with("_year")
        || n.ends_with("_day")
        || n.ends_with("_at")
}
