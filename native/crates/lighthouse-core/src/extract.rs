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
// .doc is desktop-only capability: the TS dev twin's mammoth parser reads
// OOXML only, so legacy .doc stays name-match-only there (PARITY divergence,
// like B2 hybrid search).
const RICH_EXT: &[&str] = &[".pdf", ".doc", ".docx", ".xlsx", ".xls", ".parquet"];

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

/// OLE compound-file magic: legacy binary Office files (.doc) and
/// IRM/password-protected OOXML packages — everything that is Word but NOT a
/// zip starts with this.
const OLE_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// DOCX is a zip of XML: collect the text runs (`w:t`) of the package's main
/// document part, paragraphs joined with a blank line (the shape mammoth's
/// extractRawText gives). Hardened for the shapes real vaults contain (0.6.x
/// field report — business .docx files indexed name-only):
///   - a legacy binary .doc renamed to .docx is an OLE container, not a zip —
///     route it to the .doc salvage instead of erroring;
///   - the main part is resolved from _rels/.rels (some generators write
///     word/document2.xml), falling back to any word/document*.xml;
///   - `<w:tab/>`/`<w:br/>`/`<w:cr/>` arrive as EMPTY events, not Start;
///   - non-UTF-8 XML decodes lossily instead of failing the whole file.
fn extract_docx(buf: &[u8]) -> anyhow::Result<String> {
    if buf.starts_with(OLE_MAGIC) {
        return extract_doc(buf);
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))?;
    let main = docx_main_part(&mut archive);
    let mut raw = Vec::new();
    archive.by_name(&main)?.read_to_end(&mut raw)?;
    let xml = String::from_utf8_lossy(&raw);

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
            Ok(quick_xml::events::Event::Empty(e)) => {
                // Self-closing run content: real Word files write tabs and
                // line breaks this way, so only handling Start lost them.
                match e.name().local_name().as_ref() {
                    b"tab" => current.push('\t'),
                    b"br" | b"cr" => current.push('\n'),
                    _ => {}
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

/// The package's main document part: resolved from `_rels/.rels` when present
/// (the officeDocument relationship — some generators target
/// word/document2.xml), else `word/document.xml`, else the first
/// `word/document*.xml` member.
fn docx_main_part<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> String {
    let mut rels = String::new();
    let read_ok = archive
        .by_name("_rels/.rels")
        .ok()
        .map(|mut f| f.read_to_string(&mut rels).is_ok())
        .unwrap_or(false);
    if read_ok {
        let mut reader = quick_xml::Reader::from_str(&rels);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e))
                | Ok(quick_xml::events::Event::Empty(e)) => {
                    if e.name().local_name().as_ref() == b"Relationship" {
                        let mut is_doc = false;
                        let mut target: Option<String> = None;
                        for a in e.attributes().flatten() {
                            let v = String::from_utf8_lossy(&a.value).to_string();
                            match a.key.local_name().as_ref() {
                                b"Type" if v.ends_with("/officeDocument") => is_doc = true,
                                b"Target" => target = Some(v),
                                _ => {}
                            }
                        }
                        if is_doc {
                            if let Some(t) = target {
                                return t.trim_start_matches('/').to_string();
                            }
                        }
                    }
                }
                Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }
    if archive.by_name("word/document.xml").is_ok() {
        return "word/document.xml".to_string();
    }
    let names: Vec<String> = archive.file_names().map(String::from).collect();
    names
        .into_iter()
        .find(|n| n.starts_with("word/document") && n.ends_with(".xml"))
        .unwrap_or_else(|| "word/document.xml".to_string())
}

/// Legacy binary .doc salvage. There is no full parser here, but Word 97+
/// stores document text inside the OLE container either as UTF-16LE or as
/// single-byte ANSI piece runs — scanning for long printable runs recovers
/// the prose (imperfect formatting, real content). Three scans (UTF-16 at
/// both byte alignments, plus ANSI) and the best yield wins, so alignment
/// and compressed-piece files all salvage. An IRM/password-protected file is
/// OLE too but encrypted: every scan comes back empty and we say so.
fn extract_doc(buf: &[u8]) -> anyhow::Result<String> {
    /// A salvage run counts as text only when it's long AND reads like prose
    /// (mostly ASCII): an encrypted container is random bytes, and random
    /// UTF-16 units decode into long runs of exotic-but-printable characters
    /// that would otherwise pollute the index with mojibake.
    fn prose_like(run: &str) -> bool {
        let total = run.trim().chars().count();
        if total < 24 {
            return false;
        }
        let ascii = run
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ' || *c == '\t' || *c == '\n')
            .count();
        ascii * 10 >= total * 7
    }
    fn utf16_runs(buf: &[u8], phase: usize) -> String {
        let mut out = String::new();
        let mut run = String::new();
        let mut i = phase;
        while i + 1 < buf.len() {
            let u = u16::from_le_bytes([buf[i], buf[i + 1]]);
            i += 2;
            let ch = char::from_u32(u as u32).unwrap_or('\u{0}');
            if u == 0x000D || u == 0x000B {
                run.push('\n');
                continue;
            }
            if u == 0x0009 || (!ch.is_control() && u != 0) {
                run.push(if u == 0x0009 { '\t' } else { ch });
                continue;
            }
            if prose_like(&run) {
                out.push_str(run.trim_end());
                out.push('\n');
            }
            run.clear();
        }
        if prose_like(&run) {
            out.push_str(run.trim_end());
        }
        out
    }
    fn ansi_runs(buf: &[u8]) -> String {
        let mut out = String::new();
        let mut run = String::new();
        for &b in buf {
            if b == 0x0D || b == 0x0B {
                run.push('\n');
                continue;
            }
            if b == 0x09 || (0x20..0x7F).contains(&b) {
                run.push(b as char);
                continue;
            }
            if run.trim().len() >= 32 {
                out.push_str(run.trim_end());
                out.push('\n');
            }
            run.clear();
        }
        if run.trim().len() >= 32 {
            out.push_str(run.trim_end());
        }
        out
    }
    let candidates = [utf16_runs(buf, 0), utf16_runs(buf, 1), ansi_runs(buf)];
    let best = candidates
        .into_iter()
        .max_by_key(|s| s.len())
        .unwrap_or_default();
    if best.trim().len() < 64 {
        anyhow::bail!(
            "legacy/encrypted Word container with no readable text (password-protected files can't be read)"
        );
    }
    Ok(best)
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
        // Raw serials ("45123.5") defeat every date GROUP BY; render ISO so
        // the SQL idioms the few-shots teach (substr(date,1,7)) just work.
        Data::DateTime(dt) => excel_serial_to_iso(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}

/// Excel 1900-system serial → ISO 8601 text. Epoch 1899-12-30 absorbs Excel's
/// phantom 1900-02-29 for every date from 1900-03-01 on (the realistic range;
/// calamine's own chrono conversion picks the same epoch). Whole days render
/// date-only so month grouping stays clean; day fractions round to the nearest
/// second. Serials outside a sane date range fall back to the raw number
/// rather than fabricating a date.
pub(crate) fn excel_serial_to_iso(serial: f64) -> String {
    // 2958465 = 9999-12-31; negatives are not dates.
    if !serial.is_finite() || serial < 0.0 || serial > 2_958_465.0 {
        return format!("{serial}");
    }
    let mut days = serial.trunc() as i64;
    let mut secs = ((serial - serial.trunc()) * 86_400.0).round() as i64;
    if secs >= 86_400 {
        days += 1;
        secs = 0;
    }
    let Some(date) = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)
        .and_then(|d| d.checked_add_signed(chrono::Duration::days(days)))
    else {
        return format!("{serial}");
    };
    if secs == 0 {
        date.format("%Y-%m-%d").to_string()
    } else {
        let time = chrono::NaiveTime::from_num_seconds_from_midnight_opt(secs as u32, 0)
            .unwrap_or(chrono::NaiveTime::MIN);
        format!("{} {}", date.format("%Y-%m-%d"), time.format("%H:%M:%S"))
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
        // extract_docx routes OLE containers (renamed legacy .doc, protected
        // packages) to the salvage path itself, so both extensions share it.
        ".doc" | ".docx" => extract_docx(&fs::read(abs)?),
        ".xlsx" | ".xls" => extract_xlsx(abs),
        ".parquet" => extract_parquet(abs),
        _ => Ok(String::new()),
    }
}

// --- on-disk cache (parse once per file version) ---

/// Cache schema version — bump when extraction logic changes in a way that
/// could alter output. Matches the TS cache so the two engines share entries.
/// v3: docx whitespace fidelity (Empty-event tabs/breaks) + .doc salvage.
/// v4: Excel datetime cells render as ISO 8601 instead of raw serials.
const CACHE_VERSION: u32 = 4;

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

#[cfg(test)]
mod serial_date_tests {
    use super::excel_serial_to_iso;

    #[test]
    fn whole_days_render_date_only() {
        // 43831 = 2020-01-01 in the 1900 system — a well-known anchor.
        assert_eq!(excel_serial_to_iso(43_831.0), "2020-01-01");
        // 61 = 1900-03-01, the first serial unaffected by the phantom leap day.
        assert_eq!(excel_serial_to_iso(61.0), "1900-03-01");
    }

    #[test]
    fn day_fractions_render_seconds() {
        assert_eq!(excel_serial_to_iso(43_831.5), "2020-01-01 12:00:00");
        assert_eq!(excel_serial_to_iso(43_831.75), "2020-01-01 18:00:00");
        // Sub-second fractions round to the nearest second.
        let one_sec = 1.0 / 86_400.0;
        assert_eq!(excel_serial_to_iso(43_831.0 + one_sec * 1.4), "2020-01-01 00:00:01");
    }

    #[test]
    fn near_midnight_rolls_to_next_day() {
        // 43831 + 86399.6/86400 rounds up past midnight → date-only next day.
        assert_eq!(excel_serial_to_iso(43_831.0 + 86_399.6 / 86_400.0), "2020-01-02");
    }

    #[test]
    fn non_dates_fall_back_to_the_raw_number() {
        assert_eq!(excel_serial_to_iso(-5.0), "-5");
        assert_eq!(excel_serial_to_iso(3_000_000.0), "3000000");
        assert_eq!(excel_serial_to_iso(f64::NAN), "NaN");
    }
}

#[cfg(test)]
mod docx_tests {
    use super::{extract_doc, extract_docx, OLE_MAGIC};
    use std::io::Write;

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    const DOC_XML: &str = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p><w:r><w:t xml:space="preserve">Step 1:</w:t><w:tab/><w:t>open the importer</w:t></w:r></w:p>
  <w:p><w:r><w:t>Line A</w:t><w:br/><w:t>Line B</w:t></w:r></w:p>
 </w:body>
</w:document>"#;

    #[test]
    fn a_standard_package_extracts_text_tabs_and_breaks() {
        let buf = zip_of(&[("word/document.xml", DOC_XML)]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("Step 1:\topen the importer"), "{text:?}");
        assert!(text.contains("Line A\nLine B"), "{text:?}");
    }

    /// Some generators write word/document2.xml and point _rels/.rels at it —
    /// such packages indexed name-only before (0.6.x field report class).
    #[test]
    fn the_main_part_is_resolved_from_rels() {
        let rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml"/>
</Relationships>"#;
        let buf = zip_of(&[("_rels/.rels", rels), ("word/document2.xml", DOC_XML)]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("open the importer"), "{text:?}");
    }

    /// A legacy binary .doc renamed to .docx is an OLE container: the zip
    /// parser can't touch it, but the UTF-16 salvage recovers the prose.
    #[test]
    fn a_renamed_legacy_doc_salvages_its_text() {
        let mut buf = OLE_MAGIC.to_vec();
        buf.extend_from_slice(&[0u8; 64]);
        let prose = "Annual ticket import: open the admin panel, choose Import, pick the CSV export, confirm the mapping.\r";
        for _ in 0..2 {
            for u in prose.encode_utf16() {
                buf.extend_from_slice(&u.to_le_bytes());
            }
        }
        buf.extend_from_slice(&[0u8; 32]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("Annual ticket import"), "{text:?}");
        assert!(text.contains("confirm the mapping"), "{text:?}");
    }

    /// Word 97 also stores "compressed" (single-byte ANSI) text pieces.
    #[test]
    fn ansi_piece_text_salvages_too() {
        let mut buf = OLE_MAGIC.to_vec();
        buf.extend_from_slice(&[0u8; 16]);
        buf.extend_from_slice(
            b"Compressed piece table text: import tickets annually via the admin importer screen.\rmore words to clear the run threshold comfortably",
        );
        let text = extract_doc(&buf).unwrap();
        assert!(text.contains("import tickets annually"), "{text:?}");
    }

    /// An encrypted (IRM/password) container is random bytes — the prose
    /// filter must reject it so the index never fills with mojibake, and the
    /// error names the real situation.
    #[test]
    fn an_encrypted_container_errors_instead_of_pretending() {
        let mut buf = OLE_MAGIC.to_vec();
        // Deterministic pseudo-random filler (no Math.random in tests).
        let mut x: u32 = 0x1234_5678;
        for _ in 0..8192 {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            buf.push((x >> 24) as u8);
        }
        assert!(extract_docx(&buf).is_err());
    }

    #[test]
    fn garbage_bytes_error_instead_of_passing_as_empty() {
        assert!(extract_docx(b"this is not a word file at all").is_err());
    }
}
