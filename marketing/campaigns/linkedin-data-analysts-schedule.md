# LinkedIn campaign — data analysts (6 weeks, Jul 21 – Aug 27, 2026)

A progressive-hype schedule: each week raises the stakes and each post builds
on features established by earlier posts, ending in ecosystem combos
(Wispr Flow, Obsidian) and a capstone workflow. Fourteen posts total —
2/week ramping to 3/week for the final two weeks.

**Audience:** data analysts (LinkedIn) — people who live in spreadsheets and
BI tools, are AI-curious but burned by hallucinated numbers, and often work
under IT/security constraints.

**Positioning line (repeat everywhere):** *Local-first, grounded, cited —
answers you can audit.*

**Source of truth for claims:** the 0.11 `README.md`, `docs/launch-copy.md`,
`docs/data-flows.md`. If a claim isn't in those, it doesn't go in a post
(see Guardrails).

---

## Narrative arc

| Phase | Week(s) | Job of the phase | Escalating CTA |
| --- | --- | --- | --- |
| 1. The wound | 1 | Name the pain: you can't audit an AI's number | Follow the series |
| 2. The receipt | 2 | Proof mechanics: verified SQL, citations | Watch the demo clip |
| 3. The keys | 3 | Control: curated inclusion, local-first, your model | Visit lhvault.app |
| 4. The engine | 4 | Power workflows: Edit-SQL, charts, pinned alerts | Download & try one ask |
| 5. The ecosystem | 5 | It fits your stack: widget + Wispr Flow + Obsidian | Download; comment your stack |
| 6. The proof-of-life | 6 | Capstone workflow, honest FAQ, recap | Download; tag an analyst |

Every post carries a series marker (“n/14”), the positioning line, and ends
with a question to seed comments. Mock screens always carry the
“Screens illustrative — sample data” note, matching the flyers.

---

## Mechanics

- **Cadence:** Tue + Thu, 8:30am audience-local; weeks 5–6 add Wednesday.
- **Hook discipline:** first ~200 characters must work before LinkedIn's
  “…see more” fold — lead with the claim, not the product name.
- **Links:** `https://lhvault.app` goes in the post *and* pinned first
  comment (algo hedge). No UTM promises — the product has no telemetry, and
  measurement stays LinkedIn-native (see Measurement).
- **Hashtags (≤4, niche):** #DataAnalytics #LocalFirst #RAG #AIforAnalysts.
- **Visual system:** the Forerunner night-steel style from
  `marketing/flyers/` (same palette, lighthouse mark, brass beam) so the
  series is recognizable in-feed.
- **Comments:** author replies within the first hour; seeded question per
  post is listed below.

---

## Week 1 — The wound (trust)

### 1) Tue Jul 21 · text + quote-card image · “Which of these numbers is made up?”
- **Hook:** “An AI just gave you four beautiful numbers. One is invented. Which one?”
- **Beats:** the real blocker for analysts isn't speed, it's *auditability*;
  copy-pasting a hallucinated stat into a deck is a career risk; you
  shouldn't have to choose between AI and being able to show your work.
  Tease: “Over the next six weeks we'll show a different way. 1/14.”
- **Feature focus:** none yet — pain only. **Builds on:** —
- **Asset:** dark quote-card (Forerunner style) with the hook line.
- **CTA:** follow for the series. **Seed question:** “What's your rule for
  trusting an AI-generated number?”

### 2) Thu Jul 23 · image post (existing flyer) · “Meet Lighthouse”
- **Hook:** “Ask your data. Audit the answer.”
- **Beats:** Lighthouse in three sentences — a local-first vault of your
  files; grounded chat that answers *only* from what you include, with
  citations; analytics that run as one read-only SQL query you can read.
  Windows · macOS · Linux, free download, no account.
- **Feature focus:** product intro. **Builds on:** the trust gap from #1.
- **Asset:** `marketing/flyers/exports/lighthouse-flyer-data-analyst.png` (exists).
- **CTA:** lhvault.app. **Seed question:** “What file would you point it at first?”

## Week 2 — The receipt (proof mechanics)

### 3) Tue Jul 28 · 30s screen capture · “The SQL is the receipt”
- **Hook:** “Our AI doesn't do math. It reads the answer off an engine that does.”
- **Beats:** ask a question over a CSV → Lighthouse plans **one read-only SQL
  SELECT** → an embedded engine (DataFusion) executes it → the model narrates
  the *verified* result; the SQL is shown verbatim with a freshness footer.
  Wrong feels different when you can read the query.
- **Feature focus:** Beam analytics core. **Builds on:** #1's “which number
  is made up?” — answer: none, here's the receipt.
- **Asset:** screen capture of the real flow (or annotated still from the
  flyer mock, labeled illustrative).
- **CTA:** watch the clip, lhvault.app. **Seed question:** “Would showing
  the SQL verbatim change what you'd trust?”

### 4) Thu Jul 30 · carousel (5–6 slides) · “Anatomy of a grounded answer”
- **Hook:** “Every claim gets a footnote. Every footnote opens the file.”
- **Beats (one per slide):** [n] citations stream inline → Related-files
  cards → whole-document answers (ask about one doc, it reads *all* of it;
  very long files read section-by-section with an honest note) → multi-doc
  questions get map-reduce synthesis → hybrid retrieval (lexical + on-device
  embeddings) keeps table headers on every chunk so spreadsheet answers
  don't lose their column names.
- **Feature focus:** grounded chat + retrieval. **Builds on:** #3 (numbers
  verified; now *prose* is verifiable too).
- **Asset:** carousel in the series style.
- **CTA:** lhvault.app. **Seed question:** “What's the longest doc you'd ask about?”

## Week 3 — The keys (control & privacy)

### 5) Tue Aug 4 · GIF · “Your AI reads on a need-to-know basis”
- **Hook:** “Files default to excluded. The AI sees a document when you flip
  its toggle — and not before.”
- **Beats:** curated inclusion (a file is readable only when its own toggle
  is on and no ancestor folder is excluded); adds are link-in-place (nothing
  copied); removal is non-destructive (recoverable trash); a filesystem
  watcher keeps the tree live.
- **Feature focus:** the vault/explorer. **Builds on:** #4 — citations are
  only trustworthy if you control the corpus they cite.
- **Asset:** 10s GIF of toggles flipping, folder exclusion overriding.
- **CTA:** lhvault.app. **Seed question:** “What would you *exclude* first?”

### 6) Thu Aug 6 · image (egress table) · “Works in airplane mode”
- **Hook:** “Turn off Wi-Fi. Ask anyway.”
- **Beats:** engine, index, embeddings, OCR all run on-device; pick the
  bundled private model (opt-in ~4.2 GB Mistral-7B download, GPU-offloaded
  where available) and answering makes **zero network calls** — or bring a
  key for Claude, GPT, Gemini, Grok, Mistral, DeepSeek (keys sealed
  AES-256-GCM on disk); no model at all still answers with citations via the
  zero-network extractive fallback. No telemetry, no accounts; the complete
  egress inventory is public in `docs/data-flows.md`.
- **Feature focus:** local-first + model choice. **Builds on:** #5 (you
  control what it reads; now, where it runs).
- **Asset:** “What leaves your machine” table graphic (3 rows, all opt-in).
- **CTA:** lhvault.app. **Seed question:** “Does your team allow cloud AI on
  client data?”

## Week 4 — The engine (power workflows)

### 7) Tue Aug 11 · 45s screen capture · “Question → SQL → chart → CSV, one thread”
- **Hook:** “Refine the question with chips. Edit the SQL by hand. The model
  doesn't get a vote on the numbers.”
- **Beats:** refinement chips; **Edit-SQL re-runs with no model in the
  loop**; multi-step analytics; union tables + join hints across files;
  charts render in chat; save any result as CSV, PNG, or a note in your
  vault.
- **Feature focus:** analytics power tools. **Builds on:** #3 (the receipt
  becomes a workbench).
- **Asset:** 45s capture of chips → edit → chart → save.
- **CTA:** download and try one real question. **Seed question:** “Chips or
  raw SQL — which would you touch first?”

### 8) Thu Aug 13 · GIF + text · “Turn a question into a monitor”
- **Hook:** “Pin the question. It re-runs the same SQL, deterministically —
  and pings you when the answer changes.”
- **Beats:** pinned questions re-run deterministically on fresh data and
  alert on change; the freshness footer says exactly what data vintage
  answered; deterministic = same question, same SQL, no model drift.
- **Feature focus:** pinned questions. **Builds on:** #7 (workflows) and #3
  (determinism only matters because the SQL is real).
- **Asset:** GIF: pin → data file updates → alert.
- **CTA:** download. **Seed question:** “What number do you re-check every
  Monday?”

## Week 5 — The ecosystem (ramp to 3 posts)

### 9) Tue Aug 18 · 20s video · “Whisper mode: the search box comes to you”
- **Hook:** “Most search boxes make you go to them. Hold Ctrl + Super + Shift
  and this one appears over your work.”
- **Beats (from docs/launch-copy.md):** summon → ask → stay: the floating
  ask-bar appears over whatever you're doing, answers inline with citation
  chips, and the answer freezes on your desktop while you keep working;
  opt-in (installs an OS keyboard hook only if you enable it); dismiss with
  the same chord.
- **Feature focus:** desktop widget + Whisper summon. **Builds on:** #4's
  citations, now zero-context-switch.
- **Asset:** 20s summon video, mid-spreadsheet.
- **CTA:** download. **Seed question:** “Where would you summon it from —
  Excel, the browser, or your IDE?”

### 10) Wed Aug 19 · video · **Lighthouse × Wispr Flow** (full draft below)
- **Feature focus:** voice-first asking — built-in on-device Whisper
  dictation, Wispr-style chord. **Builds on:** #9 (the bar) + #6 (local-only
  audio).

### 11) Thu Aug 20 · split-screen GIF · **Lighthouse × Obsidian** (full draft below)
- **Feature focus:** Markdown in (your notes as corpus), Markdown out
  (answers saved as notes). **Builds on:** #5 (link-in-place vault), #4
  (citations), #7 (save-as-note).

## Week 6 — The proof-of-life (capstone)

### 12) Tue Aug 25 · 60–75s video or 8-slide carousel · “A Tuesday with Lighthouse”
- **Hook:** “One analyst. Zero uploads. Every number cited.”
- **Beats (day-in-the-life, chaining every prior post):** morning — a
  briefing note saved into the vault; a pinned question fires an alert
  (#8) → chord-summon over the spreadsheet (#9), dictate the follow-up
  (#10) → read the SQL, edit one clause, re-run (#7 / #3) → save the chart
  and a Markdown note; it shows up in Obsidian (#11) — all without a file
  leaving the machine (#6), from a corpus you curated (#5), with citations
  throughout (#4).
- **CTA:** download. **Seed question:** “Which step would save you the most
  time?”

### 13) Wed Aug 26 · text or carousel · “The FAQ we'd want to read”
- **Hook:** “Hard questions, straight answers.”
- **Beats:** *Is it really local?* — the app phones nothing home; three
  user-initiated outbound request kinds only; a local audit log and egress
  transparency panel show every byte out; full inventory in
  `docs/data-flows.md`, written for security review. *Why does SmartScreen /
  Gatekeeper warn?* — installers are currently unsigned; the signing
  pipeline is wired and documented, certificates pending — we'd rather tell
  you than hide it. *Is it fast?* — a ten-thousand-file vault indexes in
  under a second (launch-copy claim). *What if I configure no model?* — you
  still get grounded, cited extractive answers, zero network.
- **Feature focus:** transparency as brand. **Builds on:** #6, closes
  objections before the finale.
- **CTA:** lhvault.app. **Seed question:** “What's your IT team's first
  question — we'll answer it in the comments.”

### 14) Thu Aug 27 · carousel + flyer refresh · “14 posts, one promise”
- **Hook:** “Answers you can audit. Here's the whole case in one carousel.”
- **Beats:** recap slides — verified SQL (#3) · citations (#4) · curated
  inclusion (#5) · fully local option (#6) · pinned alerts (#8) · voice +
  notes ecosystem (#10–11); final slide = flyer with CTA.
- **CTA:** download at lhvault.app; **tag a data analyst** who still
  screenshots ChatGPT tables. **Seed question:** “Which post convinced you —
  or didn't?”

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
> “Which region drove Q2 revenue growth?” — spoken, not typed — comes back
> as a **cited answer** on top of your spreadsheet, backed by one read-only
> SQL query you can open and read. Speak the question; audit the answer.
>
> Opt-in, off by default: the summon hook installs only if you enable it.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Wispr Flow is an independent product; no affiliation — we just share the
> reflex. 10/14 · Local-first, grounded, cited.)
>
> *What's the first question you'd ask out loud?*

- **Asset:** 25s video — analyst mid-Excel, hands off keyboard except the
  chord, speaks the question, cited answer streams inline. Caption overlay:
  “dictation runs on-device.”
- **Guardrail:** never imply partnership/integration beyond “it's a text
  field, Flow types anywhere” + our own built-in dictation.

### Post 11 — Lighthouse × Obsidian (Thu Aug 20)

> **Your Obsidian vault is already a corpus. Give it an engine.**
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
> Plain files in. Plain files out. No plugin, no export wizard, no lock-in —
> and if you run the local model, your second brain never touches the
> network.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Obsidian is an independent product; no affiliation — your notes are just
> Markdown, and that's the point. 11/14 · Local-first, grounded, cited.)
>
> *How many notes deep is your vault? Would you let an AI cite them?*

- **Asset:** 20s split-screen GIF — left: Obsidian note being edited; right:
  Lighthouse answering with a citation chip that names the note; then
  save-as-note and the new file appearing in Obsidian's file list.
- **Guardrail:** notes save to `Lighthouse Notes/` in *Lighthouse's* vault —
  the loop needs the user to open/include that folder in Obsidian. Phrase as
  “inside your vault … open it in Obsidian,” never “syncs to Obsidian.”

---

## Asset production checklist

| Asset | Needed by | Status |
| --- | --- | --- |
| Quote-card #1 (Forerunner style) | Jul 20 | to make |
| Data-analyst flyer (#2, #14) | done | `marketing/flyers/exports/…data-analyst.png` |
| Beam analytics capture 30s (#3) | Jul 27 | to make |
| Grounded-answer carousel (#4) | Jul 29 | to make |
| Inclusion-toggles GIF (#5) | Aug 3 | to make |
| Egress-table graphic (#6) | Aug 5 | to make (source: docs/data-flows.md) |
| Power-workflow capture 45s (#7) | Aug 10 | to make |
| Pin-alert GIF (#8) | Aug 12 | to make |
| Summon video 20s (#9) | Aug 17 | to make |
| Wispr Flow combo video 25s (#10) | Aug 18 | to make |
| Obsidian split-screen GIF (#11) | Aug 19 | to make |
| Day-in-the-life video/carousel (#12) | Aug 24 | to make |
| FAQ carousel (#13) | Aug 25 | to make |
| Recap carousel (#14) | Aug 26 | to make |

Screen captures should use a demo vault with obviously-sample data; keep the
“Screens illustrative — sample data” footer when a mock (not the real app)
is shown.

---

## Guardrails (claims discipline)

- Every product claim must trace to `README.md`, `docs/launch-copy.md`, or
  `docs/data-flows.md`. Current approved load-bearing claims: read-only SQL
  via embedded engine, SQL shown verbatim, freshness footer, [n] citations,
  whole-document reads + honest sectioning, map-reduce multi-doc, hybrid
  retrieval with on-device embeddings, headers-on-every-chunk, curated
  inclusion defaults-excluded, link-in-place, non-destructive removal, live
  watcher, on-device OCR, private model opt-in ~4.2 GB Mistral-7B with GPU
  offload, six BYO-key providers, AES-256-GCM-sealed keys, zero-network
  extractive fallback, no telemetry/accounts, audit log + egress panel,
  Ctrl+Super+Shift opt-in summon, on-device Whisper dictation,
  save-as-CSV/PNG/note into `Lighthouse Notes/`, briefings,
  10k-file-vault-indexes-under-a-second, Win/macOS/Linux, free download.
- **Never claim:** partnerships or integrations with Wispr Flow or Obsidian
  (independent products; our compatibility is “plain text fields” and
  “plain Markdown files”); signed installers (still unsigned — see #13);
  benchmarks beyond the launch-copy indexing line; “free trial” (stale
  launch-copy phrasing — it's a free download, no accounts or licensing).
- Sample numbers in mocks stay obviously illustrative and labeled.

---

## Measurement (LinkedIn-native — the product has no telemetry)

- **Phase 1–2:** impressions + follower delta (target: establish the series;
  engagement rate ≥ 4% on #3–4).
- **Phase 3–4:** saves + shares on #6 and #8 (the “screenshot-for-IT” posts).
- **Phase 5:** comment depth on #10–11 (stack questions are comment bait);
  outbound clicks reported by LinkedIn.
- **Phase 6:** clicks on #12/#14 + tags on #14. GitHub release download
  counts (public per-asset stats) are the only conversion proxy consistent
  with a no-telemetry product — note the count the week before launch and
  the week after #14.
- Retro after week 6: keep the two best-performing formats, fold the rest
  into an evergreen monthly cadence.

## Backlog (not scheduled)

- Friday poll, week 1: “Do you trust AI with your spreadsheets?” (4 options).
- Meme-format repost of #3 if it overperforms.
- IT-security-director companion thread (the other README persona) reusing
  #6 + #13 — candidate for a September campaign with the
  financial-analyst flyer.
