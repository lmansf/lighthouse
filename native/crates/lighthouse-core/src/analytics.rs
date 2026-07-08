//! Ask-your-data analytics (docs/analytics-genie.md, Phase A).
//!
//! The model writes SQL; DataFusion executes it; the model narrates the
//! verified result. The model never sees file contents here — only schemas and
//! a few sample rows — and never does arithmetic: every number in the answer
//! comes out of the engine. Everything is in-process (no network paths).
//!
//! Desktop-first by design: this module has no TS twin — the web dev server's
//! pipeline simply never takes the analytics branch.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use datafusion::arrow::array::{ArrayRef, Float64Array, StringArray};
use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::arrow::util::display::array_value_to_string;
use datafusion::datasource::MemTable;
use datafusion::prelude::{CsvReadOptions, ParquetReadOptions, SessionContext};

/// Budgets — conservative caps so one query can't stall or flood an answer.
pub const MAX_TABLE_FILES: usize = 4;
const MAX_SHEETS_PER_BOOK: usize = 4;
const MAX_XLSX_ROWS: usize = 100_000;
const MAX_XLSX_COLS: usize = 64;
const QUERY_TIMEOUT_SECS: u64 = 10;
const MAX_RESULT_ROWS: usize = 200;
const MAX_RESULT_COLS: usize = 24;
const MAX_CELL_CHARS: usize = 80;
const SAMPLE_ROWS: usize = 3;

// --- Intent ----------------------------------------------------------------------

const CUE_WORDS: &[&str] = &[
    "sum", "total", "totals", "average", "avg", "mean", "median", "count",
    "top", "largest", "smallest", "highest", "lowest", "max", "maximum",
    "min", "minimum", "trend", "trends", "breakdown", "distribution",
    "percent", "percentage", "share", "ratio", "rank", "ranking",
    "monthly", "yearly", "quarterly", "analyze", "analyse", "analysis",
];
const CUE_PHRASES: &[&str] = &["how many", "how much", "group by", "per "];

/// Whether a question reads as an aggregate/analytics ask. Pure; unit-tested.
/// (Deliberately conservative — everything else keeps its existing path.)
pub fn analytics_cue(question: &str) -> bool {
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
    for p in CUE_PHRASES {
        if padded.contains(&format!(" {p}")) {
            return true;
        }
    }
    padded
        .split(' ')
        .any(|t| CUE_WORDS.contains(&t))
}

/// File kinds the engine can register as tables.
pub fn is_tabular(name: &str) -> bool {
    let n = name.to_lowercase();
    [".csv", ".tsv", ".parquet", ".xlsx", ".xls"]
        .iter()
        .any(|e| n.ends_with(e))
}

/// Lowercased stem, non-alphanumerics folded to `_`, digit-safe, deduped by
/// the caller. "Q3 Sales (final).xlsx" → "q3_sales_final".
fn sanitize_table_name(file_name: &str) -> String {
    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(file_name)
        .to_lowercase();
    let mut out = String::with_capacity(stem.len());
    let mut last_us = true; // also trims leading underscores
    for ch in stem.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    let out = out.trim_end_matches('_').to_string();
    let out = if out.is_empty() { "table".to_string() } else { out };
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("t_{out}")
    } else {
        out
    }
}

// --- Registration ----------------------------------------------------------------

/// One registered table and the description the model plans against.
#[derive(Debug, Clone)]
pub struct TableReg {
    pub table: String,
    pub file_id: String,
    pub file_name: String,
    /// "col TYPE, col TYPE, …" + row count + sample rows, ready for a prompt block.
    pub card: String,
}

/// Register every supported file into one context (multi-file joins come free).
/// Unreadable/mis-shaped files are skipped — never fatal.
pub async fn register_tables(
    ctx: &SessionContext,
    files: &[(String, String, PathBuf)], // (file_id, name, abs)
) -> Vec<TableReg> {
    let mut regs: Vec<TableReg> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for (file_id, name, abs) in files.iter().take(MAX_TABLE_FILES) {
        let lower = name.to_lowercase();
        let mut base = sanitize_table_name(name);
        if used.contains(&base) {
            base = format!("{}_{}", base, used.len() + 1);
        }
        let path = abs.to_string_lossy().to_string();
        let registered: Vec<String> = if lower.ends_with(".csv") || lower.ends_with(".tsv") {
            let delim = if lower.ends_with(".tsv") { b'\t' } else { b',' };
            let opts = CsvReadOptions::new().delimiter(delim);
            match ctx.register_csv(&base, &path, opts).await {
                Ok(()) => vec![base.clone()],
                Err(_) => vec![],
            }
        } else if lower.ends_with(".parquet") {
            match ctx
                .register_parquet(&base, &path, ParquetReadOptions::default())
                .await
            {
                Ok(()) => vec![base.clone()],
                Err(_) => vec![],
            }
        } else {
            register_workbook(ctx, &base, abs)
        };
        for table in registered {
            if let Some(card) = table_card(ctx, &table).await {
                used.push(base.clone());
                regs.push(TableReg {
                    table: table.clone(),
                    file_id: file_id.clone(),
                    file_name: name.clone(),
                    card,
                });
            }
        }
    }
    regs
}

/// calamine → Arrow MemTable per sheet (row 0 = header; ≥80% numeric column →
/// Float64 with nulls, else Utf8). Returns the registered table names.
fn register_workbook(ctx: &SessionContext, base: &str, abs: &PathBuf) -> Vec<String> {
    use calamine::Reader;
    let Ok(mut wb) = calamine::open_workbook_auto(abs) else {
        return vec![];
    };
    let names: Vec<String> = wb.sheet_names().to_vec();
    let multi = names.len() > 1;
    let mut out = Vec::new();
    for sheet in names.into_iter().take(MAX_SHEETS_PER_BOOK) {
        let Ok(range) = wb.worksheet_range(&sheet) else {
            continue;
        };
        let mut rows = range.rows();
        let Some(header_row) = rows.next() else { continue };
        let headers: Vec<String> = header_row
            .iter()
            .take(MAX_XLSX_COLS)
            .enumerate()
            .map(|(i, c)| {
                let h = sanitize_table_name(&crate::extract::cell_text(c));
                if h.is_empty() || h == "table" { format!("col_{}", i + 1) } else { h }
            })
            .collect();
        if headers.len() < 2 {
            continue;
        }
        let data: Vec<Vec<String>> = rows
            .take(MAX_XLSX_ROWS)
            .map(|r| {
                (0..headers.len())
                    .map(|i| r.get(i).map(crate::extract::cell_text).unwrap_or_default())
                    .collect()
            })
            .collect();
        if data.len() < 2 {
            continue;
        }
        let mut fields: Vec<Field> = Vec::new();
        let mut cols: Vec<ArrayRef> = Vec::new();
        for (i, h) in headers.iter().enumerate() {
            let vals: Vec<&String> = data.iter().map(|r| &r[i]).collect();
            let non_empty = vals.iter().filter(|v| !v.trim().is_empty()).count();
            let numeric = vals
                .iter()
                .filter(|v| !v.trim().is_empty() && v.trim().parse::<f64>().is_ok())
                .count();
            if non_empty > 0 && numeric as f64 >= non_empty as f64 * 0.8 {
                fields.push(Field::new(h, DataType::Float64, true));
                cols.push(Arc::new(Float64Array::from(
                    vals.iter()
                        .map(|v| v.trim().parse::<f64>().ok())
                        .collect::<Vec<Option<f64>>>(),
                )));
            } else {
                fields.push(Field::new(h, DataType::Utf8, true));
                cols.push(Arc::new(StringArray::from(
                    vals.iter().map(|v| v.as_str()).collect::<Vec<&str>>(),
                )));
            }
        }
        let schema = Arc::new(Schema::new(fields));
        let Ok(batch) = RecordBatch::try_new(schema.clone(), cols) else {
            continue;
        };
        let Ok(mem) = MemTable::try_new(schema, vec![vec![batch]]) else {
            continue;
        };
        let tname = if multi {
            format!("{base}__{}", sanitize_table_name(&sheet))
        } else {
            base.to_string()
        };
        if ctx.register_table(&tname, Arc::new(mem)).is_ok() {
            out.push(tname);
        }
    }
    out
}

/// Schema + row count + sample rows for the planning prompt (never the data).
async fn table_card(ctx: &SessionContext, table: &str) -> Option<String> {
    let df = ctx.sql(&format!("SELECT * FROM {table} LIMIT {SAMPLE_ROWS}")).await.ok()?;
    let schema_line = df
        .schema()
        .fields()
        .iter()
        .map(|f| format!("{} {}", f.name(), f.data_type()))
        .collect::<Vec<_>>()
        .join(", ");
    let sample = df.collect().await.ok()?;
    let (sample_md, _, _) = batches_to_markdown(&sample, SAMPLE_ROWS, MAX_RESULT_COLS);
    let count = ctx
        .sql(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .await
        .ok()?
        .collect()
        .await
        .ok()?;
    let n = count
        .first()
        .and_then(|b| b.column(0).as_any().downcast_ref::<datafusion::arrow::array::Int64Array>())
        .map(|a| a.value(0))
        .unwrap_or(0);
    Some(format!(
        "table {table} — {n} rows\ncolumns: {schema_line}\nsample rows:\n{sample_md}"
    ))
}

// --- SQL guard -------------------------------------------------------------------

/// Pull the SQL out of a model reply: fenced ```sql block if present, else the
/// text from the first SELECT/WITH onward. Strips trailing semicolons.
pub fn extract_sql(raw: &str) -> Option<String> {
    let cleaned = raw.trim();
    let body = if let Some(start) = cleaned.find("```") {
        let after = &cleaned[start + 3..];
        let after = after.strip_prefix("sql").unwrap_or(after);
        match after.find("```") {
            Some(end) => &after[..end],
            None => after,
        }
    } else {
        cleaned
    };
    let upper = body.to_uppercase();
    let at = upper.find("SELECT").into_iter().chain(upper.find("WITH")).min()?;
    let sql = body[at..].trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() { None } else { Some(sql) }
}

/// Read-only by construction: exactly one statement, and it must parse as a
/// plain query (SELECT / WITH…SELECT). Everything else is rejected up front.
pub fn guard_sql(sql: &str) -> Result<(), String> {
    use datafusion::sql::parser::{DFParser, Statement as DFStatement};
    use datafusion::sql::sqlparser::ast::Statement as SqlStatement;
    let stmts = DFParser::parse_sql(sql).map_err(|e| format!("SQL parse error: {e}"))?;
    if stmts.len() != 1 {
        return Err("expected exactly one SQL statement".into());
    }
    match stmts.front() {
        Some(DFStatement::Statement(s)) => match **s {
            SqlStatement::Query(_) => Ok(()),
            _ => Err("only SELECT queries are allowed".into()),
        },
        _ => Err("only SELECT queries are allowed".into()),
    }
}

// --- Execution + rendering -------------------------------------------------------

/// Run a guarded query with a hard timeout and result caps; returns the result
/// as a Markdown table plus how many rows it shows.
pub async fn run_query(
    ctx: &SessionContext,
    sql: &str,
) -> Result<(String, usize, bool), String> {
    guard_sql(sql)?;
    let df = ctx.sql(sql).await.map_err(|e| e.to_string())?;
    // Post-plan cap: applied after ORDER BY/aggregation, so semantics hold.
    let df = df
        .limit(0, Some(MAX_RESULT_ROWS + 1))
        .map_err(|e| e.to_string())?;
    let batches = tokio::time::timeout(Duration::from_secs(QUERY_TIMEOUT_SECS), df.collect())
        .await
        .map_err(|_| format!("query exceeded {QUERY_TIMEOUT_SECS}s"))?
        .map_err(|e| e.to_string())?;
    let (md, shown, more) = batches_to_markdown(&batches, MAX_RESULT_ROWS, MAX_RESULT_COLS);
    if shown == 0 {
        return Err("the query returned no rows".into());
    }
    Ok((md, shown, more))
}

/// Render record batches as a compact Markdown table (rows/cols/cell caps).
pub fn batches_to_markdown(
    batches: &[RecordBatch],
    max_rows: usize,
    max_cols: usize,
) -> (String, usize, bool) {
    let Some(first) = batches.iter().find(|b| b.num_columns() > 0) else {
        return (String::new(), 0, false);
    };
    let schema = first.schema();
    let ncols = schema.fields().len().min(max_cols);
    let cell = |s: String| -> String {
        let s = s.replace('|', "\\|").replace('\n', " ");
        if s.chars().count() > MAX_CELL_CHARS {
            format!("{}…", s.chars().take(MAX_CELL_CHARS - 1).collect::<String>())
        } else {
            s
        }
    };
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "| {} |",
        schema.fields().iter().take(ncols).map(|f| cell(f.name().clone())).collect::<Vec<_>>().join(" | ")
    ));
    lines.push(format!("|{}|", " --- |".repeat(ncols)));
    let mut shown = 0;
    let mut more = false;
    'outer: for b in batches {
        for row in 0..b.num_rows() {
            if shown >= max_rows {
                more = true;
                break 'outer;
            }
            let mut cells = Vec::with_capacity(ncols);
            for c in 0..ncols {
                let v = array_value_to_string(b.column(c), row).unwrap_or_default();
                cells.push(cell(v));
            }
            lines.push(format!("| {} |", cells.join(" | ")));
            shown += 1;
        }
    }
    (lines.join("\n"), shown, more)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_detects_aggregate_asks() {
        assert!(analytics_cue("What were total sales per region in 2017?"));
        assert!(analytics_cue("give me an analysis of the invoices"));
        assert!(analytics_cue("how many orders came from NE?"));
        assert!(analytics_cue("top 5 customers by revenue"));
        assert!(!analytics_cue("what does the onboarding doc say about SSO?"));
        assert!(!analytics_cue("when is the invoice due?"));
    }

    #[test]
    fn table_names_sanitize() {
        assert_eq!(sanitize_table_name("Q3 Sales (final).xlsx"), "q3_sales_final");
        assert_eq!(sanitize_table_name("2017.csv"), "t_2017");
        assert_eq!(sanitize_table_name("__.csv"), "table");
    }

    #[test]
    fn sql_extraction_handles_fences_and_prose() {
        assert_eq!(
            extract_sql("Here you go:\n```sql\nSELECT a FROM t;\n```").as_deref(),
            Some("SELECT a FROM t")
        );
        assert_eq!(
            extract_sql("SELECT x FROM y WHERE z > 1").as_deref(),
            Some("SELECT x FROM y WHERE z > 1")
        );
        assert_eq!(
            extract_sql("with c as (select 1) select * from c").as_deref(),
            Some("with c as (select 1) select * from c")
        );
        assert_eq!(extract_sql("no query here"), None);
    }

    #[test]
    fn guard_rejects_writes_and_multi_statements() {
        assert!(guard_sql("SELECT 1").is_ok());
        assert!(guard_sql("WITH c AS (SELECT 1 AS a) SELECT a FROM c").is_ok());
        assert!(guard_sql("DROP TABLE t").is_err());
        assert!(guard_sql("UPDATE t SET a = 1").is_err());
        assert!(guard_sql("INSERT INTO t VALUES (1)").is_err());
        assert!(guard_sql("SELECT 1; SELECT 2").is_err());
        assert!(guard_sql("CREATE TABLE x AS SELECT 1").is_err());
    }

    #[tokio::test]
    async fn end_to_end_csv_query_and_join_with_parquet() {
        // Fixture CSV on disk (std temp is fine for a unit test).
        let dir = std::env::temp_dir().join(format!("lh-analytics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv = dir.join("sales.csv");
        std::fs::write(
            &csv,
            "region,amount\nNE,100.5\nNW,200\nNE,49.5\nSE,300\n",
        )
        .unwrap();
        let regions = dir.join("regions.csv");
        std::fs::write(&regions, "region,label\nNE,Northeast\nNW,Northwest\nSE,Southeast\n").unwrap();

        let ctx = SessionContext::new();
        let files = vec![
            ("f1".to_string(), "sales.csv".to_string(), csv.clone()),
            ("f2".to_string(), "regions.csv".to_string(), regions.clone()),
        ];
        let regs = register_tables(&ctx, &files).await;
        assert_eq!(regs.len(), 2);
        assert!(regs[0].card.contains("rows"));

        // Write one of them back out as parquet, register, and JOIN across formats.
        let pq = dir.join("sales.parquet");
        ctx.sql("SELECT * FROM sales")
            .await
            .unwrap()
            .write_parquet(
                pq.to_str().unwrap(),
                datafusion::dataframe::DataFrameWriteOptions::new(),
                None,
            )
            .await
            .unwrap();
        ctx.register_parquet("sales_pq", pq.to_str().unwrap(), ParquetReadOptions::default())
            .await
            .unwrap();

        let (md, shown, more) = run_query(
            &ctx,
            "SELECT r.label, SUM(s.amount) AS total FROM sales_pq s JOIN regions r ON s.region = r.region GROUP BY r.label ORDER BY total DESC",
        )
        .await
        .unwrap();
        assert_eq!(shown, 3);
        assert!(!more);
        assert!(md.contains("Southeast") && md.contains("300"), "{md}");
        assert!(md.contains("Northeast") && md.contains("150"), "{md}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The SQL-writing ask handed to the model (schemas ride as context blocks).
/// The reply is post-processed by extract_sql + the guard, so stray prose or
/// citation markers from the grounded system prompt are tolerated.
pub fn sql_question(question: &str) -> String {
    format!(
        "You are writing ONE SQL query for DataFusion (PostgreSQL-style syntax). \
         The numbered context blocks describe the available tables: their exact \
         table names, columns with types, row counts, and a few sample rows. \
         Write a single SELECT statement that answers the question below from \
         those tables (JOINs across tables are fine). Reply with ONLY the SQL \
         in a ```sql code block — no explanation. Use the exact table and \
         column names as given.\n\nQuestion: {question}"
    )
}
