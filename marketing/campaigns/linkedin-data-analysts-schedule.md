# LinkedIn campaign — data analysts (6 weeks, Jul 21 – Aug 27, 2026)

**Positioning pivot (2026-07-16):** Lighthouse now markets as **the AI
harness for analysts** — the layer between any AI model and your data that
curates what the model reads, verifies what it computes, and audits what it
sends. Same product facts, new story: the app is no longer pitched as "a
local-first vault app with chat," but as the harness analysts put around
whatever model they use.

A progressive-hype schedule: each week raises the stakes and each post
builds on features established by earlier posts, ending in ecosystem combos
(Wispr Flow, Obsidian) and a capstone. Fourteen posts — 2/week ramping to
3/week for the final two weeks.

**Audience:** data analysts (LinkedIn) — beachhead audience. The harness
story generalizes to financial/ops/research analysts; see Backlog.

**Positioning line (repeat everywhere):** *The AI harness for analysts —
any model, your data, your receipts.*

**Source of truth for claims:** the 0.11 `README.md`, `docs/launch-copy.md`,
`docs/data-flows.md`. If a claim isn't in those, it doesn't go in a post
(see Guardrails).

---

## What "harness" cashes out to (feature mapping)

Every use of the word must be backed by one of these real mechanisms in the
same post — "harness" is never vibes-only:

| Harness idea | Shipping mechanism |
| --- | --- |
| Swappable model | BYO key (Claude, GPT, Gemini, Grok, Mistral, DeepSeek), bundled on-device Mistral-7B, or zero-network extractive fallback |
| Permissioned context | Curated inclusion: files default-excluded, per-file toggles, ancestor-exclusion rule, link-in-place |
| Tool-verified execution | Beam analytics: one read-only SQL SELECT on an embedded engine, SQL shown verbatim, freshness footer |
| Model out of the loop | Edit-SQL re-runs (no model), pinned questions re-run deterministically + alert on change |
| Grounded input | Hybrid retrieval, [n] citations, whole-document reads, map-reduce, headers-on-every-chunk |
| Supervised egress | No telemetry/accounts, local audit log + egress transparency panel, AES-256-GCM-sealed keys |
| Harness at hand | Opt-in Ctrl+Super+Shift summon, on-device Whisper dictation |

**Pre-launch dependency:** lhvault.app and the README hero copy should adopt
the harness framing before Jul 21 so the campaign doesn't outrun the site.

---

## Narrative arc

| Phase | Week(s) | Job of the phase | Escalating CTA |
| --- | --- | --- | --- |
| 1. The missing layer | 1 | A chat window is not an analyst tool; name the layer | Follow the series |
| 2. What a harness does | 2 | Verified math, grounded prose — the receipt mechanics | Watch the demo clip |
| 3. Who holds the keys | 3 | Permissioned context; swap the model, keep the harness | Visit lhvault.app |
| 4. Model out of the loop | 4 | The workbench: Edit-SQL, deterministic monitors | Download & try one ask |
| 5. Harness meets your stack | 5 | Widget + Wispr Flow + Obsidian | Download; comment your stack |
| 6. The proof-of-life | 6 | Capstone workflow, honest FAQ, recap | Download; tag an analyst |

Every post carries a series marker ("n/14"), the positioning line, and ends
with a question to seed comments. Mock screens always carry the
"Screens illustrative — sample data" note, matching the flyers.

---

## Mechanics

- **Cadence:** Tue + Thu, 8:30am audience-local; weeks 5–6 add Wednesday.
- **Hook discipline:** first ~200 characters must work before LinkedIn's
  "…see more" fold — lead with the claim, not the product name.
- **Links:** `https://lhvault.app` in the post *and* pinned first comment.
  No UTM promises — the product has no telemetry; measurement stays
  LinkedIn-native (see Measurement).
- **Hashtags (≤4, niche):** #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst.
- **Visual system:** the Forerunner night-steel style from
  `marketing/flyers/` (same palette, lighthouse mark, brass beam).
- **Comments:** author replies within the first hour; seeded question per
  post is listed below.

---

## Week 1 — The missing layer

### 1) Tue Jul 21 · text + quote-card image · "You don't need a smarter model"
- **Hook:** "Every quarter, a smarter model. Every quarter, the same failure:
  a number you can't audit."
- **Beats:** the gap between analysts and AI isn't intelligence — it's the
  layer around the model: what it's allowed to read, who checks its math,
  what leaves the building. Nobody ships a metric because the prose sounded
  confident. That layer has a name — a **harness** — and analysts deserve
  one. Tease: "Six weeks, one harness. 1/14."
- **Feature focus:** none yet — frame only. **Builds on:** —
- **Asset:** dark quote-card with the hook line.
- **CTA:** follow the series. **Seed question:** "What would an AI have to
  *show you* before you'd put its number in a deck?"

### 2) Thu Jul 23 · image post (refreshed flyer) · "Meet Lighthouse"
- **Hook:** "Ask your data. Audit the answer. Lighthouse is the AI harness
  for data analysts."
- **Beats:** bring any model — or run one entirely on your machine; the
  harness curates what it reads (files default to excluded), runs the math
  as one read-only SQL query shown verbatim, cites every claim, and audits
  every byte out. Windows · macOS · Linux, free download, no account.
- **Feature focus:** product intro under harness frame. **Builds on:** #1.
- **Asset:** `marketing/flyers/exports/lighthouse-flyer-data-analyst.png`
  (refreshed with harness copy).
- **CTA:** lhvault.app. **Seed question:** "Which model would you strap in
  first?"

## Week 2 — What a harness does

### 3) Tue Jul 28 · 30s screen capture · "The model doesn't do the math"
- **Hook:** "In a harness, the model doesn't do arithmetic. It reads the
  answer off an engine that does."
- **Beats:** ask over a CSV → the harness plans **one read-only SQL SELECT**
  → an embedded engine (DataFusion) executes it → the model narrates the
  *verified* result; SQL shown verbatim, freshness footer. That's the
  division of labor: the engine computes, the model explains, you audit.
- **Feature focus:** Beam analytics core. **Builds on:** #1's missing layer
  — here's its load-bearing beam.
- **Asset:** screen capture of the real flow.
- **CTA:** watch the clip, lhvault.app. **Seed question:** "Would showing
  the SQL verbatim change what you'd trust?"

### 4) Thu Jul 30 · carousel (5–6 slides) · "A harness feeds the model only what it can cite"
- **Hook:** "Every claim gets a footnote. Every footnote opens the file."
- **Beats (one per slide):** [n] citations stream inline → Related-files
  cards → whole-document answers (very long files read section-by-section
  with an honest note) → map-reduce for multi-doc questions → hybrid
  retrieval (lexical + on-device embeddings) keeps table headers on every
  chunk so spreadsheet answers keep their column names.
- **Feature focus:** grounding. **Builds on:** #3 (numbers verified; now
  prose is too).
- **Asset:** carousel in the series style.
- **CTA:** lhvault.app. **Seed question:** "What's the longest doc you'd ask
  about?"

## Week 3 — Who holds the keys

### 5) Tue Aug 4 · GIF · "The harness holds the guest list"
- **Hook:** "Files default to excluded. The model sees a document when you
  flip its toggle — and not before."
- **Beats:** curated inclusion (readable only when its own toggle is on and
  no ancestor folder is excluded); adds link-in-place (nothing copied);
  removal non-destructive; filesystem watcher keeps the tree live. A harness
  decides what the model reads — you hold the pen.
- **Feature focus:** permissioned context. **Builds on:** #4 — citations
  are only trustworthy over a corpus you control.
- **Asset:** 10s GIF of toggles + folder exclusion.
- **CTA:** lhvault.app. **Seed question:** "What would you *exclude* first?"

### 6) Thu Aug 6 · image (model-bay graphic) · "Swap the model. Keep the harness."
- **Hook:** "Models churn every quarter. Your harness shouldn't."
- **Beats:** the harness is model-agnostic — bring a key for Claude, GPT,
  Gemini, Grok, Mistral, or DeepSeek (sealed AES-256-GCM on disk); or run
  the bundled private model on-device (opt-in ~4.2 GB Mistral-7B,
  GPU-offloaded where available) and answering makes **zero network calls**;
  or run **no model at all** — the zero-network extractive fallback still
  answers with citations. Turn off Wi-Fi and ask anyway. No telemetry, no
  accounts; the complete egress inventory is public in `docs/data-flows.md`.
- **Feature focus:** model-agnosticism + local-first — the pivot's flagship
  post. **Builds on:** #5 (you control what it reads; now, *who* reads it).
- **Asset:** "model bay" graphic — six provider slots + LOCAL + NONE, all
  plugged into one harness.
- **CTA:** lhvault.app. **Seed question:** "Which model would you plug in —
  and which would IT let you?"

## Week 4 — Model out of the loop

### 7) Tue Aug 11 · 45s screen capture · "Take the model out of the loop"
- **Hook:** "Refine with chips. Edit the SQL by hand. Re-run — the model
  doesn't get a vote."
- **Beats:** refinement chips; **Edit-SQL re-runs with no model in the
  loop**; multi-step analytics; union tables + join hints across files;
  charts render in chat; save any result as CSV, PNG, or a note in your
  vault. A harness works even when the model sits out.
- **Feature focus:** the workbench. **Builds on:** #3 (the receipt becomes
  a workbench).
- **Asset:** 45s capture: chips → edit → chart → save.
- **CTA:** download and try one real question. **Seed question:** "Chips or
  raw SQL — which would you touch first?"

### 8) Thu Aug 13 · GIF + text · "Monitors shouldn't improvise"
- **Hook:** "Pin the question. The harness re-runs the same SQL,
  deterministically — and pings you when the answer changes."
- **Beats:** pinned questions re-run deterministically on fresh data and
  alert on change; the freshness footer says exactly what data vintage
  answered; deterministic = same question, same SQL, no model drift. You
  can't monitor a KPI with a slot machine.
- **Feature focus:** pinned questions. **Builds on:** #7 and #3.
- **Asset:** GIF: pin → data file updates → alert.
- **CTA:** download. **Seed question:** "What number do you re-check every
  Monday?"

## Week 5 — Harness meets your stack (ramp to 3 posts)

### 9) Tue Aug 18 · 20s video · "One keystroke away"
- **Hook:** "Most search boxes make you go to them. Hold Ctrl + Super +
  Shift and the harness appears over your work."
- **Beats (from docs/launch-copy.md):** summon → ask → stay: the floating
  ask-bar appears over whatever you're doing, answers inline with citation
  chips, and the answer freezes on your desktop while you keep working;
  opt-in (installs an OS keyboard hook only if you enable it); dismiss with
  the same chord.
- **Feature focus:** widget + Whisper summon. **Builds on:** #4's citations,
  zero context-switch.
- **Asset:** 20s summon video, mid-spreadsheet.
- **CTA:** download. **Seed question:** "Where would you summon it from —
  Excel, the browser, or your IDE?"

### 10) Wed Aug 19 · video · **Lighthouse × Wispr Flow** (full draft below)
- **Feature focus:** voice-first asking — on-device Whisper dictation,
  Wispr-style chord. **Builds on:** #9 (the bar) + #6 (local-only audio).

### 11) Thu Aug 20 · split-screen GIF · **Lighthouse × Obsidian** (full draft below)
- **Feature focus:** Markdown in (notes as corpus), Markdown out (answers
  saved as notes). **Builds on:** #5 (link-in-place), #4 (citations), #7
  (save-as-note).

## Week 6 — The proof-of-life

### 12) Tue Aug 25 · 60–75s video or 8-slide carousel · "A Tuesday in the harness"
- **Hook:** "One analyst. Any model. Zero uploads. Every number cited."
- **Beats (chaining every prior post):** morning — a briefing note saved
  into the vault; a pinned question fires an alert (#8) → chord-summon over
  the spreadsheet (#9), dictate the follow-up (#10) → read the SQL, edit one
  clause, re-run with no model in the loop (#7/#3) → save the chart and a
  Markdown note; it shows up in Obsidian (#11) — all from a corpus you
  curated (#5), on a model you chose (#6), with citations throughout (#4).
- **CTA:** download. **Seed question:** "Which step would save you the most
  time?"

### 13) Wed Aug 26 · text or carousel · "The FAQ we'd want to read"
- **Hook:** "Hard questions, straight answers."
- **Beats:** *Is this an agent?* — no: a harness, not an agent. It reads
  only files you've included, its SQL is read-only, and the only thing it
  ever writes is notes/CSVs into your own vault. *Is it really local?* —
  the app phones nothing home; three user-initiated outbound request kinds
  only; local audit log + egress transparency panel show every byte out;
  full inventory in `docs/data-flows.md`. *Why does SmartScreen/Gatekeeper
  warn?* — installers currently unsigned; signing pipeline wired,
  certificates pending — we'd rather tell you than hide it. *Is it fast?* —
  a ten-thousand-file vault indexes in under a second (launch-copy claim).
  *What if I configure no model?* — grounded, cited extractive answers,
  zero network.
- **Feature focus:** transparency as brand. **Builds on:** #6; closes
  objections before the finale.
- **CTA:** lhvault.app. **Seed question:** "What's your IT team's first
  question — we'll answer it in the comments."

### 14) Thu Aug 27 · carousel + flyer · "The model is a guest. The harness is yours."
- **Hook:** "14 posts, one promise: any model, your data, your receipts."
- **Beats:** recap slides — engine-verified SQL (#3) · citations (#4) ·
  guest-list curation (#5) · swap-the-model (#6) · deterministic monitors
  (#8) · voice + notes ecosystem (#10–11); final slide = refreshed flyer
  with CTA.
- **CTA:** download at lhvault.app; **tag a data analyst** who still
  screenshots ChatGPT tables. **Seed question:** "Which post convinced you —
  or didn't?"

---

## Full draft captions — the two combo posts

### Post 10 — Lighthouse × Wispr Flow (Wed Aug 19)

> **If Wispr Flow taught you to talk to your computer, this is the same
> reflex — pointed at everything you've ever saved.**
>
> Flow users have the muscle memory: hold a chord, speak, done. Lighthouse
> gives your *files* that reflex. Hold **Ctrl + Super + Shift** — a
> modifier-only chord, no letter key — and a floating ask-bar appears over
> whatever you're working on.
>
> Then just talk. Lighthouse ships **on-device Whisper dictation** — voice
> input runs in-process, no sockets, no audio leaving your machine. And
> because the bar is an ordinary text field with the caret ready, Wispr Flow
> itself types into it perfectly if you'd rather keep dictating your way.
>
> "Which region drove Q2 revenue growth?" — spoken, not typed — comes back
> as a **cited answer** backed by one read-only SQL query you can open and
> read. That's the harness doing its job: your voice transcribed on your
> machine, your files read on your terms, the answer carrying its receipt.
>
> Opt-in, off by default: the summon hook installs only if you enable it.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Wispr Flow is an independent product; no affiliation — we just share the
> reflex. 10/14 · The AI harness for analysts.)
>
> *What's the first question you'd ask out loud?*

- **Asset:** 25s video — analyst mid-Excel, hands off keyboard except the
  chord, speaks the question, cited answer streams inline. Caption overlay:
  "dictation runs on-device."
- **Guardrail:** never imply partnership/integration beyond "it's a text
  field, Flow types anywhere" + our own built-in dictation.

### Post 11 — Lighthouse × Obsidian (Thu Aug 20)

> **Your Obsidian vault is already a corpus. Give it a harness.**
>
> An Obsidian vault is Markdown on disk. That's exactly what Lighthouse
> reads. Add the folder — **link-in-place, nothing copied, nothing
> uploaded** — and ask questions across years of notes. Answers come back
> with **[n] citations that open the exact note**, and the filesystem
> watcher picks up your edits live: write in Obsidian, ask in Lighthouse,
> no re-import, no sync step.
>
> It loops back, too. Any answer, chart, or verified analytics result can be
> **saved as a plain Markdown note** in a `Lighthouse Notes/` folder inside
> your vault. Open it in Obsidian like any other note — your AI analysis
> lives next to the thinking that prompted it.
>
> A harness shouldn't be a silo: **plain files in, plain files out.** No
> plugin, no export wizard, no lock-in — and if you run the local model,
> your second brain never touches the network.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Obsidian is an independent product; no affiliation — your notes are just
> Markdown, and that's the point. 11/14 · The AI harness for analysts.)
>
> *How many notes deep is your vault? Would you let an AI cite them?*

- **Asset:** 20s split-screen GIF — left: Obsidian note being edited; right:
  Lighthouse answering with a citation chip naming the note; then
  save-as-note and the new file appearing in Obsidian's file list.
- **Guardrail:** notes save to `Lighthouse Notes/` in *Lighthouse's* vault —
  the loop needs the user to open/include that folder in Obsidian. Phrase as
  "inside your vault … open it in Obsidian," never "syncs to Obsidian."

---

## Asset production checklist

| Asset | Needed by | Status |
| --- | --- | --- |
| Quote-card #1 ("smarter model" hook) | Jul 20 | to make |
| Data-analyst flyer, harness copy (#2, #14) | done | `marketing/flyers/exports/…data-analyst.png` |
| Beam analytics capture 30s (#3) | Jul 27 | to make |
| Grounding carousel (#4) | Jul 29 | to make |
| Inclusion-toggles GIF (#5) | Aug 3 | to make |
| Model-bay graphic (#6) | Aug 5 | to make (6 providers + LOCAL + NONE) |
| Workbench capture 45s (#7) | Aug 10 | to make |
| Pin-alert GIF (#8) | Aug 12 | to make |
| Summon video 20s (#9) | Aug 17 | to make |
| Wispr Flow combo video 25s (#10) | Aug 18 | to make |
| Obsidian split-screen GIF (#11) | Aug 19 | to make |
| Day-in-the-life video/carousel (#12) | Aug 24 | to make |
| FAQ carousel (#13) | Aug 25 | to make |
| Recap carousel (#14) | Aug 26 | to make |

Screen captures should use a demo vault with obviously-sample data; keep the
"Screens illustrative — sample data" footer when a mock (not the real app)
is shown.

---

## Guardrails (claims discipline)

- Every product claim must trace to `README.md`, `docs/launch-copy.md`, or
  `docs/data-flows.md`. Approved load-bearing claims: read-only SQL via
  embedded engine, SQL shown verbatim, freshness footer, [n] citations,
  whole-document reads + honest sectioning, map-reduce multi-doc, hybrid
  retrieval with on-device embeddings, headers-on-every-chunk, curated
  inclusion defaults-excluded, link-in-place, non-destructive removal, live
  watcher, on-device OCR, private model opt-in ~4.2 GB Mistral-7B with GPU
  offload, six BYO-key providers, AES-256-GCM-sealed keys, zero-network
  extractive fallback, no telemetry/accounts, audit log + egress panel,
  Ctrl+Super+Shift opt-in summon, on-device Whisper dictation,
  save-as-CSV/PNG/note into `Lighthouse Notes/`, briefings,
  10k-file-vault-indexes-under-a-second, Win/macOS/Linux, free download.
- **Harness language rules:** "harness" must cash out to a shipping
  mechanism named in the same post (see the mapping table). It is
  positioning for what exists — not a promise of what might.
- **Do NOT claim (nothing in the repo ships these):** agentic or autonomous
  task execution; tool plugins / MCP / extension ecosystem; multi-model
  routing or orchestration; eval suites; an API or SDK; "framework."
  Lighthouse is a desktop app whose only writes are notes/CSVs into the
  user's own vault — the #13 "a harness, not an agent" phrasing is the
  approved line. If the pivot roadmap later ships harness features beyond
  today's README, add posts *when they land*, not before.
- **Never claim:** partnerships with Wispr Flow or Obsidian (independent
  products; our compatibility is "plain text fields" and "plain Markdown
  files"); signed installers (unsigned today — see #13); benchmarks beyond
  the launch-copy indexing line; "free trial" (stale launch-copy phrasing —
  it's a free download, no accounts or licensing).
- Sample numbers in mocks stay obviously illustrative and labeled.

---

## Measurement (LinkedIn-native — the product has no telemetry)

- **Phase 1–2:** impressions + follower delta (target: establish the
  series; engagement rate ≥ 4% on #3–4).
- **Phase 3–4:** saves + shares on #6 and #8 (the "screenshot-for-IT"
  posts). #6 is the pivot's flagship — if "Swap the model. Keep the
  harness." underperforms, revisit the framing before week 5.
- **Phase 5:** comment depth on #10–11; outbound clicks reported by
  LinkedIn.
- **Phase 6:** clicks on #12/#14 + tags on #14. GitHub release download
  counts (public per-asset stats) remain the only conversion proxy
  consistent with a no-telemetry product — note the count the week before
  launch and the week after #14.
- Retro after week 6: keep the two best-performing formats, fold the rest
  into an evergreen monthly cadence.

## Backlog (not scheduled)

- Friday poll, week 1: "Would your IT team let you point an AI at client
  data?" (4 options).
- Meme-format repost of #3 if it overperforms.
- Financial-analyst flyer refresh to harness copy + a September campaign
  for the finance/IT-security audience reusing #6 + #13.
- If pivot roadmap ships new harness surfaces (API, orchestration, more
  engines), slot a "week 7" mini-arc — claims gated on landing.
