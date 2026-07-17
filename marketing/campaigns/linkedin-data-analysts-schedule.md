# LinkedIn campaign — data analysts (6 weeks, Jul 21 – Aug 27, 2026)

**Refreshed for 0.12.2 (2026-07-17).** Two things changed since the first
draft: the product pivoted its positioning to **the AI harness for
analysts**, and 0.12.x then shipped the harness for real — the Beam release
(verified analytics loop, certified answers, plan approval, boards,
investigations, shaped views, evidence packs, a headless CLI and an MCP
server) plus the **Beam visual identity** (ink & paper, one amber accent).
This schedule markets what is on `main` at **0.12.2** — nothing speculative.

Fifteen posts: 2/week, ramping to 4 in week 5 (ecosystem week) and 3 in
week 6. Each post builds on features established by earlier posts.

**Audience:** data analysts (LinkedIn) — beachhead audience. The harness
story generalizes to financial/ops/research analysts; see Backlog.

**Positioning line (repeat everywhere):** *The AI harness for analysts —
any model, your data, your receipts.*

**Source of truth for claims:** the 0.12.2 tree — release notes for
PRs #150–#167, `docs/launch-copy.md` (the Beam launch draft),
`docs/data-flows.md`, README. If a claim isn't traceable there, it doesn't
go in a post (see Guardrails).

**Pre-launch dependencies:**
1. README's "What it does" section still says *"as of 0.11"* and Status
   says *"at 0.11.x"* despite the tree stamping 0.12.2 — fix before Jul 21
   or the campaign sends people to a page that undersells the product.
2. lhvault.app hero copy should carry the harness framing + Beam identity
   before Jul 21.

---

## What "harness" cashes out to (0.12.2 feature mapping)

Every use of the word must be backed by a real mechanism named in the same
post — "harness" is never vibes-only:

| Harness idea | Shipping mechanism (0.12.2) |
| --- | --- |
| Swappable model | Seven BYO-key providers, switchable mid-chat (stamp follows); bundled on-device Mistral-7B; zero-network extractive fallback |
| Permissioned context | Visibility toggles + your chosen default posture; per-folder curation rules that cover future arrivals; **local-only marks** enforced fail-closed; the "What the AI sees" inspector |
| Tool-verified execution | Beam: one read-only SQL SELECT on an embedded engine, shown verbatim; the model reads only table *shape*; charts drawn from the verified rows |
| Certified meaning | The local semantic layer: metrics/synonyms/join-hints; **certified answers** via query-equivalence; trust check re-runs the blessed definition |
| Bounded loops | The Beam loop: step/deadline/token budgets (never unbounded), cost meter with $ estimate, **two-phase plan approval**, context manifest |
| Model out of the loop | Edit-SQL re-runs; deterministic pinned questions; model-free recipes (incl. forecast + changepoint); proactive insights; deep-analysis reports |
| Supervised egress | Provenance stamp per answer ("Answered on this device" / "via *vendor* — N excerpts from M files"); local audit log + egress shield; no telemetry/accounts |
| Analyst workspace | Investigations (scoped containers, Markdown export), Boards (living local dashboards), shaped views, evidence packs, answer cache, quick-open |
| Automation | Headless `lighthouse` CLI + **MCP server**, both through the same audited chokepoint — recorded exactly like an in-app ask |

---

## Narrative arc

| Phase | Week(s) | Job of the phase | Escalating CTA |
| --- | --- | --- | --- |
| 1. The missing layer | 1 | A chat window is not an analyst tool; name the layer | Follow the series |
| 2. What a harness does | 2 | Verified math, grounded prose — the receipt mechanics | Watch the demo clip |
| 3. Who holds the keys | 3 | Permissioned context; swap the model, keep the harness | Visit lhvault.app |
| 4. Model out of the loop | 4 | The workbench: views, recipes, boards, budgets | Download & try one ask |
| 5. Harness meets your stack | 5 | Widget + Wispr Flow + Obsidian + MCP/CLI | Download; comment your stack |
| 6. The proof-of-life | 6 | Capstone workflow, honest FAQ, recap | Download; tag an analyst |

Every post carries a series marker ("n/15"), the positioning line, and ends
with a question to seed comments. Mock screens always carry the
"Screens illustrative — sample data" note, matching the flyers.

---

## Mechanics

- **Cadence:** Tue + Thu 8:30am audience-local; week 5 adds Wed + Fri,
  week 6 adds Wed.
- **Tone (from docs/launch-copy.md):** plain, specific, honest — **no
  superlatives**. The claims are unusual enough without adjectives.
- **Hook discipline:** first ~200 characters must work before LinkedIn's
  "…see more" fold — lead with the claim, not the product name.
- **Links:** `https://lhvault.app` in the post *and* pinned first comment.
  No UTM promises — the product has no telemetry; measurement stays
  LinkedIn-native (see Measurement).
- **Hashtags (≤4, niche):** #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst.
- **Visual system:** the **Beam identity** (`src/shell/theme.ts`, 0.12.0) —
  ink canvas `#0E0F12`, paper surfaces, ONE warm-amber accent
  (`#E8A317`→`#FFC24D`), flat geometry, hairline strokes, the geometric
  lighthouse mark from `build/icon.svg`. Real product screenshots live in
  `docs/brand/` (light + dark) — prefer them over mocks where possible.
- **Comments:** author replies within the first hour; seeded question per
  post listed below.

---

## Week 1 — The missing layer

### 1) Tue Jul 21 · text + quote-card image · "You don't need a smarter model"
- **Hook:** "Every quarter, a smarter model. Every quarter, the same failure:
  a number you can't audit."
- **Beats:** the gap between analysts and AI isn't intelligence — it's the
  layer around the model: what it may read, who checks its math, what
  leaves the building. That layer has a name — a **harness** — and 0.12
  ships one. Tease: "Six weeks, one harness. 1/15."
- **Feature focus:** frame only. **Builds on:** —
- **Asset:** ink quote-card, Beam style.
- **CTA:** follow the series. **Seed question:** "What would an AI have to
  *show you* before you'd put its number in a deck?"

### 2) Thu Jul 23 · image post (Beam flyer) · "Meet Lighthouse"
- **Hook:** "Ask your data. Audit the answer. Lighthouse 0.12 is the AI
  harness for data analysts."
- **Beats:** bring any model — or run one on-device; Beam turns a question
  into one read-only SQL query an embedded engine runs on your machine;
  the model never does arithmetic; answers carry citations, a provenance
  stamp, and — new in 0.12 — certified badges, plan approval, evidence
  packs. Windows · macOS · Linux, free, no account.
- **Feature focus:** product intro. **Builds on:** #1.
- **Asset:** `marketing/flyers/exports/lighthouse-flyer-data-analyst.png`
  (Beam identity, 0.12.2 copy — done).
- **CTA:** lhvault.app. **Seed question:** "Which model would you strap in
  first?"

## Week 2 — What a harness does

### 3) Tue Jul 28 · 30s screen capture · "The model doesn't do the math"
- **Hook:** "In a harness, the model reads only the *shape* of your tables.
  An engine does the arithmetic."
- **Beats (launch-copy's four beats):** Ask → the model sees names, columns,
  a few sample rows, and writes one read-only SQL SELECT. Execute → an
  embedded engine runs it on your machine. Verify → the answer leads with
  the figure, shows the result table, a chart drawn from those same
  verified rows, the SQL verbatim, and which files it read, how fresh.
  Keep → save as CSV or a one-file **evidence pack**.
- **Feature focus:** the Beam core. **Builds on:** #1.
- **Asset:** screen capture of the real flow (docs/brand/ has stills).
- **CTA:** watch the clip. **Seed question:** "Would showing the SQL
  verbatim change what you'd trust?"

### 4) Thu Jul 30 · carousel (5–6 slides) · "A harness feeds the model only what it can cite"
- **Hook:** "Every claim gets a footnote. Every footnote opens the exact
  passage."
- **Beats:** [n] citations stream inline and now **open the inspector at
  the cited chunk, highlighted**; Related-files cards; whole-document
  answers with honest sectioning; map-reduce for multi-doc; hybrid
  retrieval keeps table headers on every chunk; honest, engine-written
  footers the model can't reword (truncation, skips, cached replays).
- **Feature focus:** grounding + honesty machinery. **Builds on:** #3.
- **CTA:** lhvault.app. **Seed question:** "What's the longest doc you'd
  ask about?"

## Week 3 — Who holds the keys

### 5) Tue Aug 4 · GIF · "The harness holds the guest list"
- **Hook:** "The AI reads a file when you say so — and 'this device only'
  means a cloud model *never* sees it."
- **Beats:** per-file visibility toggles with your chosen default posture
  (conservative nothing-in-until-toggled unless you opt otherwise at
  onboarding — explicit toggles always win); per-folder **curation rules**
  that cover files arriving later; **local-only marks** enforced
  fail-closed at every choke point, with the header counting "*n* files
  hidden from cloud models"; the **"What the AI sees" inspector** shows the
  exact extracted text, chunk by chunk; adds link-in-place.
- **Feature focus:** permissioned context. **Builds on:** #4.
- **Asset:** 10s GIF — toggle, rule, lock.
- **CTA:** lhvault.app. **Seed question:** "Which folder gets locked first?"

### 6) Thu Aug 6 · image (model-bay graphic) · "Swap the model. Keep the harness."
- **Hook:** "Models churn every quarter. Your harness shouldn't."
- **Beats:** seven providers via sealed keys (AES-256-GCM), switchable
  mid-chat — the **provenance stamp follows automatically**: "Answered on
  this device" or "Answered via *vendor* — N excerpts from M files sent";
  or the bundled on-device model (opt-in ~4.2 GB Mistral-7B, GPU-offloaded,
  resumable download) for **zero network calls**; or no model at all — the
  extractive fallback still answers with citations. No telemetry, no
  accounts; the egress inventory is public in `docs/data-flows.md`.
- **Feature focus:** model-agnosticism + provenance — flagship post.
  **Builds on:** #5.
- **Asset:** "model bay" graphic — seven slots + LOCAL + NONE into one
  harness, Beam style.
- **CTA:** lhvault.app. **Seed question:** "Which model would you plug in —
  and which would IT let you?"

## Week 4 — Model out of the loop

### 7) Tue Aug 11 · 45s screen capture · "Name the mess once"
- **Hook:** "Name a messy dataset once. Query the clean shape forever."
- **Beats:** **shaped views** — a shaping ask shows before/after samples,
  nothing saves until you approve; views compose, protect dependents, and
  never write rows to disk. Then work the answer: refinement chips,
  **Edit-SQL re-runs with no model in the loop**, model-free **recipes**
  (five built-ins, plus forecast-with-band and changepoint scan), an
  **assumption ledger** on every Beam answer, save as CSV / note /
  evidence pack.
- **Feature focus:** the workbench. **Builds on:** #3.
- **Asset:** 45s capture: shaping ask → approve → recipe → save.
- **CTA:** download and try one real question. **Seed question:** "What's
  the ugliest CSV you rename columns for every single month?"

### 8) Thu Aug 13 · GIF + text · "Monitors shouldn't improvise"
- **Hook:** "Pin the question. Board the pins. The harness re-checks —
  deterministically — and tells you what changed."
- **Beats:** pinned questions re-run the same SQL deterministically and
  alert on change; **Boards** arrange them into a living, local dashboard —
  freshness and what-changed badges, a refresh IS a real re-check, **no
  servers, no timers**; **proactive insights** scan your tables with no
  model in the loop and surface what stands out before you ask.
- **Feature focus:** boards + monitors. **Builds on:** #7 and #3.
- **Asset:** GIF: pin → board → change badge.
- **CTA:** download. **Seed question:** "What number do you re-check every
  Monday?"

## Week 5 — Harness meets your stack (4 posts)

### 9) Tue Aug 18 · 20s video · "One keystroke away"
- **Hook:** "Most search boxes make you go to them. Hold Ctrl + Super +
  Shift and the harness appears over your work."
- **Beats (launch copy):** summon → ask → stay; answers inline with
  citation chips; the answer holds on your desktop while you keep working;
  opt-in (the OS keyboard hook installs only if you enable it); plus the
  everyday speed batch — repeated asks replay from a **visibly marked
  cache** with one-click re-run, type-ahead over past asks, Ctrl/Cmd+P
  quick-open.
- **Feature focus:** widget + time-savers. **Builds on:** #4.
- **CTA:** download. **Seed question:** "Where would you summon it from —
  Excel, the browser, or your IDE?"

### 10) Wed Aug 19 · video · **Lighthouse × Wispr Flow** (full draft below)
- **Feature focus:** voice-first asking — on-device Whisper dictation,
  Wispr-style chord. **Builds on:** #9 + #6.

### 11) Thu Aug 20 · split-screen GIF · **Lighthouse × Obsidian** (full draft below)
- **Feature focus:** Markdown in (notes as corpus), Markdown out (notes,
  reports, investigation exports). **Builds on:** #5, #4, #7.

### 12) Fri Aug 21 · code-forward image · **Lighthouse × your agent stack (MCP + CLI)** (full draft below)
- **Feature focus:** the headless `lighthouse` CLI and the MCP server —
  automation through one audited chokepoint. **Builds on:** #6 egress
  story + #8 determinism.

## Week 6 — The proof-of-life

### 13) Tue Aug 25 · 60–75s video or 8-slide carousel · "A Tuesday in the harness"
- **Hook:** "One analyst. Any model. Every number carries its receipt."
- **Beats (chaining everything):** a board badge says revenue shifted (#8)
  → chord-summon over the spreadsheet (#9), dictate the follow-up (#10) →
  Beam proposes a multi-step plan; **approve the SQL before it runs**, the
  **cost meter** counts tokens and dollars (#3/#6) → the answer comes back
  **certified** against your revenue metric (semantic layer) → "Investigate
  the drop" writes a **model-free report into the vault**; export the
  investigation to Markdown — it opens in Obsidian (#11) → attach the
  **evidence pack** to the deck. Provenance stamp on every step.
- **CTA:** download. **Seed question:** "Which step would save you the most
  time?"

### 14) Wed Aug 26 · text or carousel · "The FAQ we'd want to read"
- **Hook:** "Hard questions, straight answers."
- **Beats:** *It has a CLI and an MCP server — is it an agent?* — no. Every
  automated ask goes through the **same audited chokepoint** as an app ask
  and is recorded identically; SQL is read-only; multi-step runs are
  **budgeted, never unbounded**, with plan approval; the only thing it
  writes is notes/reports/CSVs into your own vault. *Is it really local?* —
  no telemetry, no accounts; three user-initiated egress kinds; provenance
  stamp per answer; audit log + egress shield; `docs/data-flows.md` is the
  inventory. *Why does SmartScreen/Gatekeeper warn?* — installers are
  unsigned today; signing is wired, certificates pending — we'd rather say
  so than hide it. *What about big files?* — honest scale: streaming
  carries year-of-monthlies asks, and when a giant workbook is truncated,
  the answer *discloses it* in an engine-written footer. *No model
  configured?* — grounded, cited extractive answers, zero network.
- **Feature focus:** transparency as brand. **Builds on:** #6, #12.
- **CTA:** lhvault.app. **Seed question:** "What's your IT team's first
  question — we'll answer it in the comments."

### 15) Thu Aug 27 · carousel + flyer · "The model is a guest. The harness is yours."
- **Hook:** "15 posts, one promise: any model, your data, your receipts."
- **Beats:** recap slides — engine-verified SQL (#3) · citations + honest
  footers (#4) · guest list + locks (#5) · swap-the-model + provenance
  (#6) · views & recipes (#7) · boards (#8) · voice, notes & agents
  (#10–12); final slide = the Beam flyer with CTA.
- **CTA:** download at lhvault.app; **tag a data analyst** who still
  screenshots ChatGPT tables. **Seed question:** "Which post convinced you —
  or didn't?"

---

## Full draft captions — the three combo posts

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
> read, stamped **"Answered on this device."** Your voice transcribed on
> your machine, your files read on your terms, the answer carrying its
> receipt.
>
> Opt-in, off by default: the summon hook installs only if you enable it.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Wispr Flow is an independent product; no affiliation — we just share the
> reflex. 10/15 · The AI harness for analysts.)
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
> with **[n] citations that open the exact passage**, and the filesystem
> watcher picks up your edits live: write in Obsidian, ask in Lighthouse,
> no re-import, no sync step.
>
> It loops back, too. Answers and charts save as **plain Markdown notes**
> inside your vault; "Investigate X" writes a **report** there; a finished
> investigation **exports to Markdown** (references — never transcripts).
> Open any of it in Obsidian like a note you wrote — because it is one.
>
> A harness shouldn't be a silo: **plain files in, plain files out.** No
> plugin, no export wizard, no lock-in — and if you run the local model,
> your second brain never touches the network.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Obsidian is an independent product; no affiliation — your notes are just
> Markdown, and that's the point. 11/15 · The AI harness for analysts.)
>
> *How many notes deep is your vault? Would you let an AI cite them?*

- **Asset:** 20s split-screen GIF — left: Obsidian; right: Lighthouse
  citing a note; then an exported investigation appearing in Obsidian's
  file list.
- **Guardrail:** notes/reports/exports are files in *Lighthouse's* vault —
  the loop needs the user to open/include that folder in Obsidian. Phrase
  as "inside your vault … open it in Obsidian," never "syncs to Obsidian."

### Post 12 — Lighthouse × your agent stack: MCP + CLI (Fri Aug 21)

> **Your harness now has interfaces. Your audit log still sees everything.**
>
> New in 0.12: a headless **`lighthouse` CLI** — a true headless ask, no
> webview, no local HTTP port — and an **MCP server**, so the AI tools you
> already use can query *your* vault: curated files, engine-verified
> numbers, citations included.
>
> Here's the part your security team will actually like: both interfaces
> answer through the **same audited chokepoint** as the app. An automated
> ask is recorded exactly like one you typed — same provenance, same
> curation, same read-only SQL, same egress accounting. Automation without
> a side door.
>
> Script the Monday numbers. Wire your agent to ask grounded questions
> instead of guessing. The harness doesn't care who's asking — it holds the
> same rules for everyone.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (MCP is an open protocol; works with MCP-compatible clients. 12/15 · The
> AI harness for analysts.)
>
> *What's the first ask you'd automate?*

- **Asset:** code-forward Beam-style image — a terminal running
  `lighthouse ask "..."` beside the same answer in the app, one audit line
  under both.
- **Guardrail:** name no specific MCP client as "integrated"; MCP is an
  open protocol and compatibility is the protocol's, not a partnership.

---

## Asset production checklist

| Asset | Needed by | Status |
| --- | --- | --- |
| Quote-card #1 ("smarter model" hook, Beam style) | Jul 20 | to make |
| Data-analyst flyer, Beam + 0.12.2 (#2, #15) | done | `marketing/flyers/exports/…data-analyst.png` |
| Beam four-beats capture 30s (#3) | Jul 27 | to make (stills exist in `docs/brand/`) |
| Grounding carousel (#4) | Jul 29 | to make |
| Guest-list GIF (#5) | Aug 3 | to make |
| Model-bay graphic (#6) | Aug 5 | to make (7 slots + LOCAL + NONE) |
| Shaped-views capture 45s (#7) | Aug 10 | to make |
| Boards GIF (#8) | Aug 12 | to make |
| Summon video 20s (#9) | Aug 17 | to make |
| Wispr Flow combo video 25s (#10) | Aug 18 | to make |
| Obsidian split-screen GIF (#11) | Aug 19 | to make |
| MCP/CLI terminal image (#12) | Aug 20 | to make |
| Day-in-the-life video/carousel (#13) | Aug 24 | to make |
| FAQ carousel (#14) | Aug 25 | to make |
| Recap carousel (#15) | Aug 26 | to make |

All assets in the Beam identity (ink `#0E0F12` / paper / amber
`#E8A317→#FFC24D`, flat geometry, hairline strokes). Real screenshots in
`docs/brand/` (light + dark). Screen captures use a demo vault with
obviously-sample data; mocks keep the "Screens illustrative — sample data"
footer.

---

## Guardrails (claims discipline)

- Every product claim must trace to the 0.12.2 tree (release notes
  #150–#167, `docs/launch-copy.md`, `docs/data-flows.md`, README).
  Approved load-bearing claims now include, on top of the 0.11 set:
  **certified answers** (query-equivalence against blessed metric
  definitions) + trust check; the local semantic layer (definitions never
  egress); the budgeted Beam loop (step/deadline/token ceilings, never
  unbounded); cost meter with provider-reported tokens + labeled $
  estimate; two-phase **plan approval** (verbatim SQL preview); context
  manifest (metadata-only); provenance stamp per answer, proven to agree
  with the audit record; **local-only marks** (fail-closed, "n files
  hidden from cloud models" counter); "What the AI sees" inspector;
  per-folder curation rules; **evidence packs** (self-contained HTML,
  local-only); **investigations** (scoped, read-from-the-top, fork +
  Markdown export of references, never transcripts); **boards** (engine
  results only, freshness/what-changed badges, no timers, no servers);
  **shaped views** (guarded SELECT views, approval before save, no rows on
  disk); model-free **recipes** + assumption ledger; forecast + changepoint
  recipes with band charts; **proactive insights** (no model in the loop);
  deep-analysis "Investigate X" reports written into the vault; capability
  map; **headless CLI + MCP server through the audited chokepoint**;
  answer cache with visible replay marker; ask type-ahead; Ctrl/Cmd+P
  quick-open; citation→inspector preview; charts by default from verified
  rows + "Chart it" chip (zero model calls); honest scale disclosures;
  quick provider switch with the stamp following; ~300 MB installers,
  one-command install per platform.
- **Curation language (changed in 0.12):** the inclusion default is a
  *user choice* at onboarding — with no choice made it stays the
  conservative nothing-in-until-toggled. Say "you choose the posture;
  explicit toggles always win" — do NOT say flatly "files default to
  excluded" (the 0.11 phrasing) or "visible by default."
- **Harness language rules:** "harness" must cash out to a shipping
  mechanism named in the same post (see the mapping table).
- **Do NOT claim:** autonomous actions (every ask is user- or
  script-invoked through the audited chokepoint; writes confined to the
  vault); a plugin ecosystem beyond the MCP server; automatic multi-model
  routing (switching is manual); sharing/collab/cloud sync (none exists);
  **provider sign-in** (shipped inert — no vendor registration, no UI; not
  marketable); signed installers (unsigned today — see #14); "free trial"
  (it's a free download, no accounts or licensing); the retired steel/
  Forerunner visuals; partnerships with Wispr Flow, Obsidian, or any MCP
  client vendor.
- Sample numbers in mocks stay obviously illustrative and labeled.

---

## Measurement (LinkedIn-native — the product has no telemetry)

- **Phase 1–2:** impressions + follower delta (target: establish the
  series; engagement rate ≥ 4% on #3–4).
- **Phase 3–4:** saves + shares on #6 and #8 (the "screenshot-for-IT"
  posts). #6 is the flagship — if "Swap the model. Keep the harness."
  underperforms, revisit framing before week 5.
- **Phase 5:** comment depth on #10–12; outbound clicks reported by
  LinkedIn. #12 is the developer-analyst litmus — strong saves there
  justify a deeper automation thread later.
- **Phase 6:** clicks on #13/#15 + tags on #15. GitHub release download
  counts (public per-asset stats) remain the only conversion proxy
  consistent with a no-telemetry product — note the count the week before
  launch and the week after #15.
- Retro after week 6: keep the two best-performing formats, fold the rest
  into an evergreen monthly cadence.

## Backlog (not scheduled)

- Friday poll, week 1: "Would your IT team let you point an AI at client
  data?" (4 options).
- Meme-format repost of #3 if it overperforms.
- Financial-analyst campaign (September): reuse #5/#6/#14 angles with the
  Beam financial flyer (already refreshed) — provenance stamp, local-only
  locks, evidence packs are the finance hooks.
- Deep-dive automation thread if #12 overperforms: `lighthouse` CLI
  recipes, MCP + boards as a reporting pipeline.
- r/LocalLLaMA / Show HN / Product Hunt launches (see channel plan
  discussion): the 0.12.2 story — certified answers + plan approval +
  MCP — is the right launch vehicle; coordinate with week 3.
