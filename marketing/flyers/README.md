# LinkedIn flyers

Audience-targeted promo flyers for Lighthouse, sized for a LinkedIn feed
image post (4:5 portrait, 1080×1350, exported at 2× — 2160×2700 PNG).

| Audience | Source | Export |
| --- | --- | --- |
| Data analysts | `lighthouse-flyer-data-analyst.html` | `exports/lighthouse-flyer-data-analyst.png` |
| Financial analysts | `lighthouse-flyer-financial-analyst.html` | `exports/lighthouse-flyer-financial-analyst.png` |

Positioning: **the AI harness for analysts**. Every product claim is taken
from the tree as of **0.12.2** (the Beam release): read-only SQL on an
embedded engine with the SQL shown verbatim, certified answers from the
local semantic layer, provenance stamps ("Answered on this device"),
local-only marks enforced fail-closed, boards, evidence packs, curation
rules, seven BYO-key providers or the bundled on-device model, no
telemetry/accounts, Windows/macOS/Linux. The mock screens are illustrative
— sample data, not real product output — and are labeled as such on the
flyer.

Design: the **Beam identity** (`src/shell/theme.ts`, 0.12.0) — ink canvas
`#0E0F12`, paper surfaces, a single warm-amber accent
(`#E8A317`→`#FFC24D`), flat geometry, hairline strokes — with the
lighthouse mark redrawn from `build/icon.svg` (paper tower, amber lamp,
one beam wedge). Hero cards mirror the real Paper-theme UI (see
`docs/brand/` for actual screenshots). `fonts.css` embeds Inter and
JetBrains Mono (both SIL OFL 1.1) as data URIs so the HTML is
self-contained and renders identically anywhere.

## Re-export after editing

```bash
npm install --no-save --no-package-lock playwright-core   # once, outside-repo also fine
node marketing/flyers/render.mjs
```

Posting tip: LinkedIn shows 4:5 images full-height in the feed. Upload the
PNG directly (don't paste it into a document post), and put the download
link — https://lhvault.app — in the post text, since image text isn't
clickable.
