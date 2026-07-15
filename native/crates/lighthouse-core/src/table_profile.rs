//! Deterministic table profiles for delimiter files (.csv / .tsv) — the Rust
//! twin of src/server/tableProfile.ts. The model must never do arithmetic: the
//! engine computes exact statistics and injects them as a context block. For
//! the same input both engines MUST produce byte-identical output; the parity
//! fixture in the unit test below is the same one test/tableProfile.test.mjs
//! pins on the TS side.

const MAX_PROFILE_CHARS: usize = 1200;
const MAX_GROUP_KEYS: usize = 8;
const MAX_YEARS: usize = 6;
const MAX_GROUP_COLS: usize = 2;
const MAX_ROWS: usize = 50_000;

/// Minimal CSV/TSV parser: quoted fields, escaped quotes, CR/LF rows.
pub fn parse_delimited(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == delim {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' {
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
            if rows.len() > MAX_ROWS {
                return rows;
            }
        } else if ch != '\r' {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `^[+-]?(\d+\.?\d*|\.\d+)$` without a regex dependency.
fn valid_num(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i > start {
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        }
        i == b.len()
    } else if i < b.len() && b[i] == b'.' {
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i > fs && i == b.len()
    } else {
        false
    }
}

/// Parse a number, tolerating currency symbols, thousands separators, and (n).
fn num_of(raw: &str) -> Option<f64> {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return None;
    }
    let mut neg = false;
    if s.len() >= 2 && s.starts_with('(') && s.ends_with(')') {
        neg = true;
        s = s[1..s.len() - 1].to_string();
    }
    let mut s: String = s
        .chars()
        .filter(|c| !matches!(c, '$' | '€' | '£' | '¥' | ','))
        .collect();
    if s.ends_with('%') {
        s.pop();
    }
    let s = s.trim();
    if s.is_empty() || !valid_num(s) {
        return None;
    }
    // Rust's parser rejects a bare trailing dot ("1.") that the JS regex allows.
    let normalized = s.strip_suffix('.').unwrap_or(s);
    let n: f64 = normalized.parse().ok()?;
    if n.is_finite() {
        Some(if neg { -n } else { n })
    } else {
        None
    }
}

/// Extract a 4-digit year from ISO (yyyy-mm-dd) or slashed (m/d/yyyy) dates.
fn year_of(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let b = s.as_bytes();
    // ISO prefix: ^(\d{4})-\d{1,2}-\d{1,2}
    if b.len() >= 8 && b[..4].iter().all(|c| c.is_ascii_digit()) && b[4] == b'-' {
        let rest = &b[5..];
        if let Some(dash) = rest.iter().position(|&c| c == b'-') {
            if (1..=2).contains(&dash)
                && rest[..dash].iter().all(|c| c.is_ascii_digit())
                && rest.get(dash + 1).is_some_and(|c| c.is_ascii_digit())
            {
                return s[..4].parse().ok();
            }
        }
    }
    // Fully anchored: ^\d{1,2}[/.]\d{1,2}[/.](\d{4})$
    let parts: Vec<&str> = s.split(['/', '.']).collect();
    if parts.len() == 3
        && (1..=2).contains(&parts[0].len())
        && parts[0].bytes().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[1].len())
        && parts[1].bytes().all(|c| c.is_ascii_digit())
        && parts[2].len() == 4
        && parts[2].bytes().all(|c| c.is_ascii_digit())
    {
        return parts[2].parse().ok();
    }
    None
}

/// Format with up to 2 decimals, trailing zeros trimmed — matches JS
/// `String(Math.round(n*100)/100)` (both sides print shortest round-trip).
pub fn fmt_num(n: f64) -> String {
    let r = (n * 100.0).round() / 100.0;
    if r == r.trunc() && r.abs() < 9e15 {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Kind {
    Number,
    Date,
    Text,
}

/// Build the profile text for a delimiter file, or None when the content does
/// not look like a table. Byte-identical to the TS tableProfile().
pub fn table_profile(name: &str, text: &str) -> Option<String> {
    let delim = if name.to_lowercase().ends_with(".tsv") { '\t' } else { ',' };
    let rows: Vec<Vec<String>> = parse_delimited(text, delim)
        .into_iter()
        .filter(|r| !(r.len() == 1 && r[0].trim().is_empty()))
        .collect();
    if rows.len() < 3 {
        return None;
    }
    let header: Vec<String> = rows[0].iter().map(|h| h.trim().to_string()).collect();
    if header.len() < 2 || header.iter().any(|h| h.is_empty()) {
        return None;
    }
    let data: Vec<&Vec<String>> = rows[1..]
        .iter()
        .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
        .collect();
    if data.len() < 2 {
        return None;
    }

    // Column-major with type inference (≥80% of non-empty values).
    struct Col {
        name: String,
        kind: Kind,
        values: Vec<String>,
    }
    let cols: Vec<Col> = header
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let values: Vec<String> = data
                .iter()
                .map(|r| r.get(i).map(|c| c.trim().to_string()).unwrap_or_default())
                .collect();
            let non_empty: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
            let nums = non_empty.iter().filter(|v| num_of(v).is_some()).count();
            let dates = non_empty.iter().filter(|v| year_of(v).is_some()).count();
            let kind = if !non_empty.is_empty() && dates as f64 >= non_empty.len() as f64 * 0.8 {
                Kind::Date
            } else if !non_empty.is_empty() && nums as f64 >= non_empty.len() as f64 * 0.8 {
                Kind::Number
            } else {
                Kind::Text
            };
            Col { name: h.clone(), kind, values }
        })
        .collect();

    let num_cols: Vec<&Col> = cols.iter().filter(|c| c.kind == Kind::Number).collect();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "[TABLE PROFILE — computed exactly by Lighthouse from {name}; these statistics are authoritative]"
    ));
    lines.push(format!("rows: {} (excluding header)", data.len()));

    let col_descs: Vec<String> = cols
        .iter()
        .map(|c| match c.kind {
            Kind::Number => {
                let ns: Vec<f64> = c.values.iter().filter_map(|v| num_of(v)).collect();
                let sum: f64 = ns.iter().sum();
                let mean = if ns.is_empty() { 0.0 } else { sum / ns.len() as f64 };
                let min = ns.iter().copied().fold(f64::INFINITY, f64::min);
                let max = ns.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let (min, max) = if ns.is_empty() { (0.0, 0.0) } else { (min, max) };
                format!(
                    "{} (number: sum {}, mean {}, min {}, max {})",
                    c.name,
                    fmt_num(sum),
                    fmt_num(mean),
                    fmt_num(min),
                    fmt_num(max)
                )
            }
            Kind::Date => {
                let ys: Vec<i64> = c.values.iter().filter_map(|v| year_of(v)).collect();
                let min = ys.iter().min().copied().unwrap_or(0);
                let max = ys.iter().max().copied().unwrap_or(0);
                format!("{} (date: years {min}–{max})", c.name)
            }
            Kind::Text => {
                let distinct: std::collections::HashSet<&String> =
                    c.values.iter().filter(|v| !v.is_empty()).collect();
                format!("{} (text: {} distinct)", c.name, distinct.len())
            }
        })
        .collect();
    lines.push(format!("columns: {}", col_descs.join("; ")));

    // Per-year rollups: every date column × the first numeric columns.
    for dc in cols.iter().filter(|c| c.kind == Kind::Date) {
        for nc in num_cols.iter().take(MAX_GROUP_COLS) {
            let mut by_year: Vec<(i64, f64)> = Vec::new();
            for i in 0..dc.values.len() {
                let (Some(y), Some(n)) = (
                    year_of(&dc.values[i]),
                    nc.values.get(i).and_then(|v| num_of(v)),
                ) else {
                    continue;
                };
                match by_year.iter_mut().find(|(yy, _)| *yy == y) {
                    Some((_, s)) => *s += n,
                    None => by_year.push((y, n)),
                }
            }
            if by_year.len() < 2 || by_year.len() > MAX_YEARS {
                continue;
            }
            by_year.sort_by_key(|(y, _)| *y);
            let parts: Vec<String> =
                by_year.iter().map(|(y, s)| format!("{y}: {}", fmt_num(*s))).collect();
            lines.push(format!(
                "sum of {} by year({}): {}",
                nc.name,
                dc.name,
                parts.join(" · ")
            ));
        }
    }

    // Group-by sums: low-cardinality text columns × the first numeric columns.
    for tc in cols.iter().filter(|c| c.kind == Kind::Text) {
        let distinct: std::collections::HashSet<&String> =
            tc.values.iter().filter(|v| !v.is_empty()).collect();
        if distinct.len() < 2 || distinct.len() > MAX_GROUP_KEYS {
            continue;
        }
        for nc in num_cols.iter().take(MAX_GROUP_COLS) {
            // Insertion-ordered accumulation, sorted by key at the end — the
            // same observable order as the TS Map + sort.
            let mut by_key: Vec<(String, f64)> = Vec::new();
            for i in 0..tc.values.len() {
                let k = &tc.values[i];
                let Some(n) = nc.values.get(i).and_then(|v| num_of(v)) else {
                    continue;
                };
                if k.is_empty() {
                    continue;
                }
                match by_key.iter_mut().find(|(kk, _)| kk == k) {
                    Some((_, s)) => *s += n,
                    None => by_key.push((k.clone(), n)),
                }
            }
            if by_key.len() < 2 {
                continue;
            }
            by_key.sort_by(|a, b| a.0.cmp(&b.0));
            let parts: Vec<String> =
                by_key.iter().map(|(k, s)| format!("{k}: {}", fmt_num(*s))).collect();
            lines.push(format!("sum of {} by {}: {}", nc.name, tc.name, parts.join(" · ")));
        }
    }

    let out = lines.join("\n");
    if out.chars().count() > MAX_PROFILE_CHARS {
        let cut: String = out.chars().take(MAX_PROFILE_CHARS - 1).collect();
        Some(format!("{cut}…"))
    } else {
        Some(out)
    }
}

/// Whether a file name is profileable (delimiter files only in Phase 1).
pub fn is_profileable(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".csv") || n.ends_with(".tsv")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE PARITY FIXTURE — byte-identical to test/tableProfile.test.mjs.
    /// If the profile format changes, update both expected strings together.
    #[test]
    fn parity_fixture_sales_csv() {
        let csv = [
            "Date,Region,Sales",
            "2016-01-05,NE,100.50",
            "2016-03-10,NW,200",
            "2016-11-20,NE,49.50",
            "2017-02-14,SE,300",
            "2017-06-30,NE,150.25",
            "2017-09-01,NW,174.75",
        ]
        .join("\n");
        let expected = [
            "[TABLE PROFILE — computed exactly by Lighthouse from sales.csv; these statistics are authoritative]",
            "rows: 6 (excluding header)",
            "columns: Date (date: years 2016–2017); Region (text: 3 distinct); Sales (number: sum 975, mean 162.5, min 49.5, max 300)",
            "sum of Sales by year(Date): 2016: 350 · 2017: 625",
            "sum of Sales by Region: NE: 300.25 · NW: 374.75 · SE: 300",
        ]
        .join("\n");
        assert_eq!(table_profile("sales.csv", &csv), Some(expected));
    }

    #[test]
    fn quoted_fields_and_negatives() {
        let csv = "Item,Amount\na,\"$1,200.50\"\nb,(300)\nc,€99";
        let p = table_profile("m.csv", csv).unwrap();
        assert!(p.contains("sum 999.5, mean 333.17, min -300, max 1200.5"), "{p}");
    }

    #[test]
    fn non_tables_return_none() {
        assert_eq!(table_profile("notes.csv", "just some prose\nwithout structure"), None);
        assert_eq!(table_profile("one.csv", "header\n1\n2\n3"), None);
        assert_eq!(table_profile("tiny.csv", "a,b\n1,2"), None);
    }

    #[test]
    fn tsv_by_extension() {
        let p = table_profile("data.tsv", "Name\tQty\nx\t1\ny\t2\nz\t3").unwrap();
        assert!(p.contains("rows: 3"));
        assert!(p.contains("Qty (number: sum 6, mean 2, min 1, max 3)"));
    }

    #[test]
    fn high_cardinality_text_not_grouped() {
        let mut rows = vec!["Id,Val".to_string()];
        for i in 0..20 {
            rows.push(format!("id-{i},1"));
        }
        let p = table_profile("ids.csv", &rows.join("\n")).unwrap();
        assert!(!p.contains("by Id"));
    }

    #[test]
    fn fmt_num_rounds_negatives_symmetrically() {
        // Round half AWAY FROM ZERO — the TS twin now matches this (it used
        // Math.round, which rounds half toward +∞ and diverged on negatives).
        // Only exactly-representable halves (k/8) give a deterministic .5 here;
        // -0.015 etc. aren't exact in f64, so the divergence hides on them.
        assert_eq!(fmt_num(-0.125), "-0.13"); // Math.round would give -0.12
        assert_eq!(fmt_num(-0.375), "-0.38"); // Math.round would give -0.37
        assert_eq!(fmt_num(0.125), "0.13");
        assert_eq!(fmt_num(-300.0), "-300");
    }
}
