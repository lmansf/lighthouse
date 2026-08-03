# Ready-to-post kit — LinkedIn data-analyst campaign (0.12.2)

Companion to `linkedin-data-analysts-schedule.md` — one self-contained
entry per post so posting is copy-paste. Captions follow the launch-copy
tone (plain, specific, honest — no superlatives) and only make claims
approved in the schedule's Guardrails. Post at **8:30 local**, from a
personal profile, with the media attached natively (upload the file —
don't link it). Carousels upload as **PDF document posts** on LinkedIn.

**Standard first comment (post it immediately, then pin it):**
> Free download — no account. Windows · macOS · Linux → https://lhvault.app

**Standard practice:** reply to every comment in the first hour. If the
thread is quiet after ~2 hours, post the seed question as a comment from
your own profile to restart it. Media marked *fallback* is a real product
screenshot already in the repo (`docs/brand/`) — use it if the primary
asset isn't produced in time; never delay a slot for an asset.

---

## 1 · Tue Jul 21 — "You don't need a smarter model"
- **Platform/format:** LinkedIn · text post + single image (quote card).
- **Goal:** open the series — name the trust gap; collect follows.
- **Media:** quote-card PNG, Beam style (to make). *Fallback:* text-only —
  this post works without an image.
- **Caption:**

> Every quarter, a smarter model. Every quarter, the same failure: a number you can't audit.
>
> The gap between analysts and AI was never intelligence. It's the layer around the model — what it's allowed to read, who checks its math, what leaves the building.
>
> A chat window has none of that. So the smartest model in the world still hands you a figure you can't put in a deck, because you can't show where it came from.
>
> That layer has a name: a harness.
>
> Over the next six weeks we'll show the one we built for analysts — where an engine does the arithmetic, every claim carries a citation, and every answer says exactly what left your machine. Usually: nothing.
>
> 1/15 · Lighthouse — the AI harness for analysts. Free for Windows, macOS & Linux → lhvault.app
>
> What would an AI have to show you before you'd put its number in a deck?
>
> #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst

## 2 · Thu Jul 23 — "Meet Lighthouse"
- **Platform/format:** LinkedIn · single-image post.
- **Goal:** introduce the product under the harness frame; first
  lhvault.app clicks.
- **Media:** `marketing/flyers/exports/lighthouse-flyer-data-analyst.png`
  (**exists** — Beam identity, 0.12.2 copy).
- **Caption:**

> Ask your data. Audit the answer.
>
> Lighthouse 0.12 is the AI harness for data analysts: bring any model — or run one entirely on your device. The harness does what a chat window can't:
>
> · Beam turns your question into one read-only SQL query. An embedded engine runs it on your machine — the model never does arithmetic.
> · The SQL is shown verbatim, with a freshness line naming the files it read.
> · Every claim carries a citation that opens the exact passage.
> · Every answer carries a provenance stamp: "Answered on this device" — or exactly what went to the vendor you chose.
>
> New in 0.12: certified answers, plan approval, boards, evidence packs.
>
> Free download · no account · Windows, macOS & Linux → lhvault.app
>
> 2/15 · The AI harness for analysts.
>
> Which model would you strap in first?
>
> #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst

## 3 · Tue Jul 28 — "The model doesn't do the math"
- **Platform/format:** LinkedIn · native video (~30s) or single image.
- **Goal:** land the core proof mechanic (engine-verified SQL); video views.
- **Media:** 30s screen capture of a real Beam ask (to make). *Fallback:*
  `docs/brand/chat-beam-answer-light.png` (real answer screen).
- **Caption:**

> In a harness, the model doesn't do arithmetic. It reads the answer off an engine that does.
>
> What happens when you ask Lighthouse about a spreadsheet:
>
> 1. Ask. The model sees only the shape of your tables — names, columns, a few sample rows — and writes one read-only SQL SELECT.
> 2. Execute. An embedded engine runs that SQL on your machine. Every number comes from the engine.
> 3. Verify. The answer leads with the figure, shows the result table and a chart drawn from those same verified rows — and prints the SQL it ran, plus which files it read and how fresh they were.
> 4. Keep. Save it as a CSV back into your vault — or as an evidence pack: one self-contained file with the question, narrative, table, chart, SQL and provenance.
>
> Wrong feels different when you can read the query.
>
> 3/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> Would seeing the SQL verbatim change what you'd trust?
>
> #DataAnalytics #AIforAnalysts #SQL #AIHarness

## 4 · Thu Jul 30 — "A harness feeds the model only what it can cite"
- **Platform/format:** LinkedIn · carousel (upload as PDF document post),
  5–6 slides.
- **Goal:** extend trust from numbers to prose; saves + shares.
- **Media:** grounding carousel (to make). *Fallback:* single image
  `docs/brand/chat-beam-answer-dark.png`.
- **Caption:**

> Every claim gets a footnote. Every footnote opens the exact passage.
>
> A harness feeds the model only what it can cite — and tells you when it couldn't:
>
> · Answers stream with [n] citations; click one and the inspector opens at the cited chunk, highlighted.
> · Ask about one document and Lighthouse reads all of it. Very long files are read section by section — with an honest note saying so.
> · Multi-document questions get map-reduce synthesis.
> · Retrieval keeps table headers on every chunk, so spreadsheet answers keep their column names.
> · Truncations, skipped files and cached replays are disclosed in fixed, engine-written footers the model can't reword.
>
> Honesty is a feature. It ships in the footers.
>
> 4/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> What's the longest document you'd ask about?
>
> #DataAnalytics #AIforAnalysts #RAG #AIHarness

## 5 · Tue Aug 4 — "The harness holds the guest list"
- **Platform/format:** LinkedIn · GIF/short video post.
- **Goal:** the control story (curation + locks); IT-friendly saves.
- **Media:** 10s toggle/rule/lock GIF (to make). *Fallback:*
  `docs/brand/main-window-light.png` (explorer with eye + lock icons).
- **Caption:**

> The AI reads a file when you say so. And "this device only" means a cloud model never sees it.
>
> In Lighthouse, you hold the guest list:
>
> · Per-file visibility toggles — and you choose the default posture at onboarding. Nothing-in-until-toggled is the conservative default; your explicit toggles always win either way.
> · Folder rules cover files that arrive later — next quarter's export lands already covered.
> · Lock any file or folder "Private — this device only" and it's enforced fail-closed at every choke point. The chat header counts exactly how many files are hidden from cloud models.
> · "What the AI sees" shows the exact text extracted from any file, chunk by chunk.
>
> Adds are link-in-place — nothing copied, nothing uploaded.
>
> 5/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> Which folder gets locked first?
>
> #DataAnalytics #AIforAnalysts #DataPrivacy #LocalFirst

## 6 · Thu Aug 6 — "Swap the model. Keep the harness." (flagship)
- **Platform/format:** LinkedIn · single image (model-bay graphic).
- **Goal:** the pivot's flagship claim — model-agnosticism + provenance;
  watch saves/shares closely (schedule says revisit framing if weak).
- **Media:** model-bay graphic — seven provider slots + LOCAL + NONE into
  one harness (to make). *Fallback:* `docs/brand/settings-light.png`.
- **Caption:**

> Models churn every quarter. Your harness shouldn't.
>
> Lighthouse is model-agnostic by design:
>
> · Bring a key: Claude, GPT, Gemini, Grok, Mistral or DeepSeek — sealed with AES-256-GCM on your disk, switchable mid-chat.
> · Or run the bundled on-device model (a one-time ~4.2 GB download, GPU-offloaded where available): answering makes zero network calls. Turn off Wi-Fi and ask anyway.
> · Or run no model at all — the zero-network fallback still answers, with citations.
>
> Whichever you pick, the provenance stamp follows: "Answered on this device," or "Answered via <vendor> — N excerpts from M files sent." Computed by the engine, checked against the audit log.
>
> No telemetry. No accounts. The complete egress inventory is public in the repo (docs/data-flows.md).
>
> 6/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> Which model would you plug in — and which would IT let you?
>
> #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst

## 7 · Tue Aug 11 — "Name the mess once"
- **Platform/format:** LinkedIn · native video (~45s).
- **Goal:** the workbench story (shaped views + recipes); downloads.
- **Media:** 45s capture — shaping ask → before/after → approve → recipe →
  save (to make). *Fallback:* `docs/brand/chat-beam-answer-light.png`.
- **Caption:**

> Name a messy dataset once. Query the clean shape forever.
>
> New in 0.12 — shaped views: ask for the shape you want, see an engine-rendered before/after preview, and save it as a named view. Nothing persists until you approve, and views never write rows to disk — your source files stay untouched.
>
> Then work the answer like a workbench:
>
> · Refinement chips — or edit the SQL by hand and re-run it. No model in the loop.
> · Model-free recipes, including forecast (with an uncertainty band) and changepoint scan.
> · An assumption ledger on every Beam answer — what the engine assumed, written by the engine.
> · Save any result as a CSV, a note, or an evidence pack.
>
> 7/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> What's the ugliest CSV you re-clean every month?
>
> #DataAnalytics #AIforAnalysts #SQL #AIHarness

## 8 · Thu Aug 13 — "Monitors shouldn't improvise"
- **Platform/format:** LinkedIn · GIF/short video + text.
- **Goal:** boards + deterministic monitors; the "screenshot-for-IT" share.
- **Media:** pin → board → change-badge GIF (to make). *Fallback:*
  `docs/brand/main-window-dark.png`.
- **Caption:**

> You can't monitor a KPI with a slot machine.
>
> Pin a question in Lighthouse and it re-runs the same SQL, deterministically, on fresh data — and alerts you when the answer changes. No model drift, no re-prompting.
>
> New in 0.12 — Boards: arrange your pins into a living, local dashboard. Cards render engine results only; freshness and what-changed badges say what moved; a refresh IS a real re-check. No servers. No timers. Nothing leaves your machine to keep it live.
>
> And before you even ask: proactive insights scan your tables — no model in the loop — and surface what stands out.
>
> 8/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> What number do you re-check every Monday?
>
> #DataAnalytics #BusinessIntelligence #AIforAnalysts #AIHarness

## 9 · Tue Aug 18 — "One keystroke away"
- **Platform/format:** LinkedIn · native video (~20s).
- **Goal:** open ecosystem week — the widget habit; downloads.
- **Media:** 20s summon video, mid-spreadsheet (to make). *Fallback:*
  `docs/brand/widget-light.png` (real widget screenshot).
- **Caption:**

> Most search boxes make you go to them. This one comes to you.
>
> Hold Ctrl + Super + Shift — no letter key — and Lighthouse's ask-bar appears over whatever you're working on. Ask; the answer streams inline, cited to your own documents; it holds on your desktop while you keep reading; the same chord dismisses it.
>
> Opt-in and off by default: the OS keyboard hook installs only if you enable it.
>
> The everyday speed is the point:
> · A repeated ask replays instantly from a visibly marked cache — one click re-runs it fresh.
> · Type-ahead recalls past asks; ↑ recalls your last one.
> · Ctrl/Cmd+P finds any file in the vault.
>
> 9/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> Where would you summon it from — Excel, the browser, or your IDE?
>
> #DataAnalytics #AIforAnalysts #Productivity #LocalFirst

## 10 · Wed Aug 19 — Lighthouse × Wispr Flow
- **Platform/format:** LinkedIn · native video (~25s).
- **Goal:** voice-first workflow; reach the Flow/voice-computing crowd.
- **Media:** 25s video — chord, spoken question, cited answer; overlay
  "dictation runs on-device" (to make). *Fallback:*
  `docs/brand/widget-dark.png`.
- **Caption:**

> If Wispr Flow taught you to talk to your computer, this is the same reflex — pointed at everything you've ever saved.
>
> Flow users have the muscle memory: hold a chord, speak, done. Lighthouse gives your files that reflex. Hold Ctrl + Super + Shift — a modifier-only chord, no letter key — and a floating ask-bar appears over whatever you're working on.
>
> Then just talk. Lighthouse ships on-device Whisper dictation — voice input runs in-process, no sockets, no audio leaving your machine. And because the bar is an ordinary text field with the caret ready, Wispr Flow itself types into it perfectly if you'd rather keep dictating your way.
>
> "Which region drove Q2 revenue growth?" — spoken, not typed — comes back as a cited answer backed by one read-only SQL query you can open and read, stamped "Answered on this device."
>
> Opt-in, off by default: the summon hook installs only if you enable it.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Wispr Flow is an independent product; no affiliation — we just share the reflex. 10/15 · The AI harness for analysts.)
>
> What's the first question you'd ask out loud?
>
> #AIforAnalysts #VoiceComputing #Productivity #LocalFirst

## 11 · Thu Aug 20 — Lighthouse × Obsidian
- **Platform/format:** LinkedIn · GIF/short video (split-screen).
- **Goal:** the PKM/notes crowd; comment depth on stacks.
- **Media:** 20s split-screen — Obsidian edit → Lighthouse citation →
  exported investigation appearing in Obsidian (to make). *Fallback:*
  text-only, or `docs/brand/main-window-light.png`.
- **Caption:**

> Your Obsidian vault is already a corpus. Give it a harness.
>
> An Obsidian vault is Markdown on disk. That's exactly what Lighthouse reads. Add the folder — link-in-place, nothing copied, nothing uploaded — and ask questions across years of notes. Answers come back with [n] citations that open the exact passage, and the filesystem watcher picks up your edits live: write in Obsidian, ask in Lighthouse, no re-import, no sync step.
>
> It loops back, too. Answers and charts save as plain Markdown notes inside your vault; "Investigate X" writes a report there; a finished investigation exports to Markdown (references — never transcripts). Open any of it in Obsidian like a note you wrote — because it is one.
>
> A harness shouldn't be a silo: plain files in, plain files out. No plugin, no export wizard, no lock-in — and if you run the local model, your second brain never touches the network.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (Obsidian is an independent product; no affiliation — your notes are just Markdown, and that's the point. 11/15 · The AI harness for analysts.)
>
> How many notes deep is your vault? Would you let an AI cite them?
>
> #Obsidian #PKM #AIforAnalysts #LocalFirst

## 12 · Fri Aug 21 — Lighthouse × your agent stack (MCP + CLI)
- **Platform/format:** LinkedIn · single image (code-forward).
- **Goal:** the developer-analyst litmus (schedule: strong saves here
  justify a deeper automation thread).
- **Media:** Beam-style terminal image — `lighthouse ask "…"` beside the
  same answer in-app, one audit line under both (to make). *Fallback:*
  text-only.
- **Caption:**

> Your harness now has interfaces. Your audit log still sees everything.
>
> New in 0.12: a headless `lighthouse` CLI — a true headless ask, no webview, no local HTTP port — and an MCP server, so the AI tools you already use can query your vault: curated files, engine-verified numbers, citations included.
>
> Here's the part your security team will actually like: both interfaces answer through the same audited chokepoint as the app. An automated ask is recorded exactly like one you typed — same provenance, same curation, same read-only SQL, same egress accounting. Automation without a side door.
>
> Script the Monday numbers. Wire your agent to ask grounded questions instead of guessing. The harness doesn't care who's asking — it holds the same rules for everyone.
>
> Free download — Windows · macOS · Linux · no account → lhvault.app
>
> (MCP is an open protocol; works with MCP-compatible clients. 12/15 · The AI harness for analysts.)
>
> What's the first ask you'd automate?
>
> #MCP #DataAnalytics #AIforAnalysts #AIHarness

## 13 · Tue Aug 25 — "A Tuesday in the harness"
- **Platform/format:** LinkedIn · native video (60–75s) or carousel (PDF).
- **Goal:** capstone — every feature in one workflow; downloads.
- **Media:** day-in-the-life video/carousel (to make). *Fallback:*
  carousel from `docs/brand/` stills (tour, chat, widget) + flyer.
- **Caption:**

> One analyst. Any model. Every number carries its receipt.
>
> A Tuesday with Lighthouse 0.12:
>
> 8:55 — A board badge says EMEA revenue moved. The card re-checked deterministically; the freshness badge names the file that changed.
> 9:10 — Chord-summon over the spreadsheet. Dictate the follow-up — on-device Whisper, no audio leaves the machine.
> 9:12 — Beam proposes a multi-step plan. The SQL is previewed verbatim; approve it; the cost meter counts tokens and dollars as it runs.
> 9:15 — The margin number comes back certified — it matches the metric definition your team blessed.
> 9:20 — "Investigate the drop." A model-free report lands in the vault, references included. Export the investigation to Markdown; it opens in Obsidian.
> 9:30 — Attach the evidence pack to the deck: question, table, chart, SQL, provenance. One file.
>
> Every step stamped: Answered on this device.
>
> 13/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> Which step would save you the most time?
>
> #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst

## 14 · Wed Aug 26 — "The FAQ we'd want to read"
- **Platform/format:** LinkedIn · text post (or 5-slide carousel).
- **Goal:** close objections in public; comment engine ("we'll answer in
  the comments").
- **Media:** optional FAQ carousel (to make). *Fallback:* text-only —
  works fine.
- **Caption:**

> Hard questions, straight answers.
>
> "It has a CLI and an MCP server — is it an agent?" No. Every automated ask goes through the same audited chokepoint as an app ask and is recorded identically. SQL is read-only. Multi-step runs are budgeted — steps, deadline, tokens — never unbounded, with plan approval when you want eyes on the SQL first. The only thing Lighthouse writes is notes, reports and CSVs into your own vault.
>
> "Is it really local?" No telemetry, no accounts. Three kinds of outbound request, all user-initiated. A provenance stamp on every answer; a local audit log and egress shield count every byte out. The full inventory ships in the repo: docs/data-flows.md.
>
> "Why does SmartScreen warn on install?" Installers are unsigned today. The signing pipeline is wired; certificates are pending. We'd rather tell you than hide it.
>
> "And big files?" Honest scale: streaming carries a year of big monthlies, and when a giant workbook is truncated, the answer says so — in a footer the model can't reword.
>
> "No model configured?" You still get grounded, cited extractive answers. Zero network.
>
> 14/15 · Lighthouse — the AI harness for analysts. Free → lhvault.app
>
> What's your IT team's first question? We'll answer it in the comments.
>
> #DataAnalytics #AIforAnalysts #DataPrivacy #AIHarness

## 15 · Thu Aug 27 — "The model is a guest. The harness is yours."
- **Platform/format:** LinkedIn · carousel (PDF document post), final
  slide = flyer.
- **Goal:** recap + tag-an-analyst CTA; last download push.
- **Media:** recap carousel (to make); final slide
  `marketing/flyers/exports/lighthouse-flyer-data-analyst.png` (**exists**).
  *Fallback:* post the flyer alone.
- **Caption:**

> 15 posts, one promise: any model, your data, your receipts.
>
> The case, in one carousel:
>
> · The engine does the math — one read-only SQL query, shown verbatim (3/15)
> · Citations open the exact passage; honest footers disclose the edges (4/15)
> · You hold the guest list — and "this device only" locks are enforced fail-closed (5/15)
> · Swap the model, keep the harness; the provenance stamp follows (6/15)
> · Views and recipes clean the mess with no model in the loop (7/15)
> · Boards re-check your KPIs deterministically (8/15)
> · Voice in, notes out, agents welcome — through one audited chokepoint (10–12/15)
>
> Lighthouse 0.12 — the AI harness for analysts. Free, no account: Windows, macOS & Linux → lhvault.app
>
> Know a data analyst who still screenshots ChatGPT tables? Tag them.
>
> Which post convinced you — or didn't?
>
> #DataAnalytics #AIforAnalysts #AIHarness #LocalFirst
