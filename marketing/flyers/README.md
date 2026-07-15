# LinkedIn flyers

Audience-targeted promo flyers for Lighthouse, sized for a LinkedIn feed
image post (4:5 portrait, 1080×1350, exported at 2× — 2160×2700 PNG).

| Audience | Source | Export |
| --- | --- | --- |
| Data analysts | `lighthouse-flyer-data-analyst.html` | `out/lighthouse-flyer-data-analyst.png` |
| Financial analysts | `lighthouse-flyer-financial-analyst.html` | `out/lighthouse-flyer-financial-analyst.png` |

Every product claim on the flyers is taken from the README/docs as of 0.11
(read-only SQL analytics, [n] citations, pinned-question alerts, local-first
engine/index/embeddings/OCR, optional on-device model, no telemetry/accounts,
AES-256-GCM-sealed keys, audit log + egress panel, supported formats,
Windows/macOS/Linux). The mock screens are illustrative — sample data, not
real product output — and are labeled as such on the flyer.

Design: the app's Forerunner palette (`src/shell/theme.ts`) — night-steel
blues, brass beacon accents — and the lighthouse mark redrawn from
`build/icon.svg` for a dark canvas. `fonts.css` embeds Inter and
JetBrains Mono (both SIL OFL 1.1) as data URIs so the HTML is
self-contained and renders identically anywhere.

## Re-export after editing

```bash
npm install --no-save --no-package-lock playwright-core   # once
node marketing/flyers/render.mjs
```

Posting tip: LinkedIn shows 4:5 images full-height in the feed. Upload the
PNG directly (don't paste it into a document post), and put the download
link — https://lhvault.app — in the post text, since image text isn't
clickable.
