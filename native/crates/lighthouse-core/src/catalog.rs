//! Cheap, cached column inventory for tabular vault files.
//!
//! Reads only the header plus a bounded row sample per file and remembers the
//! result keyed by mtime+size (the extraction cache's freshness idiom), so
//! union grouping, join hints, suggested asks, and column questions never
//! re-read data that hasn't changed. Failures omit the file — a catalog miss
//! must never block an answer.
//!
//! Desktop-first like analytics: this module has no TS twin (PARITY — the
//! dev server's features that would consume it degrade gracefully).

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::state_dir;

/// Data rows sampled per file to vote a column's kind.
const SAMPLE_ROWS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Numeric,
    Date,
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    /// Sanitized like table names, so it matches what registration produces.
    pub name: String,
    pub kind: ColumnKind,
}

#[derive(Debug, Clone)]
pub struct FileColumns {
    pub id: String,
    pub name: String,
    pub columns: Vec<Column>,
    pub modified_ms: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    entries: HashMap<String, CacheEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    key: String,
    columns: Vec<Column>,
}

fn cache_path() -> PathBuf {
    state_dir().join("cache").join("columns.json")
}

/// Column inventory for the given (file_id, name, abs) set, cache-first.
/// Unreadable/malformed files are omitted; order follows the input.
pub fn columns_for(files: &[(String, String, PathBuf)]) -> Vec<FileColumns> {
    // The catalog USES the state dir but never creates it: a caller without
    // one (unit tests, one-off contexts) gets a correct in-memory answer and
    // leaves no droppings behind.
    let persist = state_dir().exists();
    let mut cache: CacheFile = std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut dirty = false;
    let mut out = Vec::new();
    for (id, name, abs) in files {
        let Ok(md) = std::fs::metadata(abs) else { continue };
        let modified_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let key = format!("{modified_ms}:{}", md.len());
        let path_key = abs.to_string_lossy().to_string();
        let columns = match cache.entries.get(&path_key) {
            Some(e) if e.key == key => e.columns.clone(),
            _ => match read_columns(name, abs) {
                Some(cols) if !cols.is_empty() => {
                    cache
                        .entries
                        .insert(path_key, CacheEntry { key, columns: cols.clone() });
                    dirty = true;
                    cols
                }
                _ => continue,
            },
        };
        out.push(FileColumns {
            id: id.clone(),
            name: name.clone(),
            columns,
            modified_ms,
        });
    }
    if dirty && persist {
        if let Some(dir) = cache_path().parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Best effort — a lost write just means re-reading headers next time.
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = std::fs::write(cache_path(), json);
        }
    }
    out
}

fn read_columns(name: &str, abs: &Path) -> Option<Vec<Column>> {
    let lower = name.to_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") {
        read_delimited(abs, if lower.ends_with(".tsv") { '\t' } else { ',' })
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xls") {
        read_workbook(abs)
    } else if lower.ends_with(".parquet") {
        read_parquet_footer(abs)
    } else {
        None
    }
}

fn read_delimited(abs: &Path, delim: char) -> Option<Vec<Column>> {
    let file = std::fs::File::open(abs).ok()?;
    let mut lines = std::io::BufReader::new(file).lines();
    let header = lines.next()?.ok()?;
    let names: Vec<String> = split_delimited(&header, delim);
    if names.len() < 2 {
        return None;
    }
    let mut samples: Vec<Vec<String>> = Vec::new();
    for line in lines.take(SAMPLE_ROWS) {
        let Ok(line) = line else { break };
        samples.push(split_delimited(&line, delim));
    }
    Some(build_columns(&names, &samples))
}

fn read_workbook(abs: &Path) -> Option<Vec<Column>> {
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto(abs).ok()?;
    let sheet = wb.sheet_names().first()?.clone();
    let range = wb.worksheet_range(&sheet).ok()?;
    let rows: Vec<Vec<String>> = range
        .rows()
        .take(SAMPLE_ROWS + 9)
        .map(|r| r.iter().map(crate::extract::cell_text).collect())
        .collect();
    if rows.is_empty() {
        return None;
    }
    let h = crate::analytics::detect_header_row(&rows);
    let names = rows[h].clone();
    if names.iter().filter(|s| !s.trim().is_empty()).count() < 2 {
        return None;
    }
    Some(build_columns(&names, &rows[h + 1..]))
}

/// Parquet stores its schema in the footer — no data pages are read.
fn read_parquet_footer(abs: &Path) -> Option<Vec<Column>> {
    use datafusion::parquet::file::reader::FileReader;
    let file = std::fs::File::open(abs).ok()?;
    let reader = datafusion::parquet::file::reader::SerializedFileReader::new(file).ok()?;
    let schema = reader.metadata().file_metadata().schema_descr_ptr();
    let cols = schema
        .columns()
        .iter()
        .enumerate()
        .map(|(i, c)| {
            use datafusion::parquet::basic::Type as PhysType;
            let kind = match c.physical_type() {
                PhysType::INT32 | PhysType::INT64 | PhysType::FLOAT | PhysType::DOUBLE => {
                    ColumnKind::Numeric
                }
                _ => ColumnKind::Text,
            };
            Column { name: sanitize_column(c.name(), i), kind }
        })
        .collect::<Vec<_>>();
    (cols.len() >= 2).then_some(cols)
}

/// Minimal RFC-4180-aware splitter — enough for a header + kind sampling.
fn split_delimited(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == delim {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(ch);
        }
    }
    out.push(cur);
    out
}

/// Same rules registration applies, so catalog names line up with SQL names.
fn sanitize_column(raw: &str, index: usize) -> String {
    let s = crate::analytics::sanitize_table_name(raw);
    if s.is_empty() || s == "table" {
        format!("col_{}", index + 1)
    } else {
        s
    }
}

fn build_columns(names: &[String], samples: &[Vec<String>]) -> Vec<Column> {
    names
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let name = sanitize_column(raw, i);
            let vals: Vec<&str> = samples
                .iter()
                .filter_map(|r| r.get(i).map(|s| s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
            let kind = if vals.is_empty() {
                ColumnKind::Text
            } else {
                let numeric = vals.iter().filter(|v| v.parse::<f64>().is_ok()).count();
                let dateish = vals.iter().filter(|v| looks_iso_date(v)).count();
                if numeric * 10 >= vals.len() * 8 {
                    ColumnKind::Numeric
                } else if dateish * 10 >= vals.len() * 8 {
                    ColumnKind::Date
                } else {
                    ColumnKind::Text
                }
            };
            Column { name, kind }
        })
        .collect()
}

/// "YYYY-MM-DD…" prefix — what ISO-rendered Excel dates and sane CSV exports
/// carry; enough to steer "monthly trend" suggestions at date columns.
fn looks_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[7] == b'-'
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitter_handles_quotes() {
        assert_eq!(split_delimited("a,b,c", ','), vec!["a", "b", "c"]);
        assert_eq!(
            split_delimited(r#""a,x",b,"c""d""#, ','),
            vec!["a,x", "b", "c\"d"]
        );
        assert_eq!(split_delimited("a\tb", '\t'), vec!["a", "b"]);
    }

    #[test]
    fn kinds_vote_from_samples() {
        let names = vec!["date".into(), "region".into(), "amount".into()];
        let samples: Vec<Vec<String>> = (0..10)
            .map(|i| vec![format!("2025-01-{:02}", i + 1), "NE".into(), format!("{i}.5")])
            .collect();
        let cols = build_columns(&names, &samples);
        assert_eq!(cols[0].kind, ColumnKind::Date);
        assert_eq!(cols[1].kind, ColumnKind::Text);
        assert_eq!(cols[2].kind, ColumnKind::Numeric);
    }

    #[test]
    fn iso_date_prefix_detection() {
        assert!(looks_iso_date("2025-07-01"));
        assert!(looks_iso_date("2025-07-01 12:00:00"));
        assert!(!looks_iso_date("07/01/2025"));
        assert!(!looks_iso_date("2025-7-1"));
        assert!(!looks_iso_date("NE"));
    }
}
