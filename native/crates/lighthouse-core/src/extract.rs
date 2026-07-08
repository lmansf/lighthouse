//! Text extraction for "rich" document formats — PDF, Word, Excel (port of
//! `src/server/extract.ts`).
//!
//! Native parsers replace the JS ones (pdf-extract ⇄ unpdf, zip+quick-xml ⇄
//! mammoth, calamine ⇄ SheetJS). Results are cached on disk keyed by the file's
//! mtime+size; a failed parse is logged and NOT cached so a transient error is
//! retried on the next scan rather than pinned to empty.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::config::state_dir;

/// Document formats we recover text from beyond plain UTF-8 files.
const RICH_EXT: &[&str] = &[".pdf", ".docx", ".xlsx", ".xls", ".parquet"];

pub fn is_rich_file(name: &str) -> bool {
    let ext = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!(".{}", ext.to_lowercase()),
        _ => return false,
    };
    RICH_EXT.contains(&ext.as_str())
}

/// Cap extracted text so one huge document can't dominate memory or the index.
const MAX_EXTRACT_BYTES: usize = 1_000_000;
/// Refuse to parse a source file larger than this (a *referenced* file can be
/// arbitrarily large).
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

/// Byte-cap (not char-cap) so multi-byte text can't slip past the budget.
fn clamp(text: &str) -> String {
    if text.len() <= MAX_EXTRACT_BYTES {
        return text.to_string();
    }
    String::from_utf8_lossy(&text.as_bytes()[..MAX_EXTRACT_BYTES]).into_owned()
}

fn extract_pdf(buf: &[u8]) -> anyhow::Result<String> {
    // pdf-extract can panic on malformed inputs; degrade that to an error so one
    // unreadable file never breaks a vault scan.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(buf)
    }));
    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(anyhow::anyhow!(e.to_string())),
        Err(_) => Err(anyhow::anyhow!("pdf parser panicked")),
    }
}

/// DOCX is a zip of XML: collect the text runs (`w:t`) of `word/document.xml`,
/// paragraphs joined with a blank line (the shape mammoth's extractRawText gives).
fn extract_docx(buf: &[u8]) -> anyhow::Result<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")?
        .read_to_string(&mut xml)?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"t" {
                    in_text = true;
                } else if local.as_ref() == b"tab" {
                    current.push('\t');
                }
            }
            Ok(quick_xml::events::Event::End(e)) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"t" {
                    in_text = false;
                } else if local.as_ref() == b"p" {
                    paragraphs.push(std::mem::take(&mut current));
                }
            }
            Ok(quick_xml::events::Event::Text(t)) => {
                if in_text {
                    current.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("docx xml: {e}")),
            _ => {}
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    Ok(paragraphs.join("\n\n"))
}

/// Render a Parquet file's schema + head rows as CSV-shaped text so its
/// content is searchable (it was name-match-only before; docs/analytics-genie.md).
/// The analytics engine queries the file directly — this is only for retrieval.
fn extract_parquet(abs: &Path) -> anyhow::Result<String> {
    use datafusion::arrow::util::display::array_value_to_string;
    use datafusion::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    const MAX_ROWS: usize = 200;
    let file = fs::File::open(abs)?;
    let reader = ParquetRecordBatchReaderBuilder::try_new(file)?.build()?;
    let mut lines: Vec<String> = Vec::new();
    let mut rows = 0usize;
    for batch in reader {
        let batch = batch?;
        if lines.is_empty() {
            lines.push(
                batch
                    .schema()
                    .fields()
                    .iter()
                    .map(|f| csv_cell(f.name().clone()))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        for row in 0..batch.num_rows() {
            if rows >= MAX_ROWS {
                return Ok(lines.join("\n"));
            }
            let cells: Vec<String> = (0..batch.num_columns())
                .map(|c| csv_cell(array_value_to_string(batch.column(c), row).unwrap_or_default()))
                .collect();
            lines.push(cells.join(","));
            rows += 1;
        }
    }
    Ok(lines.join("\n"))
}

/// Format a spreadsheet cell like SheetJS's CSV output (quote when needed).
fn csv_cell(raw: String) -> String {
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw
    }
}

pub(crate) fn cell_text(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(dt) => format!("{dt}"),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}

/// Flatten every sheet to CSV under its name, so cell text is searchable and
/// the sheet a hit came from is recoverable.
fn extract_xlsx(abs: &Path) -> anyhow::Result<String> {
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto(abs)?;
    let names: Vec<String> = wb.sheet_names().to_vec();
    let mut sheets: Vec<String> = Vec::new();
    for name in names {
        let Ok(range) = wb.worksheet_range(&name) else {
            continue;
        };
        let csv = range
            .rows()
            .map(|row| {
                row.iter()
                    .map(|c| csv_cell(cell_text(c)))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect::<Vec<_>>()
            .join("\n");
        sheets.push(format!("# {name}\n{csv}"));
    }
    Ok(sheets.join("\n\n"))
}

fn extract_by_ext(abs: &Path, ext: &str) -> anyhow::Result<String> {
    match ext {
        ".pdf" => extract_pdf(&fs::read(abs)?),
        ".docx" => extract_docx(&fs::read(abs)?),
        ".xlsx" | ".xls" => extract_xlsx(abs),
        ".parquet" => extract_parquet(abs),
        _ => Ok(String::new()),
    }
}

// --- on-disk cache (parse once per file version) ---

/// Cache schema version — bump when extraction logic changes in a way that
/// could alter output. Matches the TS cache so the two engines share entries.
const CACHE_VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
struct CacheRecord {
    v: u32,
    key: String,
    text: String,
}

fn cache_dir() -> PathBuf {
    let dir = state_dir().join("cache").join("extract");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn cache_path(abs: &Path) -> PathBuf {
    let mut h = Sha1::new();
    h.update(abs.to_string_lossy().as_bytes());
    cache_dir().join(format!("{}.json", hex::encode(h.finalize())))
}

/// The file's mtime in fractional milliseconds, formatted like Node's `mtimeMs`.
fn mtime_ms(meta: &fs::Metadata) -> String {
    let ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    format!("{ms}")
}

/// Return a rich file's extracted text, parsing it only on a cache miss. Any
/// failure yields "" — the file still appears in the vault and is findable by
/// name; it just contributes no content to retrieval.
pub fn extract_rich_text(abs: &Path, ext: &str) -> String {
    let Ok(meta) = fs::metadata(abs) else {
        return String::new();
    };
    if meta.len() > MAX_SOURCE_BYTES {
        return String::new();
    }

    let key = format!("{}:{}", mtime_ms(&meta), meta.len());
    let cp = cache_path(abs);
    if let Ok(text) = fs::read_to_string(&cp) {
        if let Ok(hit) = serde_json::from_str::<CacheRecord>(&text) {
            if hit.v == CACHE_VERSION && hit.key == key {
                return hit.text;
            }
        }
        // Stale key or older schema falls through to a fresh parse below.
    }

    let text = match extract_by_ext(abs, ext) {
        Ok(t) => clamp(t.trim()),
        Err(err) => {
            // Degrade gracefully but do NOT cache the failure: log it so empty
            // results are diagnosable, and let the next scan retry.
            let base = abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            eprintln!("extract: failed to read {base} ({ext}): {err}");
            return String::new();
        }
    };
    // Only successful extractions are cached (an empty string is a genuine
    // result, e.g. a scanned/image-only PDF).
    let record = CacheRecord {
        v: CACHE_VERSION,
        key,
        text: text.clone(),
    };
    if let Ok(json) = serde_json::to_string(&record) {
        let _ = fs::write(&cp, json); // best-effort; read-only just means re-parsing
    }
    text
}
