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

## The parity rules

1. **Shared behavior lands in BOTH engines.** Retrieval, chunking, synthesis
   orchestration, prompts, extraction for shared formats, licensing,
   settings/profile/secrets handling — a change to one side without the other
   is a bug unless rule 3 applies.
2. **Prompts, labels, and trigger rules are byte-identical.** The system
   prompt, the context/question wrapper, user-visible notice templates
   (e.g. the named-but-excluded notice, doc-focus progress labels), and cue
   tables must match byte-for-byte across `synth.rs`/`synth.ts`,
   `llm.rs`/`llm.ts`, `meta.rs`/`meta.ts`. When touching one, diff the other.
3. **Deliberate divergence carries a `PARITY:` comment** on both sides where
   sensible, stating what diverges and why. "The TS twin lacks X" is a valid
   permanent state only for the capabilities listed below.
4. **`CACHE_VERSION` moves in lockstep** across
   `native/crates/lighthouse-core/src/extract.rs`, `src/server/extract.ts`,
   and the assertion in `native/crates/lighthouse-core/tests/extract_test.rs`
   — bump all three or native CI goes red. This holds even when the change
   motivating the bump is Rust-only (the cache format is shared).
5. **Parity fixtures are byte-pinned in both suites.** The chunker windows
   (`vault.rs` ⇄ `test/chunker.test.mjs`), the table-profile block
   (`table_profile.rs` ⇄ `test/tableProfile.test.mjs`), and the meta cue
   table (`meta.rs` ⇄ `test/meta.cues.test.mjs`). Touch one side → the other
   suite fails.

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
| OCR (scanned PDFs, raster images) | `ocr.rs` | image files stay name-match-only |
| Filesystem watcher (event-driven freshness) | `watch.rs` | poll-style freshness |
| Extra rich formats: `.doc`, `.pptx`, `.odt`, `.odp`, `.rtf`, images | `extract.rs` `RICH_EXT` | name-match-only (TS extracts pdf/docx/xlsx/csv/md/txt via mammoth/unpdf/xlsx) |

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
(whole-document answers), multi-doc synthesis.

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
