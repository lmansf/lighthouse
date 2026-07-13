# Design — add-ocr-perception

## Engine lifecycle

One `OcrEngine` per process, lazily built on first use behind a `OnceLock<Option<OcrEngine>>`:

- Model bytes load from the models dir (below). `Model::load` cost is paid once (~tens of ms) and the engine is reused across every file in every scan.
- If the dir or either model file is missing/corrupt (dev checkouts that never ran `fetch:model`, partial installs), the `OnceLock` stores `None`: OCR is **disabled for the session**, logged once to stderr — never per file. Extraction then behaves exactly like 0.9.0 (name-findable, no content), and — critically — returns empty **without caching**, so a later run with models present re-extracts everything.

Models dir resolution mirrors the other bundled resources: `LIGHTHOUSE_OCR_MODELS_DIR` env override → the desktop shell sets it at boot from the bundled `resources/ocr` path (same resolution `supervise.rs` already does for `llm`/`tts`/`embed`) → dev fallback `resources/ocr` relative to the repo root.

## Where OCR hooks into extraction

`extract.rs` stays the single router; `ocr.rs` is a leaf module like the other format parsers.

1. **Image files**: new `extract_image(abs)` — decode via `image` (`.png .jpg .jpeg .webp .bmp .tif .tiff`; TIFF = first page/frame), convert to RGB8, downscale if over the pixel budget, OCR, join recognized lines with newlines, apply the junk filter.
2. **Scanned PDFs**: `extract_pdf` keeps its text-layer pass. The OCR fallback triggers only when BOTH hold:
   - text-layer yield is trivial: `< 32 chars per page` averaged (a real text PDF trivially clears this; a scanned one is ~0), AND
   - the document actually embeds raster images (cheap `lopdf` scan of page-resource XObjects).
   Then, per page in order (up to the page budget): pull the largest image XObject on the page — `DCTDecode` streams are raw JPEG (decode via `image`); `FlateDecode` bitmaps rebuild from width/height/colorspace for DeviceRGB/DeviceGray. Other filters (CCITT, JBIG2, JPX) skip the page with a counted log line. Page texts join as `\n\n`-separated blocks so chunking sees paragraph structure.
3. Both paths run inside the existing `catch_unwind` wrapper from the 0.9.0 hardening — an ocrs/rten/image panic degrades that one file, never the scan batch.

## Measured baseline (in-sandbox spike, release build, CI-runner-class CPU)

End-to-end run against a Chromium-rendered 1000×700 fake-SOP screenshot:

- engine load (both models): **~16 ms**, once per session
- OCR inference: **~245 ms** per image
- recognition: **verbatim** — headings, steps, punctuation, and digits all exact

So a 1,000-screenshot vault costs ~4–5 minutes of background OCR on first scan at
semaphore(2); steady-state scans only touch changed files (mtime+size cache).

## Budgets (all constants in `ocr.rs`, tuned by the measured spike)

| Budget | Value | Why |
|---|---|---|
| `MAX_OCR_EDGE` | 2048 px | inference cost scales with area; downscale (preserving aspect) bounds worst-case latency and memory; screenshots/scans keep legibility at 2048 |
| `MAX_OCR_PAGES_PER_PDF` | 32 | a 400-page scanned book should not monopolize a scan; the 1 MB extract clamp would cut it anyway |
| `MIN_IMAGE_EDGE` | 64 px | icons/thumbnails carry no prose; skip without inference |
| OCR concurrency | semaphore(2) | extraction's rayon pool is width-of-cores; two concurrent inferences keep the machine responsive (0.7.2 background-conserve already gates *when* scans run; this gates *how hard*) |
| output | existing `MAX_EXTRACT_BYTES` 1 MB clamp | unchanged |

## Junk filter

OCR on photos produces confetti ("~ | . iij"). Reuse the `.doc` salvage philosophy (`prose_like`): keep a recognized line only if it has ≥ 3 characters and ≥ 60% alphanumeric+space content; drop the rest. Screenshots and scans pass untouched; noise lines from textures/photos fall out. No confidence-score plumbing in v1 — the line heuristic is deterministic and testable in both engines' styles (though it lives only in Rust).

## Caching semantics (the empty-cache trap, resolved)

- `CACHE_VERSION` 6 → 7. One-time re-extraction sweep also cures every pre-0.10 cached-empty scanned PDF.
- Successful OCR (even yielding "") caches — a genuinely blank image is a genuine result.
- Three cases deliberately do **not** cache, so the file self-heals on a later scan: OCR disabled by toggle; models missing; decode/inference error. This mirrors the existing "failures are not cached" policy line-for-line.
- Unsupported-in-v1 encodings (CCITT/JBIG2-only PDFs) DO cache empty: retrying every scan buys nothing; the v8 bump that adds support will re-extract them — same contract the format additions used in v6.

## Settings toggle

`ocr_enabled: bool` (default `true`) rides the existing settings store end-to-end (routes.rs ⇄ commands.rs ⇄ contracts ⇄ Preferences dialog). Checked at extraction time per file. Copy: **"Read text in images (OCR)"** with the secondary line "Scans and screenshots become searchable. Happens on this device; nothing is uploaded." Off ⇒ return empty, uncached (see above), so re-enabling needs no cache surgery and no rescan button.

## Distribution & CI

- `fetch-local-model.mjs`: `fetchOcr()` downloads both `.rten` files into `resources/ocr/`, pinned to the digests in the proposal, `downloadWithFallback(mirror, upstream)` exactly like the voice/embed assets (upstream: `ocrs-models.s3-accelerate.amazonaws.com`; `--record` flips to upstream-first per the existing rule).
- `mirror-hf-assets.yml` grows a second mode: assets fetched **by direct URL + pinned digest** on the runner (the `.rten` files aren't inside any shipped `.deb` yet), verified, uploaded to the same mirror tag. After 0.10.0 ships, the `.deb`-extraction mode covers them too.
- `tauri.conf.json` bundle resources: add `"../../../resources/ocr": "ocr"`.
- `asset-digests.yml` verify mode grows an **OCR smoke test**: run the engine over a committed fixture PNG (a rendered fake-SOP screenshot, ~30 KB, generated once via headless Chromium) and assert the recognized text contains its known phrases. This is the only place real inference runs in CI; unit tests cover routing/budgets/filters/caching without models.

## Rust/TS parity

**PARITY divergence — Rust-only**, same class as embeddings, `.doc`, and `.parquet`: the TS dev twin gets no ML runtime. Concretely: TS `RICH_EXT` is untouched (images stay name-match-only in the twin), `extract.ts` gains a PARITY comment naming this change, and the shared cache version moves to 7 in **both** engines (the 0.9.0 lockstep rule) even though only Rust produces OCR entries.

## Degradation ladder

1. Models missing / toggle off / decode error → file is name-findable, nothing cached, later scans self-heal. Identical UX to 0.9.0.
2. OCR yields garbage → junk filter drops noise lines; worst case the file contributes little text but never mojibake.
3. Budgets exceeded (huge image, 400-page scan) → downscaled / truncated at the page budget; partial text is real text.
4. A parser/inference panic → `catch_unwind` degrades that one file (0.9.0 hardening), scan continues.

## Local model / 6144-token window

No prompt shape changes. OCR text enters the index as ordinary prose chunks (120-word/25-overlap) and competes in normal hybrid ranking; the per-file 1 MB clamp and per-query chunk budget already bound what reaches synthesis. An OCR'd screenshot cited in an answer behaves like any cited document — clicking opens the image via the existing open path.

## Open questions (must close before ship)

1. **Model-weights license**: crate code is `MIT OR Apache-2.0`; the trained `.rten` weights are distributed by the ocrs project but their license/attribution terms (training data includes HierText) must be verified and recorded in third-party notices before bundling. If redistribution turns out restricted, fallback plan: first-run download (like the chat model path) instead of bundling.
2. **rten thread tuning**: whether to cap rten's internal parallelism explicitly or rely on the semaphore alone — decide from the spike's measured CPU behavior on the CI runner.
