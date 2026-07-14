//! On-device OCR (add-ocr-perception): recognize printed text in images and
//! scanned-PDF pages with the bundled ocrs/rten models. Pure Rust — no
//! tesseract/onnxruntime — so it ships inside the installer like the GGUFs.
//!
//! Lifecycle: one engine per process, lazily built on first use. If the models
//! are absent (dev checkout that never ran fetch:model, partial install) the
//! engine latches to None and OCR is disabled for the session — logged ONCE,
//! never per file. Callers receive `OcrUnavailable`, which extract.rs treats
//! as "leave the file name-findable and do NOT cache", so a later scan with
//! models present self-heals.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use rten::Model;

/// Downscale bound: inference cost scales with pixel area; screenshots and
/// scans stay legible at this edge.
pub const MAX_OCR_EDGE: u32 = 2048;
/// Icons/thumbnails below this carry no prose — skipped without inference.
pub const MIN_IMAGE_EDGE: u32 = 64;
/// A 400-page scanned book must not monopolize a scan; the 1 MB extract clamp
/// would cut it long before this anyway.
pub const MAX_OCR_PAGES_PER_PDF: usize = 32;
/// Concurrent inferences. Extraction's rayon pool is width-of-cores; two
/// simultaneous OCR jobs keep first scans of image-heavy vaults from pinning
/// the machine (background-conserve gates WHEN scans run; this gates how hard).
const MAX_CONCURRENT_OCR: usize = 2;

/// Marker error: OCR could not run because it is disabled or the models are
/// missing. extract.rs downcasts this to skip both the failure log (expected,
/// not an error) and the cache write (so re-enabling self-heals).
#[derive(Debug)]
pub struct OcrUnavailable;

impl std::fmt::Display for OcrUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OCR unavailable (disabled or models missing)")
    }
}

impl std::error::Error for OcrUnavailable {}

/// The Preferences toggle ("Read text in images"). Settings plumbing calls
/// `set_enabled` at boot and on change; default on.
static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Where the two .rten models live. The desktop shell exports the bundled
/// resources/ocr path at boot; a dev checkout falls back to the repo-relative
/// dir that `npm run fetch:model` populates.
fn models_dir() -> PathBuf {
    match std::env::var("LIGHTHOUSE_OCR_MODELS_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => PathBuf::from("resources/ocr"),
    }
}

fn build_engine() -> Option<OcrEngine> {
    let dir = models_dir();
    let load = |name: &str| -> anyhow::Result<Model> {
        let bytes = std::fs::read(dir.join(name))?;
        Ok(Model::load(bytes)?)
    };
    let result = (|| -> anyhow::Result<OcrEngine> {
        let detection_model = load("text-detection.rten")?;
        let recognition_model = load("text-recognition.rten")?;
        OcrEngine::new(OcrEngineParams {
            detection_model: Some(detection_model),
            recognition_model: Some(recognition_model),
            ..Default::default()
        })
    })();
    match result {
        Ok(engine) => Some(engine),
        Err(err) => {
            // Once per session, not per file: absent models are a normal state
            // (dev checkouts, images-toggle users on old installs).
            eprintln!(
                "ocr: disabled for this session ({err}); images and scans stay findable by name (dir: {})",
                dir.display()
            );
            None
        }
    }
}

fn engine() -> Option<&'static OcrEngine> {
    static ENGINE: OnceLock<Option<OcrEngine>> = OnceLock::new();
    ENGINE.get_or_init(build_engine).as_ref()
}

/// True when OCR can actually run right now (toggle on AND models loaded).
pub fn available() -> bool {
    enabled() && engine().is_some()
}

/// Tiny counting semaphore (std has none): bounds concurrent inferences.
struct Gate {
    slots: Mutex<usize>,
    cv: Condvar,
}

impl Gate {
    fn acquire(&self) -> GateGuard<'_> {
        let mut slots = self.slots.lock().unwrap();
        while *slots == 0 {
            slots = self.cv.wait(slots).unwrap();
        }
        *slots -= 1;
        GateGuard(self)
    }
}

struct GateGuard<'a>(&'a Gate);

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        *self.0.slots.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

fn gate() -> &'static Gate {
    static GATE: OnceLock<Gate> = OnceLock::new();
    GATE.get_or_init(|| Gate {
        slots: Mutex::new(MAX_CONCURRENT_OCR),
        cv: Condvar::new(),
    })
}

/// Scale (w, h) down so the longest edge is ≤ max, preserving aspect. Returns
/// the input unchanged when already within budget.
pub(crate) fn fit_edge(w: u32, h: u32, max: u32) -> (u32, u32) {
    let edge = w.max(h);
    if edge <= max || edge == 0 {
        return (w, h);
    }
    let scale = max as f64 / edge as f64;
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

/// OCR on photos produces confetti ("~ | . iij"). Keep a recognized line only
/// when it looks like prose — same philosophy as the .doc salvage: ≥ 3 chars
/// and ≥ 60% alphanumeric-or-space content.
pub(crate) fn keep_line(line: &str) -> bool {
    let trimmed = line.trim();
    let total = trimmed.chars().count();
    if total < 3 {
        return false;
    }
    let good = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .count();
    good * 10 >= total * 6
}

/// Recognize printed text in a decoded image. Downscales to the pixel budget,
/// runs detection + recognition under the concurrency gate, and returns the
/// junk-filtered lines joined with newlines ("" is a genuine no-text result).
pub fn recognize_image(img: &image::DynamicImage) -> anyhow::Result<String> {
    if !available() {
        return Err(anyhow::Error::new(OcrUnavailable));
    }
    let (w, h) = (img.width(), img.height());
    if w.min(h) < MIN_IMAGE_EDGE {
        return Ok(String::new());
    }
    let (tw, th) = fit_edge(w, h, MAX_OCR_EDGE);
    let rgb = if (tw, th) == (w, h) {
        img.to_rgb8()
    } else {
        // Triangle: good quality/speed balance for downscaling text.
        image::imageops::resize(
            &img.to_rgb8(),
            tw,
            th,
            image::imageops::FilterType::Triangle,
        )
    };

    let engine = engine().ok_or_else(|| anyhow::Error::new(OcrUnavailable))?;
    let _slot = gate().acquire();
    let source = ImageSource::from_bytes(rgb.as_raw(), (tw, th))?;
    let input = engine.prepare_input(source)?;
    let text = engine.get_text(&input)?;
    Ok(text
        .lines()
        .filter(|l| keep_line(l))
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_filter_keeps_prose_and_drops_confetti() {
        assert!(keep_line("Escalate to tier two after 3 failures."));
        assert!(keep_line("Retention: 90 days"));
        assert!(keep_line("ok!")); // 3 chars, 2/3 alnum
        assert!(!keep_line("~ | ."));
        assert!(!keep_line("__--~~=="));
        assert!(!keep_line("a")); // too short
        assert!(!keep_line("   ")); // empty after trim
    }

    #[test]
    fn fit_edge_preserves_aspect_and_small_images() {
        assert_eq!(fit_edge(1000, 700, 2048), (1000, 700)); // within budget
        assert_eq!(fit_edge(4096, 2048, 2048), (2048, 1024));
        let (w, h) = fit_edge(3000, 4000, 2048);
        assert_eq!(h, 2048);
        assert_eq!(w, 1536); // 3000 * (2048/4000)
        assert_eq!(fit_edge(0, 0, 2048), (0, 0)); // degenerate input survives
    }

    #[test]
    fn without_models_ocr_reports_unavailable_and_toggle_flips() {
        // One test owns the global toggle + engine state (parallel-test safe:
        // nothing else mutates them).
        if engine().is_some() {
            eprintln!("models present in this checkout; skipping unavailable-path assertions");
            return;
        }
        assert!(!available());
        let img = image::DynamicImage::new_rgb8(200, 200);
        let err = recognize_image(&img).unwrap_err();
        assert!(err.downcast_ref::<OcrUnavailable>().is_some(), "got: {err}");

        set_enabled(false);
        assert!(!enabled());
        let err = recognize_image(&img).unwrap_err();
        assert!(err.downcast_ref::<OcrUnavailable>().is_some());
        set_enabled(true);
        assert!(enabled());
    }
}
