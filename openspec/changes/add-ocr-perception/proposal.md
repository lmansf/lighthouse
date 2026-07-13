# OCR perception: the vault reads images and scans (0.10.0)

## Why

The 0.9.0 capability map confirmed the single biggest blind spot in the vault: **images and scanned documents contribute nothing to retrieval**. A PNG/JPG indexes by filename only; a scanned (image-only) PDF extracts to an empty string that is then cached as a genuine result. For the SOP-consolidation persona this is fatal — screenshots of consoles, photographed whiteboards, and scanner-produced PDFs are *most* of a messy how-to corpus. And it is exactly the content that cannot be sent to a cloud vision API (infra diagrams, badge photos, network maps), which makes on-device OCR not a nice-to-have but the only acceptable design — and a moat.

Feasibility is already proven, not assumed:

- **Pure-Rust stack, zero native deps**: `ocrs` 0.12.2 + `rten` 0.24 (both `MIT OR Apache-2.0`) compile clean in our toolchain (spiked in-sandbox against the exact API: `Model::load`, `OcrEngine::prepare_input`/`get_text`). No tesseract/leptonica/onnxruntime to build or bundle per-OS.
- **Models are small and pinned**: `text-detection.rten` 2,510,284 B (sha256 `f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca`), `text-recognition.rten` 9,716,568 B (sha256 `e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e`) — ~12 MB installer growth, bundled like the TTS/embed models.
- **Both helper crates are already in the tree**: `image` 0.25.10 (decode) and `lopdf` 0.34 (PDF image streams) resolve today via Tauri/pdf-extract.

## What Changes

- **Image files gain content**: `.png .jpg .jpeg .webp .bmp .tif .tiff` join `RICH_EXT` (Rust engine); a new `ocr.rs` module runs the bundled detection+recognition models over the decoded bitmap and returns the recognized lines as prose, which flows through the normal chunker/index/retrieval like any document text.
- **Scanned PDFs stop being invisible**: when `extract_pdf`'s text layer yields (near-)nothing for a PDF that carries raster page images, the extractor pulls the embedded page images via `lopdf` (JPEG/`DCTDecode` and `FlateDecode` RGB/Gray in v1) and OCRs them in page order. This also retires the 0.9.0-era trap where image-only PDFs cached empty forever (cache schema v6 → v7 re-extracts them once).
- **Bounded by design**: images are downscaled to a pixel budget before inference; PDFs OCR at most a fixed page budget; a small global semaphore keeps OCR from saturating the scan pool; a `prose_like`-style line filter (same philosophy as the `.doc` salvage) keeps low-confidence photo garbage out of the index.
- **User control**: a Preferences toggle "Read text in images (OCR)" (default on). While off, image/scan extraction returns empty *without caching*, so flipping it on later re-reads everything with no cache surgery.
- **Distribution like every other model**: `fetch-local-model.mjs` gains `fetchOcr()` with the pinned digests above, mirror-first from `hf-assets`-style release assets with the upstream S3 bucket as fallback; `mirror-hf-assets.yml` learns to mirror direct-URL assets so builds never depend on a third-party host. Bundled under `resources/ocr` via `tauri.conf.json`.

## Capabilities

### New Capabilities
- `ocr-extraction`: recognizing text in image files and image-only PDFs, on device, budgeted, and cached.

### Modified Capabilities
<!-- none — retrieval/chunking/citations consume OCR text unchanged -->

## Impact

- New `native/crates/lighthouse-core/src/ocr.rs` (engine lifecycle, budgets, line filter); `extract.rs` (RICH_EXT additions, image path, scanned-PDF fallback, `CACHE_VERSION` 6→7); `config.rs` (models-dir resolution); `settings` plumbing for the toggle (routes.rs + commands.rs + Preferences UI).
- `native/crates/lighthouse-desktop`: resolve the bundled `resources/ocr` path at boot (same pattern as llm/tts/embed) and export it to the engine; `tauri.conf.json` bundle resources.
- `scripts/fetch-local-model.mjs` (+ digests), `.github/workflows/mirror-hf-assets.yml` (direct-URL mirroring), `.github/workflows/asset-digests.yml` (OCR smoke test against a committed fixture image).
- Third-party notices: add ocrs + rten (crate code `MIT OR Apache-2.0`); **verify and record the model-weights license/attribution before ship** (open question below).
- TS twin: **PARITY divergence, Rust-only** — like embeddings, `.doc`, and `.parquet`. The dev twin has no ML runtime; image extensions stay name-match-only there with a PARITY comment.

## Non-goals

- **No cloud OCR, ever** — on-device only; that is the point.
- **No CCITT G4 / JBIG2 decode in v1** (fax-style enterprise scans): logged and left name-findable; the cache-version bump path lets a later version pick them up.
- **No HEIC/HEIF** (unsupported by the `image` crate) and **no GIF** (animation noise).
- **No image captioning / diagram understanding** — that is the separate "diagram description" stretch item on the roadmap, likely via a local vision model, not this change.
- **No handwriting promises** — the models are print-oriented; handwriting recall is best-effort and not a requirement.
- **No OCR UI beyond the toggle** — no thumbnails, no per-file OCR status view, no re-OCR button.
- **No TS-twin OCR.**
