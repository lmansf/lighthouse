# The TS engine — role, rules, and the Rust-only capability list

*Status: canonical as of the Electron retirement (post-0.11.0). This document
is the reference for what `src/server/` is, what it must mirror, and what it
deliberately lacks. Verified against a full PARITY-marker sweep of both trees.*

## What ships and what doesn't

- **The Rust engine ships.** `native/crates/lighthouse-core` is the product
  engine; it runs inside two binaries — the Tauri desktop shell
  (`lighthouse-desktop`, the thing users install) and the headless loopback
  server (`lighthouse-server`, used by tests, CI smokes, and
  `LIGHTHOUSE_SERVE=1`).
- **The TS engine does not ship.** `src/server/` + the Next `app/api/**`
  routes exist for two purposes only:
  1. **Web dev flow** — `npm run dev` gives a browser-based Lighthouse against
     the same vault format, with second-scale edit-reload, no Rust toolchain
     required. This is where UI work happens.
  2. **Parity oracle** — a second, independently-written implementation of the
     retrieval/synthesis contract. Divergence between the twins has repeatedly
     been how engine bugs were caught; the node test suite doubles as an
     executable spec that the Rust side mirrors (and vice versa).

## The twin contract (two lists — §39 codification)

Every shared module is in exactly ONE of two buckets. If you cannot say which
bucket your change touches, stop and read this section again.

**BYTE-TWINNED** — the bytes are the contract; each entry names the parity
test that fails when the twins drift. Changing one side means changing the
other side and the pin IN THE SAME COMMIT.

| Surface | Rust ⇄ TS | Parity test |
|---|---|---|
| FULL system prompt + buildPrompt + priorTurns | llm.rs ⇄ llm.ts | test/promptParity.test.mjs + test/cloudSnapshot.test.mjs (+ the Rust `cloud_snapshot` tests — both engines pin the same fixture files) |
| Compact system prompt (apple-fm tiers) | llm.rs ⇄ llm.ts | test/compactPrompt.test.mjs + test/fixtures/compact-prompt.txt (both engines) |
| Budget tables, digit-aware estimator, overflow ladder | budget.rs ⇄ budget.ts | test/budget.test.mjs ⇄ the cargo `budget::` tests (same cases) |
| Chunker windows | vault.rs ⇄ vault.ts | test/chunker.test.mjs |
| Table-profile block | table_profile.rs ⇄ tableProfile.ts | test/tableProfile.test.mjs |
| Meta cue table | meta.rs ⇄ meta.ts | test/meta.cues.test.mjs |
| Reliability block names + templates (§4 assists) | synth.rs ⇄ synth.ts | test/draftAnswer.test.mjs + test/privacyLegibility.test.mjs |
| Local-only skip-note template | synth.rs ⇄ synth.ts | test/privacyLegibility.test.mjs (pins both engine templates) |
| Doc-focus reduce length note (§35 §2) | synth.rs ⇄ synth.ts | test/promptParity.test.mjs (byte pin + one-call-site counts) |
| Pure verdict fns (warm-wait, overflow retry) | synth.rs/budget.rs ⇄ synth.ts/budget.ts | test/localWarmWait.test.mjs, test/budget.test.mjs |
| Settings file surface | settings.rs ⇄ settings.ts | native settings_test.rs (no-`..` destructuring makes a new field a compile error until covered) + the twin round-trip tests |
| CACHE_VERSION | extract.rs ⇄ extract.ts | the assertion in native tests/extract_test.rs — moves in lockstep even for Rust-only changes (the cache format is shared) |

**WIRE-COMPATIBLE-ONLY** — the twins agree on the wire shape (ops, chunk
framing, JSON fields) but implementations may diverge; every deliberate
divergence carries a `PARITY:` comment at the seam. This bucket is everything
not listed above, notably: the routes/op dispatch (app/api/rag/route.ts vs
lighthouse-server), vault walk/inclusion/curation evaluation (mirrored
BEHAVIOR, no byte pins), extraction for shared formats (different libraries,
compatible output), the answer cache, egress/audit registries, local-model
management, provider auth (desktop-only by design, fail-closed stub in the
twin), and the whole Rust-engine-only capability list below.

**Ambiguous today — flagged for the owner** (each claims parity in comments
but has NO cross-engine enforcing test; promote to byte-twinned with a pin,
or demote to wire-compatible and soften the comment):

1. `REMOTE_PROVIDERS` ⇄ `OPENAI_COMPAT_PROVIDERS` (llm.ts ⇄ llm.rs) — "KEEP
   IN SYNC" comment; test/providers.test.mjs exercises the TS table only.
2. The §32 §5 quote digest (quotes.ts ⇄ the Rust digest in synth.rs/quotes) —
   PARITY comments claim byte-identical digesting; test/quotes.test.mjs
   behavior-tests the TS side only.
3. The reliability preamble's exact prose (synth twins) — the names are
   pinned, the full template bytes are asserted structurally, not
   cross-engine byte-for-byte.

The old numbered rules still hold where they don't conflict: shared behavior
lands in BOTH engines unless the capability list says otherwise, and
deliberate divergence always carries the `PARITY:` comment.

## Rust-engine-only capabilities (canonical list)

These live in `lighthouse-core` and run in **both** Rust binaries (desktop
app *and* headless server) — "desktop-only" undersells them; the accurate
term is **Rust-engine-only**. The TS twin recognizes the surface (ops,
intents) but degrades as noted:

| Capability | Where | TS twin behavior |
|---|---|---|
| Analytics / ask-your-data SQL (DataFusion) | `analytics.rs` | `analyticsSql` op returns an error; chat never takes the analytics branch |
| Column catalog (join hints, suggested asks, find-column) | `catalog.rs` | `suggestedAsks` returns `[]`; findColumn intent falls through to retrieval |
| Local embeddings + hybrid search | `embed.rs` | retrieval stays lexical (BM25) |
| Persistent incremental retrieval index | `index.rs` | re-reads/re-chunks per query under legacy caps |
| OCR (scanned PDFs, raster images) | `ocr.rs` | image files stay name-match-only. The file inspector's `ocrAvailability` field IS shared (a SELECT-less report): the Rust engine returns its live verdict (`ready`/`off`/`missing-models` — the last one makes a build whose bundled models never shipped diagnosable, iOS fp3 §1), while the twin fills the SAME field with its own honest constant `unsupported` for images + PDFs |
| Filesystem watcher (event-driven freshness) | `watch.rs` | poll-style freshness |
| Extra rich formats: `.doc`, `.pptx`, `.odt`, `.odp`, `.rtf`, images | `extract.rs` `RICH_EXT` | name-match-only (TS extracts pdf/docx/xlsx/csv/md/txt via mammoth/unpdf/xlsx) |
| Semantic layer: certification, trust reconcile, metric proposal (parse executed SQL) | `analytics.rs` (`certified_metrics`/`reconcile_metric`/`propose_metric`) + `synth.rs` prompt injection | never certifies/reconciles (no analytics branch → no `AnalyticsMeta.certified`/`.trust`); `op:"defineMetric"` answers `{available:false}`. The store/CRUD/`applicableSemantics` list ARE mirrored (`semantic.ts`) — a metric carries its `reads`, so `list` needs no DataFusion |
| Automation entry points: the headless `lighthouse` CLI + `lighthouse-mcp` server | `lighthouse-cli` / `lighthouse-mcp` crates (thin wrappers over `ask::run_headless_ask` — audited + egress-attributed by construction) | no headless/MCP ask surface (the app is the only entry). Investigation `fork`/`export_markdown` themselves ARE mirrored in `investigations.ts` |
| Quantitative depth: the `forecast` + `changepoint-scan` recipes and proactive `insights` | `recipes.rs` (`plan_forecast`/`plan_changepoint`) + `insights.rs` (`scan`) | recipe EXECUTION is Rust-only (the `recipes` op answers `{available:false}`); the `insights` op returns an empty scan (`findings:[]`, `tablesScanned/Available:0`). The **`band` chart kind** the forecast draws IS a real twin (`chartSpec.ts` — parse/validate mirrored byte-for-byte), NOT Rust-only |
| Deep analysis (`investigate` → in-vault report) + the capability map | `reports.rs` (`investigate`/`write_report`) + `meta.rs` (`capability_map`) | `investigate` runs the applicable recipe battery through DataFusion and writes a report note — the `investigate` op answers `{available:false}`; `capabilityMap` aggregates the column catalog + recipe/metric applicability, so the op returns an EMPTY map (`tables/recipes/metrics/suggestedAsks/suggestedInvestigations` all `[]`). Both honest degradations, like the recipes/insights twins |

These live in the **desktop shell** specifically (`lighthouse-desktop`), not
in `lighthouse-core`, so even the headless Rust server lacks them:

| Capability | Where |
|---|---|
| Pinned-question background recheck scheduler | `main.rs` (debounced loop; both TS and the Rust server answer recheck ops CRUD-only/no-op) |
| llama-server / embed-server supervision, GPU offload | `supervise.rs` |
| Whisper dictation (STT) + summon hotkey hooks | `whisper.rs` + per-platform hook modules |
| Widget / tray / update check | `main.rs`, `supervise.rs` |

**Mirrored in both engines** (do not let these drift): local
model download/uninstall marker, SharePoint/OneDrive connectors, licensing,
experiments, table profiles, structure-aware chunking, meta answers
(whatsNew/listFiles), profile + sealed secrets store, doc-focus
(whole-document answers), multi-doc synthesis, semantic-layer store + CRUD +
local-only propagation + `applicableSemantics` list (`semantic.rs` ⇄
`semantic.ts`; only certify/reconcile/propose above are Rust-only).

**TS-only bits** (the dev server's own plumbing, no Rust mirror needed):
the Next `app/api/**` route layer (Rust mirror is `lighthouse-server`'s
axum routes), `http.ts` same-origin auth (Rust mirror is `auth.rs` — note
its documented stricter-edge-case PARITY), `registration.ts` contact-form
shape.

## Working on the twins

- Engine change → implement in Rust, mirror in TS (or PARITY-note), run both
  suites: `cd native && cargo test --workspace` and `npm run test`.
- Prompt/label change → byte-diff the twin literal; the node suite pins
  several of them.
- New Rust-only capability → add the op to the TS route layer with an honest
  PARITY degradation (error/empty/no-op, never a fake answer), update the
  table above.
- The dev flow must keep working: `npm run dev` + a browser is the fastest
  UI iteration loop and the only one that needs no Rust toolchain.
