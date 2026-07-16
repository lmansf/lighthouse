//! Assumption ledger (openspec: add-recipes §1) — the engine-derived
//! "Assumptions" disclosure is built ENTIRELY from the executed SQL + the
//! result's row facts, is byte-deterministic, and never fabricates when the SQL
//! reads no table or doesn't parse.

use lighthouse_core::analytics::{QueryResult, TableReg};
use lighthouse_core::ledger::assumption_ledger;

/// A `QueryResult` carrying only the row facts the ledger reads (batches/digest
/// are irrelevant to the ledger, so they stay empty).
fn qr(shown: usize, truncated: bool, total: Option<usize>) -> QueryResult {
    QueryResult {
        markdown: String::new(),
        shown,
        truncated,
        total,
        chart: None,
        digest: String::new(),
        batches: vec![],
    }
}

/// A minimal registered table — same field shape the analytics tests use.
fn reg(table: &str, cols: &[&str]) -> TableReg {
    TableReg {
        table: table.into(),
        file_id: format!("{table}-id"),
        file_name: format!("{table}.csv"),
        card: String::new(),
        modified_ms: None,
        columns: cols.iter().map(|s| s.to_string()).collect(),
        group: None,
        capped_rows: None,
    }
}

#[test]
fn group_by_where_sum_yields_every_bullet_byte_stable() {
    let regs = [reg("sales", &["region", "amount"])];
    let sql = "SELECT region, SUM(amount) FROM sales WHERE region <> 'n/a' GROUP BY region";
    let res = qr(3, false, Some(3));

    let ledger = assumption_ledger(sql, &regs, &res).expect("ledger for a real analytics query");
    assert_eq!(
        ledger,
        "*Assumptions:*\n\
         - Grouped by: `region`\n\
         - Filtered where: `region <> 'n/a'`\n\
         - Aggregates (`SUM`) skip null cells.\n\
         - Considered `3` rows.",
        "the ledger reads the SQL exactly, in the fixed bullet order"
    );

    // Deterministic: the same sql + regs + result is byte-identical every time.
    let again = assumption_ledger(sql, &regs, &res).unwrap();
    assert_eq!(ledger, again, "ledger must be byte-stable");
}

#[test]
fn bare_projection_derives_rows_only() {
    let regs = [reg("sales", &["region", "amount"])];
    let res = qr(42, false, Some(42));
    let ledger = assumption_ledger("SELECT amount FROM sales", &regs, &res).unwrap();
    assert_eq!(ledger, "*Assumptions:*\n- Considered `42` rows.");
}

#[test]
fn select_literal_and_unparseable_derive_nothing() {
    let regs = [reg("sales", &["region", "amount"])];
    let res = qr(1, false, Some(1));
    // A bare `SELECT 1` reads no table — nothing to assume.
    assert!(assumption_ledger("SELECT 1", &regs, &res).is_none());
    // Unparseable SQL yields no ledger rather than a guess.
    assert!(assumption_ledger("not a query at all", &regs, &res).is_none());
}

#[test]
fn month_bucket_idiom_names_the_date_column() {
    let regs = [reg("sales", &["order_date", "amount"])];
    let sql = "SELECT substr(CAST(order_date AS VARCHAR), 1, 7) AS ym, SUM(amount) AS total \
               FROM sales GROUP BY substr(CAST(order_date AS VARCHAR), 1, 7)";
    let res = qr(12, false, Some(12));
    let ledger = assumption_ledger(sql, &regs, &res).unwrap();
    assert_eq!(
        ledger,
        "*Assumptions:*\n\
         - Date column: `order_date` (grouped by month)\n\
         - Aggregates (`SUM`) skip null cells.\n\
         - Considered `12` rows.",
        "the substr(…,1,7) idiom names its inner column and marks month grouping; \
         the substr GROUP BY key is an expression, so it is not re-listed"
    );
}

#[test]
fn truncated_result_states_first_n_of_m() {
    let regs = [reg("sales", &["region", "amount"])];
    let sql = "SELECT region, SUM(amount) FROM sales GROUP BY region";
    let res = qr(200, true, Some(12_431));
    let ledger = assumption_ledger(sql, &regs, &res).unwrap();
    assert!(
        ledger.contains("Considered `12,431` rows (showing the first `200`)."),
        "truncated results state the true total honestly: {ledger}"
    );
}

#[test]
fn count_only_names_count_null_semantics() {
    let regs = [reg("sales", &["region"])];
    let sql = "SELECT region, COUNT(*) FROM sales GROUP BY region";
    let res = qr(4, false, Some(4));
    let ledger = assumption_ledger(sql, &regs, &res).unwrap();
    assert!(
        ledger.contains("- `COUNT` counts non-null values."),
        "COUNT gets its own null-handling clause: {ledger}"
    );
    assert!(
        !ledger.contains("skip null cells"),
        "no SUM/AVG/MIN/MAX present, so nothing 'skips null cells': {ledger}"
    );
}

#[test]
fn date_named_group_key_is_named_without_month() {
    // A registered, date-named GROUP BY key is recognized as the date column
    // even without the month idiom — and is not duplicated under "Grouped by".
    let regs = [reg("events", &["event_date", "channel", "clicks"])];
    let sql = "SELECT event_date, channel, SUM(clicks) FROM events GROUP BY event_date, channel";
    let res = qr(9, false, Some(9));
    let ledger = assumption_ledger(sql, &regs, &res).unwrap();
    assert_eq!(
        ledger,
        "*Assumptions:*\n\
         - Date column: `event_date`\n\
         - Grouped by: `channel`\n\
         - Aggregates (`SUM`) skip null cells.\n\
         - Considered `9` rows."
    );
}
