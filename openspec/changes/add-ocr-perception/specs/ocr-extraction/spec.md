# ocr-extraction — delta

## ADDED Requirements

### Requirement: Image files contribute searchable text
Common raster image files (`.png .jpg .jpeg .webp .bmp .tif .tiff`) SHALL have their printed text recognized on device and indexed as ordinary prose, flowing through the standard chunker, retrieval, and citations. Recognition happens locally; no image or derived text SHALL leave the machine.

#### Scenario: A screenshot answers a question
- **WHEN** the vault contains `reset-console.png`, a screenshot whose pixels read "Escalate to tier two after 3 failures"
- **THEN** asking "when do we escalate password resets?" retrieves and cites `reset-console.png`, and clicking the citation opens the image

#### Scenario: A blank or textless image
- **WHEN** a photo with no legible print is scanned
- **THEN** it contributes no chunks (junk lines filtered), remains findable by name, and the empty result is cached like any genuine extraction

### Requirement: Image-only PDFs fall back to OCR
When a PDF's text layer yields (near-)nothing and the document embeds raster page images, the extractor SHALL recognize the page images in page order (JPEG/`DCTDecode` and `FlateDecode` RGB/Gray in v1) up to a fixed page budget. PDFs with a real text layer SHALL never trigger OCR.

#### Scenario: A scanner-produced SOP
- **WHEN** `fire-drill-procedure.pdf` is a 6-page scan with no text layer
- **THEN** its recognized text is indexed page by page and the document is citable like any text PDF

#### Scenario: The pre-0.10 empty-cache trap is cured
- **WHEN** a scanned PDF was cached as empty by an earlier version
- **THEN** the cache schema bump re-extracts it once and it gains content without user action

### Requirement: OCR is budgeted and non-disruptive
OCR SHALL be bounded: oversized images downscale to a fixed pixel budget before inference, at most a fixed number of PDF pages are recognized per document, tiny images are skipped without inference, and concurrent OCR is capped so a first scan of an image-heavy vault degrades neither the app nor the machine.

#### Scenario: A 400-page scanned book
- **WHEN** it enters the vault
- **THEN** only the page budget is recognized, the scan completes, and other files keep extracting in parallel

### Requirement: OCR degrades without ever regressing 0.9.0 behavior
If the models are absent, the user disables OCR, or decode/inference fails, affected files SHALL remain name-findable exactly as before OCR existed, and those outcomes SHALL NOT be cached — a later scan with OCR available self-heals with no cache surgery or manual rescan.

#### Scenario: Toggle off, then on
- **WHEN** the user disables "Read text in images (OCR)", adds screenshots, then re-enables it
- **THEN** the next scan extracts those screenshots' text with no further action

### Requirement: The user controls OCR from Preferences
A Preferences toggle ("Read text in images (OCR)", default on) SHALL govern all OCR work, with copy stating that recognition happens on this device.

#### Scenario: Opting out
- **WHEN** the user turns the toggle off
- **THEN** no OCR inference runs during scans while it remains off

### Requirement: OCR models are pinned, mirrored, and bundled
The detection and recognition models SHALL be bundled with the app (installer resources), fetched at build time against pinned SHA-256 digests with a repository-hosted mirror tried before the upstream host, and covered by third-party notices. A build SHALL fail closed on a digest mismatch from any source.

#### Scenario: Upstream host outage during a release build
- **WHEN** the upstream model host is unavailable
- **THEN** the build fetches the identical, digest-verified bytes from the repository mirror and proceeds
