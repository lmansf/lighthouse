//! Text extraction for "rich" document formats — PDF, Word, Excel (port of
//! `src/server/extract.ts`) plus desktop-only PowerPoint, OpenDocument, and RTF.
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
// like B2 hybrid search). The presentation / OpenDocument / RTF formats below
// are likewise Rust-only for now: the shipping desktop engine reads them; the
// TS twin has no zip/rtf parser without new npm deps, so it leaves them
// name-match-only. Adding these was purely additive — none was ever in
// TEXT_EXT, so no previously-indexed file changes behavior. The image formats
// (add-ocr-perception) are likewise Rust-only: their text comes from the
// bundled OCR models, which the TS twin doesn't carry.
const RICH_EXT: &[&str] = &[
    ".pdf", ".doc", ".docx", ".xlsx", ".xlsm", ".xls", ".parquet", ".pptx", ".odt", ".odp", ".rtf",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
];

/// Raster formats whose text comes from OCR (subset of RICH_EXT).
const OCR_IMAGE_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"];

fn is_ocr_image_ext(ext: &str) -> bool {
    OCR_IMAGE_EXT.contains(&ext)
}

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
/// MAX_SOURCE_BYTES bounds the COMPRESSED file only — deflate expands up to
/// ~1000:1, so a crafted zip could otherwise inflate to tens of GB in memory
/// and OOM the app mid-scan. Every zip member is read through `Read::take`
/// with one of these caps: small per-part for slides (real ones are KB-scale),
/// generous for a document's single main XML part (revision-heavy Word files
/// legitimately reach tens of MB).
const MAX_PART_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MAIN_XML_BYTES: u64 = 64 * 1024 * 1024;
/// A deck with more parts than this is not a presentation, it's an attack.
const MAX_PPTX_PARTS: usize = 2048;
/// Word writes up to ~6 header/footer parts per section plus one footnotes +
/// one endnotes part; hundreds means a hostile package, not a document.
const MAX_DOCX_AUX_PARTS: usize = 512;

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

/// Image files: decode and OCR (add-ocr-perception). `OcrUnavailable` (toggle
/// off, models missing) propagates so extract_rich_text skips caching and the
/// file self-heals on a later scan.
fn extract_image(abs: &Path) -> anyhow::Result<String> {
    if !crate::ocr::available() {
        // Before decoding: while OCR is off, scans shouldn't pay decode cost.
        return Err(anyhow::Error::new(crate::ocr::OcrUnavailable));
    }
    // Read dimensions from the header only (cheap) and bail on a decompression
    // bomb BEFORE allocating the full RGB buffer. An oversized image is a
    // genuine skip (Ok("") caches — retrying every scan buys nothing).
    if let Ok((w, h)) = image::image_dimensions(abs) {
        if crate::ocr::too_many_pixels(w, h) {
            eprintln!("extract: image {w}x{h} exceeds the OCR pixel budget — skipped");
            return Ok(String::new());
        }
    }
    let img = image::load_from_memory(&fs::read(abs)?)?;
    crate::ocr::recognize_image(&img)
}

/// The average yield below which a PDF's text layer counts as "no real text":
/// a scanned page contributes ~0 chars, a text page hundreds.
fn pdf_text_is_trivial(chars: usize, pages: usize) -> bool {
    chars < 32 * pages.max(1)
}

/// The largest raster XObject on each page (metadata pass — nothing decoded),
/// in page order, capped at the OCR page budget. Scanner output is one
/// full-page image per page, so "largest per page" is the page.
fn pdf_page_rasters(doc: &lopdf::Document) -> Vec<lopdf::ObjectId> {
    let mut out = Vec::new();
    for (_no, page_id) in doc
        .get_pages()
        .into_iter()
        .take(crate::ocr::MAX_OCR_PAGES_PER_PDF)
    {
        let mut best: Option<(i64, lopdf::ObjectId)> = None;
        let Ok((direct, referenced)) = doc.get_page_resources(page_id) else {
            continue; // malformed page: no resources to scan
        };
        let mut resource_dicts: Vec<&lopdf::Dictionary> = Vec::new();
        if let Some(d) = direct {
            resource_dicts.push(d);
        }
        for id in referenced {
            if let Ok(d) = doc.get_dictionary(id) {
                resource_dicts.push(d);
            }
        }
        for res in resource_dicts {
            let xdict = match res.get(b"XObject") {
                Ok(lopdf::Object::Dictionary(d)) => d,
                Ok(lopdf::Object::Reference(id)) => match doc.get_dictionary(*id) {
                    Ok(d) => d,
                    Err(_) => continue,
                },
                _ => continue,
            };
            for (_name, val) in xdict.iter() {
                let lopdf::Object::Reference(sid) = val else {
                    continue;
                };
                let Ok(lopdf::Object::Stream(s)) = doc.get_object(*sid) else {
                    continue;
                };
                let is_image =
                    matches!(s.dict.get(b"Subtype"), Ok(lopdf::Object::Name(n)) if n == b"Image");
                if !is_image {
                    continue;
                }
                let w = s.dict.get(b"Width").and_then(|o| o.as_i64()).unwrap_or(0);
                let h = s.dict.get(b"Height").and_then(|o| o.as_i64()).unwrap_or(0);
                let area = w.saturating_mul(h);
                if area > 0 && best.map(|(a, _)| area > a).unwrap_or(true) {
                    best = Some((area, *sid));
                }
            }
        }
        if let Some((_, sid)) = best {
            out.push(sid);
        }
    }
    out
}

/// Decode one PDF image stream we support in v1: `DCTDecode` (the stream IS a
/// JPEG — scanner output) and `FlateDecode`/unfiltered 8-bit DeviceRGB/Gray
/// bitmaps. CCITT/JBIG2/JPX return None and count as skipped.
fn decode_pdf_image(stream: &lopdf::Stream) -> Option<image::DynamicImage> {
    // Declared dimensions first, so the bomb guard covers BOTH the DCT (JPEG
    // decode) and Flate (inflate) paths before either allocates.
    let w = stream
        .dict
        .get(b"Width")
        .and_then(|o| o.as_i64())
        .unwrap_or(0);
    let h = stream
        .dict
        .get(b"Height")
        .and_then(|o| o.as_i64())
        .unwrap_or(0);
    if w <= 0 || h <= 0 || w > 1 << 16 || h > 1 << 16 {
        return None;
    }
    let (w, h) = (w as u32, h as u32);
    if crate::ocr::too_many_pixels(w, h) {
        return None;
    }

    let filters: Vec<Vec<u8>> = match stream.dict.get(b"Filter") {
        Ok(lopdf::Object::Name(n)) => vec![n.clone()],
        Ok(lopdf::Object::Array(a)) => a
            .iter()
            .filter_map(|o| match o {
                lopdf::Object::Name(n) => Some(n.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    if filters.iter().any(|f| f == b"DCTDecode") {
        return image::load_from_memory_with_format(&stream.content, image::ImageFormat::Jpeg).ok();
    }
    let flate_only = filters.iter().all(|f| f == b"FlateDecode");
    if !flate_only {
        return None; // CCITTFaxDecode / JBIG2Decode / JPXDecode: v1 skips
    }
    let bpc = stream
        .dict
        .get(b"BitsPerComponent")
        .and_then(|o| o.as_i64())
        .unwrap_or(8);
    if bpc != 8 {
        return None;
    }
    let data = if filters.is_empty() {
        stream.content.clone()
    } else {
        stream.decompressed_content().ok()?
    };
    let colorspace = match stream.dict.get(b"ColorSpace") {
        Ok(lopdf::Object::Name(n)) => n.clone(),
        _ => return None, // ICC/Indexed/Separation via refs: v1 skips
    };
    match colorspace.as_slice() {
        b"DeviceRGB" if data.len() >= (w * h * 3) as usize => {
            image::RgbImage::from_raw(w, h, data[..(w * h * 3) as usize].to_vec())
                .map(image::DynamicImage::ImageRgb8)
        }
        b"DeviceGray" if data.len() >= (w * h) as usize => {
            image::GrayImage::from_raw(w, h, data[..(w * h) as usize].to_vec())
                .map(image::DynamicImage::ImageLuma8)
        }
        _ => None,
    }
}

/// PDF extraction with the scanned-document fallback: keep the text layer for
/// real text PDFs; when it's trivial AND the pages carry raster images, OCR
/// the page images in order. `OcrUnavailable` propagates (uncached) only when
/// there is genuinely something OCR *would* read.
fn extract_pdf_with_ocr(buf: &[u8]) -> anyhow::Result<String> {
    let text = extract_pdf(buf)?;
    pdf_ocr_fallback(text, buf)
}

/// Append any reconstructed tables to a PDF's extracted text as markdown
/// (openspec: add-pdf-tables). Fails closed: no confident grid ⇒ the text is
/// returned unchanged, byte-identical to the pre-tables extraction.
fn append_pdf_tables(mut text: String, buf: &[u8], abs: &Path) -> String {
    let tables = crate::pdf_tables::extract_tables(buf);
    if tables.is_empty() {
        return text;
    }
    let name = abs.file_name().and_then(|n| n.to_str()).unwrap_or("document");
    if !text.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(&format!("## Tables detected in {name}\n\n"));
    text.push_str(&crate::pdf_tables::tables_to_markdown(&tables));
    text
}

/// Testable half of the fallback: decides against the already-extracted text
/// layer, so tests can drive it with synthetic PDFs without pdf-extract.
fn pdf_ocr_fallback(text: String, buf: &[u8]) -> anyhow::Result<String> {
    let Ok(doc) = lopdf::Document::load_mem(buf) else {
        return Ok(text); // structure unreadable for the fallback: keep the text layer
    };
    let pages = doc.get_pages().len();
    if !pdf_text_is_trivial(text.trim().chars().count(), pages) {
        return Ok(text);
    }
    let rasters = pdf_page_rasters(&doc);
    if rasters.is_empty() {
        return Ok(text); // genuinely near-empty text PDF — a real result, cache it
    }
    if !crate::ocr::available() {
        return Err(anyhow::Error::new(crate::ocr::OcrUnavailable));
    }
    let mut blocks: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    for sid in &rasters {
        let Ok(lopdf::Object::Stream(s)) = doc.get_object(*sid) else {
            continue;
        };
        match decode_pdf_image(s) {
            Some(img) => match crate::ocr::recognize_image(&img) {
                Ok(t) if !t.trim().is_empty() => blocks.push(t),
                Ok(_) => {}
                Err(e) if e.downcast_ref::<crate::ocr::OcrUnavailable>().is_some() => {
                    return Err(e);
                }
                Err(_) => skipped += 1,
            },
            None => skipped += 1,
        }
    }
    if skipped > 0 {
        eprintln!(
            "extract: pdf ocr skipped {skipped}/{} page image(s) (unsupported encoding)",
            rasters.len()
        );
    }
    if blocks.is_empty() {
        // All pages unsupported (e.g. CCITT fax scans): a genuine v1 limit —
        // cache the empty text layer; the cache-version bump that adds support
        // will re-extract.
        return Ok(text);
    }
    Ok(blocks.join("\n\n"))
}

/// Read-only: does the extracted text for this file come from OCR? True for
/// raster image formats (their text is, by definition, OCR output) and for a
/// scanned PDF that took the OCR fallback (a trivial text layer over pages that
/// carry raster images — the exact trigger `pdf_ocr_fallback` uses). Serves the
/// file inspector's `fromOcr` flag. Never mutates or caches; a read failure is
/// reported as "not OCR" rather than surfaced. The PDF branch re-reads and
/// parses the one file's text layer, so gate the call on there actually being
/// extracted text to flag.
pub fn text_is_ocr_derived(abs: &Path, ext: &str) -> bool {
    if is_ocr_image_ext(ext) {
        return true;
    }
    if ext != ".pdf" {
        return false;
    }
    let Ok(buf) = fs::read(abs) else {
        return false;
    };
    // The text layer as pdf-extract reads it: if it is trivial AND the pages
    // carry rasters, the cached doc text was produced by the OCR fallback.
    let Ok(layer) = extract_pdf(&buf) else {
        return false;
    };
    let Ok(doc) = lopdf::Document::load_mem(&buf) else {
        return false;
    };
    let pages = doc.get_pages().len();
    pdf_text_is_trivial(layer.trim().chars().count(), pages) && !pdf_page_rasters(&doc).is_empty()
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
///     word/document2.xml) and VERIFIED to exist, falling back to any
///     word/document*.xml — a dead rels target must not zero the document;
///   - footnotes/endnotes/headers/footers are read too (a footnote-heavy doc
///     used to extract as its near-empty body, which then got cached);
///   - `<w:tab/>`/`<w:br/>`/`<w:cr/>` arrive as EMPTY events, not Start;
///   - `mc:Fallback` duplicates of text boxes are skipped, not double-read;
///   - non-UTF-8 XML decodes lossily instead of failing the whole file.
fn extract_docx(buf: &[u8]) -> anyhow::Result<String> {
    if buf.starts_with(OLE_MAGIC) {
        return extract_doc(buf);
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))?;
    let main = docx_main_part(&mut archive);
    let mut raw = Vec::new();
    // Capped read: bounds a decompression bomb. A truncated-at-cap legitimate
    // file yields malformed XML below, which errors (logged, not cached) — but
    // no real document.xml approaches 64 MB of markup.
    archive
        .by_name(&main)?
        .take(MAX_MAIN_XML_BYTES)
        .read_to_end(&mut raw)?;
    let xml = String::from_utf8_lossy(&raw);
    let mut blocks = docx_runs(&xml)?;

    // Substance often lives OUTSIDE the main body: footnotes/endnotes (where
    // an academic or legal doc keeps the actual content), headers/footers.
    // A body that is just "Ouch." with ten pages of footnotes extracted empty
    // before — and that empty WAS cached (0.10 field report class). Read the
    // auxiliary parts too, body first so previews stay sane; a malformed aux
    // member degrades to skipped instead of failing the whole document.
    let mut aux: Vec<String> = archive
        .file_names()
        .filter(|n| {
            n.starts_with("word/footnotes") && n.ends_with(".xml")
                || n.starts_with("word/endnotes") && n.ends_with(".xml")
                || n.starts_with("word/header") && n.ends_with(".xml")
                || n.starts_with("word/footer") && n.ends_with(".xml")
        })
        .map(String::from)
        .collect();
    let rank = |n: &str| -> u8 {
        if n.starts_with("word/footnotes") {
            0
        } else if n.starts_with("word/endnotes") {
            1
        } else if n.starts_with("word/header") {
            2
        } else {
            3
        }
    };
    aux.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(part_number(a).cmp(&part_number(b)))
    });
    aux.truncate(MAX_DOCX_AUX_PARTS);
    // Stop once the output budget is met (the final clamp cuts at
    // MAX_EXTRACT_BYTES anyway) — bounds work on absurd or hostile files.
    let mut total: usize = blocks.iter().map(|b| b.len()).sum();
    for name in &aux {
        if total >= MAX_EXTRACT_BYTES {
            break;
        }
        if let Some(xml) = read_member(&mut archive, name, MAX_PART_BYTES) {
            for p in docx_runs(&xml).unwrap_or_default() {
                total += p.len();
                blocks.push(p);
            }
        }
    }
    Ok(blocks.join("\n\n"))
}

/// Collect the text of every `<w:t>` run in a WordprocessingML part, breaking
/// paragraphs on `</w:p>` and preserving explicit tabs/breaks. Content inside
/// `<mc:Fallback>` is skipped: AlternateContent carries the SAME text twice
/// (a modern `mc:Choice` drawing and a `v:textbox` fallback), so reading both
/// double-counted every text box.
fn docx_runs(xml: &str) -> anyhow::Result<Vec<String>> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut fallback_depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"Fallback" {
                    fallback_depth += 1;
                } else if fallback_depth > 0 {
                    // swallow everything inside the duplicate branch
                } else if local.as_ref() == b"t" {
                    in_text = true;
                } else if local.as_ref() == b"tab" {
                    current.push('\t');
                }
            }
            Ok(quick_xml::events::Event::Empty(e)) => {
                if fallback_depth > 0 {
                    continue;
                }
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
                if local.as_ref() == b"Fallback" {
                    fallback_depth = fallback_depth.saturating_sub(1);
                } else if fallback_depth > 0 {
                    // still inside the duplicate branch
                } else if local.as_ref() == b"t" {
                    in_text = false;
                } else if local.as_ref() == b"p" {
                    let p = std::mem::take(&mut current);
                    if !p.trim().is_empty() {
                        paragraphs.push(p);
                    }
                }
            }
            Ok(quick_xml::events::Event::Text(t)) => {
                if in_text && fallback_depth == 0 {
                    current.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("docx xml: {e}")),
            _ => {}
        }
    }
    if !current.trim().is_empty() {
        paragraphs.push(current);
    }
    Ok(paragraphs)
}

/// The package's main document part: resolved from `_rels/.rels` when present
/// (the officeDocument relationship — some generators target
/// word/document2.xml) and only trusted when the target actually exists,
/// else `word/document.xml`, else the first `word/document*.xml` member.
fn docx_main_part<R: std::io::Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> String {
    let mut rels = String::new();
    let read_ok = archive
        .by_name("_rels/.rels")
        .ok()
        // .take: rels files are tiny; an inflated one is a decompression bomb.
        .map(|f| f.take(MAX_PART_BYTES).read_to_string(&mut rels).is_ok())
        .unwrap_or(false);
    if read_ok {
        let mut reader = quick_xml::Reader::from_str(&rels);
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e)) => {
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
                            // Trust the rels target ONLY if it actually exists
                            // in the archive: a stale/oddly-encoded target used
                            // to hard-fail the whole document at by_name (the
                            // "text-heavy docx extracts empty" class) — fall
                            // through to the name-based fallbacks instead.
                            if let Some(t) = target {
                                let t = t.trim_start_matches('/').to_string();
                                if archive.by_name(&t).is_ok() {
                                    return t;
                                }
                                break;
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
/// content is searchable (it was name-match-only before; docs/analytics-beam.md).
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
        // `as_datetime()` applies the workbook's date-system offset (the
        // 1462-day 1904 correction for Mac-origin files) and the phantom
        // 1900-leap fix — `as_f64()` returns the RAW serial, which rendered
        // 1904-system dates ~4 years early. Durations / out-of-range serials
        // (as_datetime → None) fall back to the raw-number rendering.
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(ndt) => {
                let d = ndt.date();
                let t = ndt.time();
                if t == chrono::NaiveTime::MIN {
                    d.format("%Y-%m-%d").to_string()
                } else {
                    format!("{} {}", d.format("%Y-%m-%d"), t.format("%H:%M:%S"))
                }
            }
            None => excel_serial_to_iso(dt.as_f64()),
        },
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

/// Trailing numeric index of an OOXML part name (`.../slide12.xml` -> 12) so
/// slide and notes parts sort in presentation order rather than lexically
/// (slide10 would otherwise sort before slide2).
fn part_number(name: &str) -> u32 {
    let stem = name.rsplit('/').next().unwrap_or(name);
    let stem = stem.strip_suffix(".xml").unwrap_or(stem);
    let tail: String = stem
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    tail.parse().unwrap_or(0)
}

/// Read one archive member (up to `cap` DECOMPRESSED bytes — see MAX_PART_BYTES)
/// as lossy UTF-8. OOXML/ODF parts are UTF-8, but a stray byte should degrade
/// that member, not fail the whole document.
fn read_member<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    cap: u64,
) -> Option<String> {
    let mut raw = Vec::new();
    archive
        .by_name(name)
        .ok()?
        .take(cap)
        .read_to_end(&mut raw)
        .ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
}

/// Collect the text of every `<a:t>` run element in a DrawingML part, breaking
/// paragraphs on `</a:p>`. DrawingML drops its namespace to the same local
/// names Word uses (`t`/`p`), so this mirrors the docx run reader.
fn drawingml_runs(xml: &str) -> Vec<String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut paras: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                if e.name().local_name().as_ref() == b"t" {
                    in_text = true;
                }
            }
            Ok(quick_xml::events::Event::Empty(e)) => {
                // <a:br/> is a soft line break inside a text body.
                if e.name().local_name().as_ref() == b"br" {
                    current.push('\n');
                }
            }
            Ok(quick_xml::events::Event::End(e)) => match e.name().local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => paras.push(std::mem::take(&mut current)),
                _ => {}
            },
            Ok(quick_xml::events::Event::Text(t)) => {
                if in_text {
                    current.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => {
                // Malformed markup mid-run (an encrypted or corrupt member):
                // drop the partial run so binary junk never lands in the index.
                // Paragraphs that closed cleanly before the error are kept.
                current.clear();
                break;
            }
            _ => {}
        }
    }
    if !current.is_empty() {
        paras.push(current);
    }
    paras.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// PPTX is a zip of DrawingML XML: on-slide text lives in
/// `ppt/slides/slideN.xml` and speaker notes — where a runbook's actual
/// procedure often sits — in `ppt/notesSlides/notesSlideN.xml`. Emit slides in
/// numeric order, then the notes, so every word is searchable regardless of
/// where the author put it.
fn extract_pptx(buf: &[u8]) -> anyhow::Result<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))?;
    let mut slides: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for name in archive.file_names().map(String::from).collect::<Vec<_>>() {
        if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
            slides.push(name);
        } else if name.starts_with("ppt/notesSlides/notesSlide") && name.ends_with(".xml") {
            notes.push(name);
        }
    }
    slides.sort_by_key(|n| part_number(n));
    notes.sort_by_key(|n| part_number(n));
    slides.truncate(MAX_PPTX_PARTS);
    notes.truncate(MAX_PPTX_PARTS);

    // Stop reading parts once the output budget is met: the final clamp cuts
    // at MAX_EXTRACT_BYTES anyway, so later parts can't change the result —
    // this just bounds work on absurd or hostile decks.
    let mut total = 0usize;
    let mut blocks: Vec<String> = Vec::new();
    for name in &slides {
        if total > MAX_EXTRACT_BYTES {
            break;
        }
        if let Some(xml) = read_member(&mut archive, name, MAX_PART_BYTES) {
            let text = drawingml_runs(&xml).join("\n");
            if !text.trim().is_empty() {
                total += text.len();
                blocks.push(text);
            }
        }
    }
    let mut note_text: Vec<String> = Vec::new();
    for name in &notes {
        if total > MAX_EXTRACT_BYTES {
            break;
        }
        if let Some(xml) = read_member(&mut archive, name, MAX_PART_BYTES) {
            let text = drawingml_runs(&xml).join("\n");
            if !text.trim().is_empty() {
                total += text.len();
                note_text.push(text);
            }
        }
    }
    if !note_text.is_empty() {
        blocks.push(format!("Notes:\n{}", note_text.join("\n\n")));
    }
    Ok(blocks.join("\n\n"))
}

/// ODF text documents (`.odt`) and presentations (`.odp`) keep displayable text
/// as character data in `content.xml`. Emit all of it, breaking lines on
/// paragraph/heading ends and honoring the explicit whitespace elements. Only
/// `content.xml` is read, so styles and document metadata never leak in — and
/// within it, tracked-change deletions, reviewer comments, and inline binary
/// data are excluded: text the author removed must not resurface in search.
fn extract_odf(buf: &[u8]) -> anyhow::Result<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf))?;
    let xml = read_member(&mut archive, "content.xml", MAX_MAIN_XML_BYTES)
        .ok_or_else(|| anyhow::anyhow!("odf: no content.xml"))?;

    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    // Depth of subtrees whose character data must never reach the index:
    // <office:binary-data> (images inlined as base64), <text:tracked-changes>
    // (holds the DELETED text of tracked changes), and <office:annotation>
    // (reviewer comments — not visible body prose).
    let mut skip = 0i32;
    // An encrypted .odt keeps the zip layout but content.xml is ciphertext:
    // decoded lossily it parses as one giant element-less text node. Only
    // flush the trailing line if the member actually contained markup.
    let mut saw_elem = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Text(t)) => {
                if skip == 0 {
                    line.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(quick_xml::events::Event::Start(e)) => {
                saw_elem = true;
                if matches!(
                    e.name().local_name().as_ref(),
                    b"binary-data" | b"tracked-changes" | b"annotation"
                ) {
                    skip += 1;
                }
            }
            Ok(quick_xml::events::Event::Empty(e)) => {
                saw_elem = true;
                if skip == 0 {
                    match e.name().local_name().as_ref() {
                        b"tab" => line.push('\t'),
                        b"line-break" => line.push('\n'),
                        b"s" => line.push(' '),
                        _ => {}
                    }
                }
            }
            // A paragraph or heading closes a line; ODF nests spans inside these,
            // so breaking only here keeps a paragraph's runs together.
            Ok(quick_xml::events::Event::End(e)) => {
                saw_elem = true;
                match e.name().local_name().as_ref() {
                    b"binary-data" | b"tracked-changes" | b"annotation" => skip = (skip - 1).max(0),
                    // A </text:p> inside a skipped subtree must neither flush
                    // nor clear: `line` holds the ENCLOSING paragraph's text
                    // (e.g. prose before an inline comment), which continues
                    // after the subtree closes.
                    b"p" | b"h" if skip == 0 => {
                        let taken = std::mem::take(&mut line);
                        if !taken.trim().is_empty() {
                            out.push(taken.trim_end().to_string());
                        }
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => {
                // Malformed markup: drop the partial line so ciphertext/junk
                // never lands in the index; cleanly closed paragraphs kept.
                line.clear();
                break;
            }
            _ => {}
        }
    }
    if saw_elem && !line.trim().is_empty() {
        out.push(line.trim_end().to_string());
    }
    Ok(out.join("\n"))
}

/// Decode a `\'hh` escape as Windows-1252, RTF's default codepage. The 0x80–0x9F
/// block is where Word puts the punctuation it writes constantly — `\'92` is the
/// apostrophe in every contraction, `\'93`/`\'94` the curly quotes — and mapping
/// those bytes as raw Latin-1 would inject invisible C1 control characters into
/// the index instead ("don\u{92}t" would never match a search for "don't").
/// 0xA0–0xFF is identical to Latin-1; the five undefined bytes pass through.
fn cp1252_char(b: u8) -> char {
    match b {
        0x80 => '€',
        0x82 => '‚',
        0x83 => 'ƒ',
        0x84 => '„',
        0x85 => '…',
        0x86 => '†',
        0x87 => '‡',
        0x88 => 'ˆ',
        0x89 => '‰',
        0x8A => 'Š',
        0x8B => '‹',
        0x8C => 'Œ',
        0x8E => 'Ž',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '•',
        0x96 => '–',
        0x97 => '—',
        0x98 => '˜',
        0x99 => '™',
        0x9A => 'š',
        0x9B => '›',
        0x9C => 'œ',
        0x9E => 'ž',
        0x9F => 'Ÿ',
        other => other as char,
    }
}

/// Minimal RTF-to-text. RTF is ASCII with `\control` words and `{group}`
/// nesting; recover the prose by dropping control words, skipping the ignorable
/// destinations that hold no body text (font/color/stylesheet tables and any
/// `{\*..}` group), decoding `\'hh` bytes (cp1252) and `\uN` unicode, and
/// turning `\par`/`\line`/`\sect` into newlines. Formatting is lost; content is
/// recovered. Pure char iteration — it can degrade but never panics.
fn extract_rtf(buf: &[u8]) -> anyhow::Result<String> {
    let text = String::from_utf8_lossy(buf);
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::new();
    let mut depth: i32 = 0;
    // When inside an ignorable destination, the group depth at which it began;
    // skip content until the matching close pops us back above it.
    let mut ignore_from: Option<i32> = None;
    let ignoring = |ignore_from: &Option<i32>| ignore_from.is_some();
    // \ucN: how many fallback units follow each \uN escape. Spec default is 1,
    // but macOS writers (TextEdit, Notes, Mail) set \uc0 — no fallback at all —
    // and skipping one anyway would eat a real character after every escape.
    // (Spec-fully this is group-scoped state; real files set it once, so a
    // single value is the standard lightweight treatment.)
    let mut uc: usize = 1;

    let mut i = 0;
    while i < n {
        // The final clamp cuts at MAX_EXTRACT_BYTES, so once the budget is met
        // further parsing cannot change the result — stop, which also bounds
        // work on files that are mostly embedded-object hex.
        if out.len() > MAX_EXTRACT_BYTES {
            break;
        }
        let c = chars[i];
        match c {
            '{' => {
                depth += 1;
                i += 1;
            }
            '}' => {
                depth -= 1;
                if let Some(d) = ignore_from {
                    if depth < d {
                        ignore_from = None;
                    }
                }
                i += 1;
            }
            '\\' => {
                if i + 1 >= n {
                    i += 1;
                    continue;
                }
                let next = chars[i + 1];
                // Escaped literal brace / backslash.
                if matches!(next, '\\' | '{' | '}') {
                    if !ignoring(&ignore_from) {
                        out.push(next);
                    }
                    i += 2;
                    continue;
                }
                // \'hh — a raw byte in hex (cp1252/latin-1 range).
                if next == '\'' {
                    if i + 3 < n
                        && chars[i + 2].is_ascii_hexdigit()
                        && chars[i + 3].is_ascii_hexdigit()
                    {
                        if !ignoring(&ignore_from) {
                            let hi = chars[i + 2].to_digit(16).unwrap_or(0);
                            let lo = chars[i + 3].to_digit(16).unwrap_or(0);
                            let ch = cp1252_char((hi * 16 + lo) as u8);
                            // \'00-\'1f and the undefined cp1252 bytes decode
                            // to control chars — no prose, keep them out of
                            // the index (tab/newline stay meaningful).
                            if !ch.is_control() || ch == '\t' || ch == '\n' {
                                out.push(ch);
                            }
                        }
                        i += 4;
                    } else {
                        i += 2;
                    }
                    continue;
                }
                // A control WORD: letters, optional signed number, one optional
                // trailing space that delimits (and is not content).
                if next.is_ascii_alphabetic() {
                    let mut j = i + 1;
                    let mut word = String::new();
                    while j < n && chars[j].is_ascii_alphabetic() {
                        word.push(chars[j]);
                        j += 1;
                    }
                    let mut param = String::new();
                    if j < n && (chars[j] == '-' || chars[j].is_ascii_digit()) {
                        if chars[j] == '-' {
                            param.push('-');
                            j += 1;
                        }
                        while j < n && chars[j].is_ascii_digit() {
                            param.push(chars[j]);
                            j += 1;
                        }
                    }
                    if j < n && chars[j] == ' ' {
                        j += 1;
                    }
                    match word.as_str() {
                        // Destinations whose groups carry no body prose.
                        "fonttbl" | "colortbl" | "stylesheet" | "filetbl" | "listtable"
                        | "listoverridetable" | "revtbl" | "rsidtbl" | "generator" | "info"
                        | "themedata" | "colorschememapping" | "datastore" | "pict" | "object" => {
                            if !ignoring(&ignore_from) {
                                ignore_from = Some(depth);
                            }
                        }
                        // \binN: N RAW bytes follow (embedded object/picture
                        // data). They are not RTF — braces inside them would
                        // corrupt the group depth — so skip them wholesale.
                        // Matched BEFORE the ignoring guard because \bin lives
                        // inside \pict groups, exactly where we're ignoring.
                        // (Byte count can drift on lossily-decoded input; the
                        // clamp to the buffer keeps the skip safe regardless.)
                        "bin" => {
                            let skip = param.parse::<usize>().unwrap_or(0);
                            // saturating: a hostile \bin18446744073709551615
                            // would overflow-panic under dev/test profiles.
                            j = j.saturating_add(skip).min(n);
                        }
                        _ if ignoring(&ignore_from) => {}
                        // \ucN retunes the fallback-unit count for later \uN.
                        // Honored only outside ignored destinations, which also
                        // approximates its group-scoped semantics. Clamped: real
                        // values are 0..2, and this bounds the skip loop.
                        "uc" => uc = param.parse::<usize>().unwrap_or(1).min(8),
                        "par" | "line" | "sect" | "row" => out.push('\n'),
                        "tab" | "cell" => out.push('\t'),
                        "u" => {
                            if let Ok(code) = param.parse::<i32>() {
                                let scalar = if code < 0 {
                                    (code + 65536) as u32
                                } else {
                                    code as u32
                                };
                                if let Some(ch) = char::from_u32(scalar) {
                                    out.push(ch);
                                }
                            }
                            // Skip the \ucN fallback units that follow (0 for
                            // \uc0 files — skipping anyway ate a real char).
                            // A unit is one plain char or one whole \'hh escape
                            // (decoding the escape too would double the char:
                            // "caf\u233\'e9" -> "caféé"). A control word or
                            // group brace is never a fallback.
                            let mut remaining = uc;
                            while remaining > 0 && j < n {
                                if chars[j] == '\\' {
                                    if j + 1 < n && chars[j + 1] == '\'' {
                                        j += 2;
                                        if j + 1 < n
                                            && chars[j].is_ascii_hexdigit()
                                            && chars[j + 1].is_ascii_hexdigit()
                                        {
                                            j += 2;
                                        }
                                        remaining -= 1;
                                    } else {
                                        break;
                                    }
                                } else if matches!(chars[j], '{' | '}') {
                                    break;
                                } else {
                                    j += 1;
                                    remaining -= 1;
                                }
                            }
                        }
                        _ => {}
                    }
                    i = j;
                    continue;
                }
                // A control SYMBOL: a single non-alphabetic char after '\'.
                match next {
                    '*' => {
                        // Marks the enclosing group as an ignorable destination.
                        if !ignoring(&ignore_from) {
                            ignore_from = Some(depth);
                        }
                    }
                    '~' => {
                        if !ignoring(&ignore_from) {
                            out.push(' ');
                        }
                    }
                    '\r' | '\n' => {
                        if !ignoring(&ignore_from) {
                            out.push('\n');
                        }
                    }
                    _ => {}
                }
                i += 2;
            }
            '\r' | '\n' => {
                // Raw newlines in the RTF source are not content.
                i += 1;
            }
            _ => {
                if !ignoring(&ignore_from) {
                    out.push(c);
                }
                i += 1;
            }
        }
    }
    Ok(out
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n"))
}

fn extract_by_ext(abs: &Path, ext: &str) -> anyhow::Result<String> {
    match ext {
        ".pdf" => {
            let buf = fs::read(abs)?;
            let text = extract_pdf_with_ocr(&buf)?;
            // Reconstruct any confident tables from the (real) text layer and
            // append them as markdown so the grid flows through retrieval. A
            // scanned/OCR'd PDF has no text-layer glyphs, so this is a no-op
            // there — reconstruction never runs on recognized image text.
            Ok(append_pdf_tables(text, &buf, abs))
        }
        // extract_docx routes OLE containers (renamed legacy .doc, protected
        // packages) to the salvage path itself, so both extensions share it.
        ".doc" | ".docx" => extract_docx(&fs::read(abs)?),
        // .xlsm is a macro-enabled workbook — same OOXML container as .xlsx,
        // read identically by calamine.
        ".xlsx" | ".xlsm" | ".xls" => extract_xlsx(abs),
        ".parquet" => extract_parquet(abs),
        ".pptx" => extract_pptx(&fs::read(abs)?),
        // .odt (text) and .odp (presentation) share the ODF content.xml schema.
        ".odt" | ".odp" => extract_odf(&fs::read(abs)?),
        ".rtf" => extract_rtf(&fs::read(abs)?),
        _ if is_ocr_image_ext(ext) => extract_image(abs),
        _ => Ok(String::new()),
    }
}

// --- on-disk cache (parse once per file version) ---

/// Cache schema version — bump when extraction logic changes in a way that
/// could alter output. Matches the TS cache so the two engines share entries.
/// v3: docx whitespace fidelity (Empty-event tabs/breaks) + .doc salvage.
/// v4: Excel datetime cells render as ISO 8601 instead of raw serials.
/// v5: Excel dates honor the workbook date-system (1904 files were ~4y early);
///     .xlsm is now extracted as a workbook. Both invalidate v4 entries.
/// v6: pptx / odt / odp / rtf now extract text (were name-match-only). Only
///     adds content for those files; previously cached formats are unchanged.
/// v7: images extract via OCR and scanned PDFs get an OCR fallback. The bump
///     also re-extracts every pre-0.10 image-only PDF that was legitimately
///     cached as empty, curing them without user action.
/// v8: docx reads footnotes/endnotes/headers/footers, dedups mc:Fallback text
///     boxes, and survives a dead rels main-part target. The bump re-extracts
///     footnote/notes-heavy docx files that v7 legitimately cached as (near-)
///     empty, curing them without user action.
/// v9: PDFs reconstruct confident tables from the text layer and append them as
///     markdown (add-pdf-tables). The bump re-extracts existing text PDFs once
///     so their tables appear; PDFs with no reconstructable grid are unchanged.
/// v10: the cost meter (openspec: add-beam-loop §3.3) adds a `cost` field to the
///     final chunk's `ChunkMeta`, which the answer cache persists — a shared
///     cached-answer wire-shape change. Extraction output itself is unchanged;
///     the lockstep bump (ts-twin.md rule 4) keeps the shared cache-schema
///     assertion green. The one-time re-extraction it triggers is harmless.
/// v11: the context manifest (openspec: add-beam-loop §5.4) adds a `manifest`
///     field to the final chunk's `ChunkMeta`, which the answer cache persists —
///     another shared cached-answer wire-shape change. Extraction output is
///     unchanged; the lockstep bump keeps the shared cache-schema assertion green
///     and the one-time re-extraction is harmless.
/// v12: the semantic layer (openspec: add-semantic-layer §3/§4) adds `certified`
///     + `trust` to the final chunk's `AnalyticsMeta`, which the answer cache
///     persists in `CachedAnswer.analytics` — another shared cached-answer
///     wire-shape change (the §5.2 semantic-registry key-material change rides
///     the same lockstep bump). The additive-optional fields keep old entries
///     readable; extraction output is unchanged and the re-extraction is harmless.
const CACHE_VERSION: u32 = 12;

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

    // Panic isolation around the whole parser dispatch: extraction runs in the
    // parallel scan pool, where an uncaught panic in a parser dependency would
    // abort the entire build batch instead of degrading one file (extract_pdf
    // self-guards; this covers the zip/xml/rtf/calamine paths symmetrically).
    // A panic is treated like a parse error: logged, NOT cached, retried on
    // the next scan.
    let parsed =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| extract_by_ext(abs, ext)))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("parser panicked")));
    let text = match parsed {
        Ok(t) => clamp(t.trim()),
        // OCR couldn't run (toggle off / models missing): expected, not an
        // error — no log spam, and crucially NOT cached, so the file
        // self-heals the moment OCR becomes available.
        Err(err) if err.downcast_ref::<crate::ocr::OcrUnavailable>().is_some() => {
            return String::new();
        }
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
    use super::{cell_text, excel_serial_to_iso};
    use calamine::{Data, ExcelDateTime, ExcelDateTimeType};

    #[test]
    fn datetime_cells_honor_the_workbook_date_system() {
        // 2020-01-01 in the 1900 system is serial 43831; in the 1904 system
        // the SAME real date is stored 1462 days lower (42369). Both must
        // render 2020-01-01 — the old raw-serial path rendered the 1904 file
        // as 2015-12-31 (~4 years early).
        let d1900 = Data::DateTime(ExcelDateTime::new(
            43_831.0,
            ExcelDateTimeType::DateTime,
            false,
        ));
        assert_eq!(cell_text(&d1900), "2020-01-01");
        let d1904 = Data::DateTime(ExcelDateTime::new(
            42_369.0,
            ExcelDateTimeType::DateTime,
            true,
        ));
        assert_eq!(cell_text(&d1904), "2020-01-01");
        // A datetime with a time component still renders date + time.
        let noon = Data::DateTime(ExcelDateTime::new(
            43_831.5,
            ExcelDateTimeType::DateTime,
            false,
        ));
        assert_eq!(cell_text(&noon), "2020-01-01 12:00:00");
    }

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
        assert_eq!(
            excel_serial_to_iso(43_831.0 + one_sec * 1.4),
            "2020-01-01 00:00:01"
        );
    }

    #[test]
    fn near_midnight_rolls_to_next_day() {
        // 43831 + 86399.6/86400 rounds up past midnight → date-only next day.
        assert_eq!(
            excel_serial_to_iso(43_831.0 + 86_399.6 / 86_400.0),
            "2020-01-02"
        );
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

    /// A footnote-heavy document (near-empty body, substance in
    /// word/footnotes.xml) used to extract as just the body — and that
    /// near-empty WAS cached. The 0.10 field report class.
    #[test]
    fn footnote_and_endnote_text_is_extracted() {
        let body = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body><w:p><w:r><w:t>See notes.</w:t></w:r></w:p></w:body>
</w:document>"#;
        let notes = r#"<?xml version="1.0"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:footnote><w:p><w:r><w:t>The retention window is 90 days per policy.</w:t></w:r></w:p></w:footnote>
</w:footnotes>"#;
        let ends = r#"<?xml version="1.0"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:endnote><w:p><w:r><w:t>Escalate to the on-call director.</w:t></w:r></w:p></w:endnote>
</w:endnotes>"#;
        let buf = zip_of(&[
            ("word/document.xml", body),
            ("word/footnotes.xml", notes),
            ("word/endnotes.xml", ends),
        ]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("See notes."), "{text:?}");
        assert!(text.contains("retention window is 90 days"), "{text:?}");
        assert!(
            text.contains("Escalate to the on-call director"),
            "{text:?}"
        );
        // Body first, notes after — previews stay anchored on the body.
        assert!(
            text.find("See notes.").unwrap() < text.find("retention window").unwrap(),
            "{text:?}"
        );
    }

    #[test]
    fn header_and_footer_text_is_extracted() {
        let body = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body><w:p><w:r><w:t>Body line.</w:t></w:r></w:p></w:body>
</w:document>"#;
        let header = r#"<?xml version="1.0"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:p><w:r><w:t>ACME Incident Response SOP</w:t></w:r></w:p>
</w:hdr>"#;
        let footer = r#"<?xml version="1.0"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:p><w:r><w:t>Confidential — internal use only</w:t></w:r></w:p>
</w:ftr>"#;
        let buf = zip_of(&[
            ("word/document.xml", body),
            ("word/header1.xml", header),
            ("word/footer1.xml", footer),
        ]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("ACME Incident Response SOP"), "{text:?}");
        assert!(
            text.contains("Confidential — internal use only"),
            "{text:?}"
        );
    }

    /// A rels officeDocument Target that doesn't exist in the archive used to
    /// hard-fail the WHOLE document at by_name — the "text-heavy docx says it
    /// can't be read" class. The resolver must fall back to the real part.
    #[test]
    fn a_dead_rels_target_falls_back_to_the_real_main_part() {
        let rels = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document9.xml"/>
</Relationships>"#;
        let buf = zip_of(&[("_rels/.rels", rels), ("word/document.xml", DOC_XML)]);
        let text = extract_docx(&buf).unwrap();
        assert!(text.contains("open the importer"), "{text:?}");
    }

    /// mc:AlternateContent carries a text box TWICE (modern mc:Choice drawing
    /// + legacy v:textbox mc:Fallback). Reading both double-counted it.
    #[test]
    fn alternate_content_text_boxes_are_not_read_twice() {
        let body = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
 <w:body>
  <w:p><mc:AlternateContent>
   <mc:Choice Requires="wps"><w:r><w:t>Datum plane</w:t></w:r></mc:Choice>
   <mc:Fallback><w:r><w:t>Datum plane</w:t></w:r></mc:Fallback>
  </mc:AlternateContent></w:p>
 </w:body>
</w:document>"#;
        let buf = zip_of(&[("word/document.xml", body)]);
        let text = extract_docx(&buf).unwrap();
        assert_eq!(text.matches("Datum plane").count(), 1, "{text:?}");
    }
}

#[cfg(test)]
mod doc_format_tests {
    use super::{extract_odf, extract_pptx, extract_rtf};
    use std::io::Write;

    /// Build a minimal zip (stored, no compression) from name→content pairs so
    /// the pptx/odf extractors can be exercised without fixture files on disk.
    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(content.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn pptx_reads_slide_runs_and_notes() {
        let slide = r#"<p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>
            <a:p><a:r><a:t>Reset the </a:t></a:r><a:r><a:t>firewall</a:t></a:r></a:p>
            <a:p><a:r><a:t>Then reboot</a:t></a:r></a:p>
            </p:spTree></p:cSld></p:sld>"#;
        let note =
            r#"<p:notes xmlns:a="x"><a:p><a:r><a:t>Escalate to tier 2</a:t></a:r></a:p></p:notes>"#;
        let buf = zip_of(&[
            ("ppt/slides/slide1.xml", slide),
            ("ppt/notesSlides/notesSlide1.xml", note),
        ]);
        let text = extract_pptx(&buf).unwrap();
        // Runs inside one paragraph join without a break.
        assert!(text.contains("Reset the firewall"), "got: {text}");
        assert!(text.contains("Then reboot"));
        // Speaker notes — where procedures often live — are included.
        assert!(text.contains("Escalate to tier 2"));
    }

    #[test]
    fn pptx_orders_slides_numerically() {
        let s =
            |t: &str| format!(r#"<p:sld xmlns:a="x"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let buf = zip_of(&[
            ("ppt/slides/slide10.xml", &s("TENTH")),
            ("ppt/slides/slide2.xml", &s("SECOND")),
        ]);
        let text = extract_pptx(&buf).unwrap();
        let second = text.find("SECOND").unwrap();
        let tenth = text.find("TENTH").unwrap();
        assert!(second < tenth, "slide2 must precede slide10: {text}");
    }

    #[test]
    fn odf_reads_paragraphs_headings_and_whitespace() {
        let content = r#"<office:document-content xmlns:office="a" xmlns:text="b">
            <office:body><office:text>
            <text:h>Password Policy</text:h>
            <text:p>Rotate every <text:span>90</text:span> days.</text:p>
            <text:p>Escalate<text:tab/>immediately.</text:p>
            </office:text></office:body></office:document-content>"#;
        let buf = zip_of(&[("content.xml", content)]);
        let text = extract_odf(&buf).unwrap();
        assert!(text.contains("Password Policy"));
        // Spans inside a paragraph stay on one line.
        assert!(text.contains("Rotate every 90 days."), "got: {text}");
        // <text:tab/> becomes a tab.
        assert!(text.contains("Escalate\timmediately."), "got: {text:?}");
    }

    #[test]
    fn rtf_strips_control_words_tables_and_decodes_escapes() {
        let rtf = r#"{\rtf1\ansi\deff0 {\fonttbl{\f0\froman Times;}}{\*\generator Word}\f0\fs24 Hello \b world\b0\par Second\'2c line\par}"#;
        let text = extract_rtf(rtf.as_bytes()).unwrap();
        assert!(text.contains("Hello world"), "got: {text}");
        // \'2c is a comma.
        assert!(
            text.contains("Second, line"),
            "hex escape not decoded: {text}"
        );
        // Font/color/generator destinations must not bleed into the text.
        assert!(
            !text.contains("fonttbl") && !text.contains("Times") && !text.contains("generator")
        );
    }

    #[test]
    fn rtf_decodes_unicode_escape_and_skips_fallback() {
        // café — é is U+00E9 = 233, written \u233 with an ASCII '?' fallback.
        let text = extract_rtf(r#"{\rtf1 caf\u233?}"#.as_bytes()).unwrap();
        assert_eq!(text.trim(), "café", "got: {text:?}");
    }

    #[test]
    fn malformed_containers_error_not_panic() {
        assert!(extract_pptx(b"definitely not a zip").is_err());
        assert!(extract_odf(b"definitely not a zip").is_err());
        // RTF never errors — worst case it recovers nothing.
        assert!(extract_rtf(b"no braces here at all").is_ok());
    }

    // --- realistic structure: the chrome real Office/LibreOffice files carry ---

    #[test]
    fn pptx_ignores_run_and_body_properties() {
        // Real slides wrap runs in <p:txBody>/<a:bodyPr> and prefix each run
        // with <a:rPr> formatting — none of which is body text.
        let slide = r#"<p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree><p:sp><p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US" b="1"/><a:t>Firewall </a:t></a:r><a:r><a:rPr lang="en-US"/><a:t>runbook</a:t></a:r></a:p>
            </p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#;
        let text = extract_pptx(&zip_of(&[("ppt/slides/slide1.xml", slide)])).unwrap();
        assert_eq!(text.trim(), "Firewall runbook", "got: {text:?}");
    }

    #[test]
    fn odf_does_not_leak_automatic_styles() {
        // content.xml opens with an automatic-styles block; its style defs must
        // never surface as text (they carry no char data, but prove it).
        let content = r#"<office:document-content xmlns:office="a" xmlns:text="b" xmlns:style="c">
            <office:automatic-styles>
              <style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>
            </office:automatic-styles>
            <office:body><office:text>
              <text:p text:style-name="P1">Escalate<text:s text:c="2"/>now.</text:p>
            </office:text></office:body></office:document-content>"#;
        let text = extract_odf(&zip_of(&[("content.xml", content)])).unwrap();
        assert!(text.contains("Escalate"), "got: {text:?}");
        assert!(text.contains("now."));
        assert!(
            !text.contains("P1") && !text.contains("paragraph") && !text.contains("font-weight")
        );
    }

    #[test]
    fn rtf_realistic_header_and_nested_groups() {
        // The shape a real WordPad/Word .rtf carries: ansicpg, \uc1, \viewkind,
        // \pard, nested font/color tables, a \*\generator destination. Real
        // newlines (\n) follow \par exactly as Word writes them — a control
        // word must be delimiter-terminated, never glued to the next token.
        let rtf = "{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\
            {\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\
            {\\colortbl ;\\red0\\green0\\blue0;}\
            {\\*\\generator Riched20 10.0.19041}\\viewkind4\\uc1\n\
            \\pard\\sa200\\sl276\\f0\\fs22 Reset the \\b firewall\\b0  and reboot.\\par\n\
            Retention is \\u8722?90 days.\\par}";
        let text = extract_rtf(rtf.as_bytes()).unwrap();
        assert!(
            text.contains("Reset the firewall and reboot."),
            "got: {text:?}"
        );
        // U+2212 is the minus sign, written 蜢; its '?' fallback is skipped.
        assert!(
            text.contains("Retention is \u{2212}90 days."),
            "unicode/fallback: {text:?}"
        );
        assert!(
            !text.contains("Calibri") && !text.contains("Riched20") && !text.contains("colortbl")
        );
    }

    // --- hardening (adversarial review): hostile and messy real-world inputs ---

    #[test]
    fn rtf_decodes_cp1252_smart_punctuation() {
        // \'92 is the apostrophe Word writes in every contraction; \'93/\'94
        // the curly quotes. Raw Latin-1 would map these to invisible C1
        // controls and "don't" would never match a search again.
        let text = extract_rtf(br#"{\rtf1 don\'92t say \'93stop\'94 \'96 ever}"#).unwrap();
        assert_eq!(
            text.trim(),
            "don\u{2019}t say \u{201C}stop\u{201D} \u{2013} ever",
            "cp1252 mapping"
        );
    }

    #[test]
    fn rtf_unicode_fallback_written_as_hex_escape_is_not_doubled() {
        // Some writers emit the \uN fallback as a \'hh escape of the same
        // character; decoding both would double it ("caféé").
        let text = extract_rtf(br#"{\rtf1 caf\u233\'e9 au lait}"#).unwrap();
        assert_eq!(text.trim(), "café au lait", "fallback doubled");
    }

    #[test]
    fn rtf_bin_payload_bytes_are_not_parsed_as_rtf() {
        // \bin4 announces 4 RAW bytes ("}}x{") that must not move the group
        // depth; the pict group then closes for real and B is still in scope.
        let text = extract_rtf(b"{\\rtf1 A{\\pict\\bin4 }}x{}B}").unwrap();
        assert_eq!(text.trim(), "AB", "raw \\bin bytes corrupted group depth");
    }

    #[test]
    fn odf_skips_inline_binary_data() {
        // Images can be inlined as base64 character data; that "text" must
        // never reach the index.
        let content = r#"<office:document-content xmlns:office="a" xmlns:text="b" xmlns:draw="c">
            <office:body><office:text>
            <text:p>Before image.</text:p>
            <text:p><draw:frame><draw:image><office:binary-data>AAECAwQFBgcICQoLDA0ODw==</office:binary-data></draw:image></draw:frame>After image.</text:p>
            </office:text></office:body></office:document-content>"#;
        let text = extract_odf(&zip_of(&[("content.xml", content)])).unwrap();
        assert!(text.contains("Before image."));
        assert!(
            text.contains("After image."),
            "text after the image kept: {text:?}"
        );
        assert!(!text.contains("AAECAwQ"), "inline base64 leaked: {text:?}");
    }

    #[test]
    fn odf_garbage_content_yields_empty_not_mojibake() {
        // An encrypted .odt keeps the zip layout but content.xml is
        // ciphertext: decoded lossily it is one giant element-less text node,
        // and must produce nothing rather than pollute the index.
        let garbage = "q9\u{fffd}\u{7f}J01k~\u{fffd}zR raw bytes, no xml here at all";
        let text = extract_odf(&zip_of(&[("content.xml", garbage)])).unwrap();
        assert_eq!(text, "", "ciphertext leaked into the index: {text:?}");
    }

    #[test]
    fn pptx_stops_reading_once_the_output_budget_is_met() {
        let s =
            |t: &str| format!(r#"<p:sld xmlns:a="x"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let big = "lorem ipsum ".repeat(60_000); // ~720 KB of text per slide
        let one = s(&format!("ONE {big}"));
        let two = s(&format!("TWO {big}"));
        let three = s("THREE");
        let buf = zip_of(&[
            ("ppt/slides/slide1.xml", &one),
            ("ppt/slides/slide2.xml", &two),
            ("ppt/slides/slide3.xml", &three),
        ]);
        let text = extract_pptx(&buf).unwrap();
        assert!(text.contains("ONE") && text.contains("TWO"));
        // Slides 1+2 already exceed the 1 MB extraction clamp, so slide 3 is
        // never read — the clamp would have cut it before it anyway.
        assert!(!text.contains("THREE"), "read past the output budget");
    }

    // --- second-pass review fixes ---

    #[test]
    fn rtf_uc0_files_do_not_lose_the_char_after_unicode() {
        // macOS writers (TextEdit, Notes, Mail) set \uc0: NO fallback follows
        // \uN. Unconditionally skipping one unit ate a real character after
        // every escape ("John's" -> "John'").
        let rtf: &[u8] = b"{\\rtf1\\uc0 John\\u8217s laptop}";
        let text = extract_rtf(rtf).unwrap();
        assert_eq!(text.trim(), "John\u{2019}s laptop", "\\uc0 ate a char");
    }

    #[test]
    fn rtf_uc2_skips_both_fallback_units() {
        let rtf: &[u8] = b"{\\rtf1\\uc2 x\\u8217??y}";
        let text = extract_rtf(rtf).unwrap();
        assert_eq!(text.trim(), "x\u{2019}y", "\\uc2 fallback leaked");
    }

    #[test]
    fn rtf_huge_bin_count_saturates_instead_of_overflowing() {
        // usize::MAX as the \bin param would overflow j + skip under the
        // dev/test profiles (overflow checks on) and abort the scan batch.
        let text = extract_rtf(b"{\\rtf1 ok \\bin18446744073709551615 junk}").unwrap();
        assert_eq!(text.trim(), "ok");
    }

    #[test]
    fn rtf_control_byte_escapes_do_not_pollute() {
        // \'00-\'1f decode to C0 controls — no prose, keep them out.
        let text = extract_rtf(br#"{\rtf1 a\'01\'02b}"#).unwrap();
        assert_eq!(text.trim(), "ab", "control bytes leaked: {text:?}");
    }

    /// Real-inference smoke test (task 4.2): drives the FULL public path
    /// (`extract_rich_text` → dispatch → `extract_image` → ocrs/rten) over the
    /// committed fixture screenshot. Ignored by default — it needs the models,
    /// which the asset-digests CI job fetches then runs via
    /// `cargo test -p lighthouse-core -- --ignored ocr_smoke` with
    /// `LIGHTHOUSE_OCR_MODELS_DIR` set. Locally: point that env at a dir holding
    /// the two .rten files.
    #[test]
    #[ignore = "requires the OCR models (LIGHTHOUSE_OCR_MODELS_DIR); run in CI or locally with models present"]
    fn ocr_smoke() {
        assert!(
            crate::ocr::available(),
            "OCR models not available — set LIGHTHOUSE_OCR_MODELS_DIR to a dir with text-detection.rten + text-recognition.rten"
        );
        let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr-smoke.png");
        let text = super::extract_rich_text(std::path::Path::new(fixture), ".png");
        let low = text.to_lowercase();
        assert!(
            low.contains("incident response"),
            "runbook heading missing: {text:?}"
        );
        assert!(
            low.contains("isolate the affected host"),
            "step 1 missing: {text:?}"
        );
        assert!(
            low.contains("escalate to the security lead"),
            "step 2 missing: {text:?}"
        );
        assert!(low.contains("90 days"), "retention line missing: {text:?}");
    }

    /// Real-inference smoke for the scanned-PDF path: wraps the fixture as a
    /// DCTDecode page image (what a scanner writes) and drives
    /// `pdf_ocr_fallback` → `decode_pdf_image` → ocrs/rten. Ignored like
    /// `ocr_smoke`; same env gate.
    #[test]
    #[ignore = "requires the OCR models (LIGHTHOUSE_OCR_MODELS_DIR)"]
    fn ocr_pdf_smoke() {
        assert!(crate::ocr::available(), "OCR models not available");
        let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ocr-smoke.png");
        let png = image::open(fixture).unwrap().to_rgb8();
        let (w, h) = png.dimensions();
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(png)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        let pdf = pdf_with_image(Some(("DCTDecode", jpeg.into_inner())), w as i64, h as i64);
        // Empty text layer (scan) ⇒ the fallback OCRs the page image.
        let text = super::pdf_ocr_fallback(String::new(), &pdf)
            .unwrap()
            .to_lowercase();
        // Assert on phrases that survive the fixture's PNG→JPEG re-compression
        // (this test double-compresses; native scanner JPEGs don't, so a real
        // scan recognizes even more cleanly — see the standalone spike).
        assert!(
            text.contains("incident response"),
            "pdf ocr heading: {text:?}"
        );
        assert!(
            text.contains("isolate the affected host"),
            "pdf ocr step 1: {text:?}"
        );
        assert!(text.contains("90 days"), "pdf ocr retention: {text:?}");
    }

    #[test]
    fn pdf_ocr_trigger_math() {
        // A scanned page yields ~0 chars; a text page yields hundreds.
        assert!(super::pdf_text_is_trivial(0, 1));
        assert!(super::pdf_text_is_trivial(31, 1));
        assert!(!super::pdf_text_is_trivial(32, 1));
        assert!(super::pdf_text_is_trivial(500, 100)); // 5 chars/page: scans
        assert!(!super::pdf_text_is_trivial(50_000, 100));
        assert!(super::pdf_text_is_trivial(0, 0)); // degenerate: pages.max(1)
    }

    fn jpeg_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 200, 200]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    /// Minimal one-page PDF carrying one image XObject (the shape a scanner
    /// writes). `filter=None` builds the page with NO image at all.
    fn pdf_with_image(filter: Option<(&str, Vec<u8>)>, w: i64, h: i64) -> Vec<u8> {
        use lopdf::{dictionary, Document, Object, Stream};
        let mut doc = Document::with_version("1.5");
        let mut xobjects = lopdf::Dictionary::new();
        if let Some((filter, content)) = filter {
            let img = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => w,
                    "Height" => h,
                    "ColorSpace" => "DeviceRGB",
                    "BitsPerComponent" => 8,
                    "Filter" => filter,
                },
                content,
            );
            let img_id = doc.add_object(img);
            xobjects.set("Im0", Object::Reference(img_id));
        }
        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => Object::Reference(content_id),
            "Resources" => dictionary! { "XObject" => xobjects },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn pdf_raster_enumeration_and_jpeg_decode() {
        let buf = pdf_with_image(Some(("DCTDecode", jpeg_bytes(120, 90))), 120, 90);
        let doc = lopdf::Document::load_mem(&buf).unwrap();
        let rasters = super::pdf_page_rasters(&doc);
        assert_eq!(rasters.len(), 1, "one page, one raster");
        let lopdf::Object::Stream(s) = doc.get_object(rasters[0]).unwrap() else {
            panic!("raster id must be a stream");
        };
        let img = super::decode_pdf_image(s).expect("DCTDecode must decode");
        assert_eq!((img.width(), img.height()), (120, 90));
    }

    #[test]
    fn pdf_oversized_image_is_a_decompression_bomb_skip() {
        // 60000×60000 = 3.6 GP, far past the 40 MP budget: the guard must
        // return None BEFORE decode, no matter the (tiny) declared content.
        assert!(crate::ocr::too_many_pixels(60_000, 60_000));
        assert!(!crate::ocr::too_many_pixels(2500, 3300)); // an A4 300dpi scan
        let buf = pdf_with_image(Some(("FlateDecode", vec![0u8; 16])), 60_000, 60_000);
        let doc = lopdf::Document::load_mem(&buf).unwrap();
        let rasters = super::pdf_page_rasters(&doc);
        assert_eq!(
            rasters.len(),
            1,
            "enumeration still sees it (metadata only)"
        );
        let lopdf::Object::Stream(s) = doc.get_object(rasters[0]).unwrap() else {
            panic!("stream expected");
        };
        assert!(super::decode_pdf_image(s).is_none(), "bomb must not decode");
    }

    #[test]
    fn pdf_unsupported_encodings_skip_and_cache_the_text_layer() {
        // CCITT fax scans are a declared v1 limit: the raster is SEEN (so the
        // page counts as a scan) but not decodable — the fallback returns the
        // text layer as a genuine, cacheable result instead of erroring.
        let buf = pdf_with_image(Some(("CCITTFaxDecode", vec![0u8; 64])), 100, 100);
        let doc = lopdf::Document::load_mem(&buf).unwrap();
        let rasters = super::pdf_page_rasters(&doc);
        assert_eq!(rasters.len(), 1);
        let lopdf::Object::Stream(s) = doc.get_object(rasters[0]).unwrap() else {
            panic!("stream expected");
        };
        assert!(
            super::decode_pdf_image(s).is_none(),
            "CCITT must not decode in v1"
        );
        if crate::ocr::available() {
            eprintln!("models present; skipping gate assertions");
            return;
        }
        // Even with OCR unavailable, an all-unsupported scan resolves to the
        // (empty) text layer *as an error-free result* once OCR is on; while
        // OCR is off, rasters present ⇒ OcrUnavailable ⇒ uncached.
        let err = super::pdf_ocr_fallback(String::new(), &buf).unwrap_err();
        assert!(
            err.downcast_ref::<crate::ocr::OcrUnavailable>().is_some(),
            "got: {err}"
        );
    }

    #[test]
    fn pdf_fallback_gate_decisions() {
        // Real text layer: never looks at rasters, never errors.
        let scan = pdf_with_image(Some(("DCTDecode", jpeg_bytes(80, 80))), 80, 80);
        let real_text = "word ".repeat(50); // 250 chars on 1 page: not trivial
        assert_eq!(
            super::pdf_ocr_fallback(real_text.clone(), &scan).unwrap(),
            real_text
        );

        // Trivial text but NO rasters: genuine near-empty text PDF — cached.
        let no_image = pdf_with_image(None, 0, 0);
        assert_eq!(
            super::pdf_ocr_fallback(String::new(), &no_image).unwrap(),
            ""
        );

        // Trivial text + rasters + OCR unavailable: uncached marker error.
        if crate::ocr::available() {
            eprintln!("models present; skipping unavailable-path assertion");
            return;
        }
        let err = super::pdf_ocr_fallback(String::new(), &scan).unwrap_err();
        assert!(
            err.downcast_ref::<crate::ocr::OcrUnavailable>().is_some(),
            "got: {err}"
        );
    }

    #[test]
    fn odf_excludes_tracked_deletions_and_comments() {
        // Deleted-but-tracked text and reviewer comments are not visible body
        // prose; a user who removed confidential text must not find it
        // resurfacing in search results.
        let content = r#"<office:document-content xmlns:office="a" xmlns:text="b">
            <office:body><office:text>
            <text:tracked-changes><text:changed-region><text:deletion>
                <text:p>OLD SECRET PASSAGE</text:p>
            </text:deletion></text:changed-region></text:tracked-changes>
            <text:p>Visible policy text.</text:p>
            <text:p>Also visible<office:annotation><text:p>reviewer gripe</text:p></office:annotation> tail.</text:p>
            </office:text></office:body></office:document-content>"#;
        let text = extract_odf(&zip_of(&[("content.xml", content)])).unwrap();
        assert!(text.contains("Visible policy text."));
        // Prose around an inline comment stays one paragraph.
        assert!(text.contains("Also visible tail."), "got: {text:?}");
        assert!(
            !text.contains("OLD SECRET"),
            "deleted text indexed: {text:?}"
        );
        assert!(
            !text.contains("reviewer gripe"),
            "comment indexed: {text:?}"
        );
    }

    /// A real (unencrypted) PDF whose page lays out a 3-column grid via absolute
    /// text-matrix placement and a standard Helvetica font — enough for
    /// pdf-extract to decode positioned glyphs and the table pass to rebuild it.
    fn pdf_with_text_grid() -> Vec<u8> {
        use lopdf::{dictionary, Document, Object, Stream};
        let mut doc = Document::with_version("1.5");
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });
        let ops = concat!(
            "BT\n/F1 10 Tf\n",
            "1 0 0 1 100 700 Tm (Region) Tj\n",
            "1 0 0 1 250 700 Tm (Q2) Tj\n",
            "1 0 0 1 350 700 Tm (Q3) Tj\n",
            "1 0 0 1 100 680 Tm (NE) Tj\n",
            "1 0 0 1 250 680 Tm (120) Tj\n",
            "1 0 0 1 350 680 Tm (150) Tj\n",
            "1 0 0 1 100 660 Tm (SE) Tj\n",
            "1 0 0 1 250 660 Tm (300) Tj\n",
            "1 0 0 1 350 660 Tm (480) Tj\n",
            "ET",
        );
        let content_id = doc.add_object(Stream::new(dictionary! {}, ops.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => Object::Reference(content_id),
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference(font_id) },
            },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn pdf_text_grid_is_reconstructed_end_to_end() {
        let buf = pdf_with_text_grid();
        let tables = crate::pdf_tables::extract_tables(&buf);
        assert_eq!(tables.len(), 1, "one grid on the page");
        assert_eq!(tables[0].rows[0], vec!["Region", "Q2", "Q3"]);
        assert!(
            tables[0].rows.iter().any(|r| r == &["SE", "300", "480"]),
            "SE row rebuilt with its own cells: {:?}",
            tables[0].rows
        );

        // And the grid rides into the extracted text as GFM markdown.
        let md = super::append_pdf_tables(
            "prose above".into(),
            &buf,
            std::path::Path::new("q3-deck.pdf"),
        );
        assert!(md.contains("## Tables detected in q3-deck.pdf"), "{md}");
        assert!(md.contains("| Region | Q2 | Q3 |"), "{md}");
        assert!(md.contains("| SE | 300 | 480 |"), "{md}");
    }

    #[test]
    fn pdf_without_grid_leaves_text_untouched() {
        // An unreadable/gridless PDF reconstructs nothing: the text layer is
        // returned byte-identical (fail closed).
        assert!(crate::pdf_tables::extract_tables(b"%PDF-not-a-real-doc").is_empty());
        let unchanged = super::append_pdf_tables(
            "just prose".into(),
            b"%PDF-not-a-real-doc",
            std::path::Path::new("x.pdf"),
        );
        assert_eq!(unchanged, "just prose", "no grid ⇒ text unchanged");
    }
}
