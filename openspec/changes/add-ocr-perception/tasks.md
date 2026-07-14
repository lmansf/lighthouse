# Tasks — add-ocr-perception

## 1. Engine core (ocr.rs + extract.rs)

- [x] 1.1 Add workspace deps: `ocrs = "0.12"`, `rten = "0.24"`, `image = "0.25"` (already transitively resolved; now direct for lighthouse-core). `cargo check -p lighthouse-core -p lighthouse-server` stays clean.
- [x] 1.2 `ocr.rs`: models-dir resolution (`LIGHTHOUSE_OCR_MODELS_DIR` → dev fallback `resources/ocr`), `OnceLock<Option<OcrEngine>>` lazy init with one-shot disable logging, `recognize(rgb, w, h) -> String`, semaphore(2), budget consts (`MAX_OCR_EDGE` 2048, `MIN_IMAGE_EDGE` 64, `MAX_OCR_PAGES_PER_PDF` 32), `prose_like`-style line filter. Unit tests: filter keeps prose / drops confetti; budget math; missing-dir → disabled (no panic).
- [x] 1.3 `extract.rs`: add `.png .jpg .jpeg .webp .bmp .tif .tiff` to `RICH_EXT` (Rust only); `extract_image` (decode → RGB8 → downscale → recognize); dispatch arms. Toggle-off and models-missing return empty **uncached**; decode/inference errors follow the existing failure-not-cached path.
- [x] 1.4 Scanned-PDF fallback in `extract_pdf`: trigger = text yield < 32 chars/page AND raster XObjects present (lopdf); per page take the largest image XObject, decode `DCTDecode` (raw JPEG) and `FlateDecode` DeviceRGB/DeviceGray; skip other filters with a counted log; page budget; page texts joined `\n\n`. Unit tests with tiny synthetic PDFs (text-layer PDF never triggers; image PDF triggers; CCITT-only skips → cached empty).
- [x] 1.5 `CACHE_VERSION` 6 → 7 in `extract.rs` AND `src/server/extract.ts` (lockstep rule; TS gains the PARITY comment naming this change). Comment the v7 line: cures pre-0.10 cached-empty scanned PDFs.

## 2. Settings toggle (engine → shell → UI)

- [x] 2.1 `ocr_enabled` (default true) in the settings store; wired through routes.rs + commands.rs; extraction consults it per file.
- [x] 2.2 Contracts: N/A — the settings bools (`semanticSearch`, `backgroundConserve`, now `ocrEnabled`) are not in the typed `src/contracts` layer; they round-trip via the raw `/api/settings` fetch, so there is no contract/mock to update. Confirmed against the two existing toggles.
- [x] 2.3 Preferences dialog: "Read text in images (OCR)" checkbox + "Scans and screenshots become searchable. Happens on this device; nothing is uploaded."

## 3. Distribution & shell

- [x] 3.1 `fetch-local-model.mjs`: `fetchOcr()` into `resources/ocr/` — pinned digests `f15cfb56…b5ca` (detection, 2,510,284 B) and `e484866d…5a6e` (recognition, 9,716,568 B), `downloadWithFallback(mirror, upstream)`; upstream `https://ocrs-models.s3-accelerate.amazonaws.com/`.
- [x] 3.2 `mirror-hf-assets.yml`: direct-URL mirroring mode (download on runner + verify pinned digest + upload to the mirror tag) for the two `.rten` files; run it once so the mirror is populated before the release build.
- [x] 3.3 `tauri.conf.json`: bundle `"../../../resources/ocr": "ocr"`. No new shell env needed — `ocr.rs` resolves `resources_dir().join("ocr")` exactly like embed/tts, and the shell already exports `LIGHTHOUSE_RESOURCES_PATH`. `LIGHTHOUSE_OCR_MODELS_DIR` remains a test/CI override only.

## 4. CI, notices, fixtures

- [x] 4.1 Commit a fixture: `native/crates/lighthouse-core/tests/fixtures/ocr-smoke.png` (24 KB Chromium-rendered fake incident-response runbook with known phrases; generated content only). Placed under the crate so the Rust smoke test resolves it via `CARGO_MANIFEST_DIR`.
- [x] 4.2 `asset-digests.yml` verify mode: after the fetch, run an `#[ignore]`-gated `ocr_smoke` test (`cargo test -p lighthouse-core -- --ignored ocr_smoke` with `LIGHTHOUSE_OCR_MODELS_DIR` set) asserting the fixture's known phrases are recognized.
- [x] 4.3 Third-party notices: add ocrs + rten (MIT OR Apache-2.0). **Close open question #1**: verify the `.rten` weights' license/attribution; if redistribution is restricted, switch bundling → first-run download before ship.

## 5. Ship

- [x] 5.1 Full verification: `cargo test --workspace` (native/), `node --test "test/**/*.test.mjs"`, `tsc --noEmit`, `next lint`, static export; adversarial pass over `ocr.rs`/PDF-image path (malformed images, zip-bomb-class PDFs, budget bypasses) before merge.
- [x] 5.2 Release 0.10.0: bump 5 version files → PR → merge → release.yml → desktop-release.yml → publish + verify; release notes lead with "your screenshots and scans are now searchable — on your device".
