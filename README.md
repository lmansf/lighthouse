# Lighthouse Vault

Curate which of your files and data sources your AI can see.
Browse files in a calm, sandy-beach File-Explorer-style UI (red used sparingly as the beacon accent), toggle items **in** or **out** of the RAG index, and ask a Google-style chat that answers only from what you've included. Local-first: your documents stay in a folder on your own machine.

> The npm package is still named `rag-vault`; the product and repo are **Lighthouse**.

## Run it

### Desktop app (recommended)

Lighthouse runs as a persistent desktop app (system tray, opt-out
launch-at-login, native file/vault dialogs). You don't need a terminal:

- **Just run it** — extract the repo and double-click **`Lighthouse.cmd`**
  (Windows) or **`Lighthouse.command`** (macOS/Linux). The first launch installs
  and builds; every launch after that opens the app. Needs [Node.js](https://nodejs.org).
- **Make a shareable installer** — double-click **`Build-Installer.cmd`** on
  Windows to produce a standalone `.exe` in `release/` that end users install
  with no Node.js, build, or terminal.

See **[docs/desktop.md](docs/desktop.md)** for details, the one-line terminal
installer, and packaging notes.

### Web / development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build && npm run start   # production server
npm run electron                 # desktop app (after build)
```

## Architecture

This repo is structured so independent agent teams can each own one feature in its own git worktree and converge cleanly.
Everything decouples through `src/contracts/` (typed interfaces + swappable implementations, real or mock) and two Zustand stores.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - the design, the contract seam, and the rules of the road.
- **docs/agents/** - one brief per feature team: [shell](docs/agents/shell.md), [onboarding](docs/agents/onboarding.md), [explorer](docs/agents/explorer.md), [chat](docs/agents/chat.md).

The feature components in `app/page.tsx` are working placeholders today - each team replaces its own.

## Backend (local-first, standalone)

The mocks are now backed by a real **local-first** implementation behind the same
contracts — no cloud database required:

- **Files** live in a real directory (`./vault`, or set `VAULT_DIR` to any path).
  The explorer lists them; inclusion flags persist to `vault/.rag-vault/state.json`.
  Inclusion defaults to **excluded**: a node is retrievable only if its own flag
  is explicitly on *and* no ancestor folder is excluded, so anything newly added
  from disk stays out until you opt it in and an excluded folder forces every
  descendant out. The explorer keeps the tree live — it re-scans the vault in the
  background (and on a toolbar **Refresh**), so files copied into the vault folder
  outside an in-app upload appear on their own. Files can also be moved within the vault (`op:move`), which
  carries their inclusion flags to the new location. Whole folders upload with
  their structure, and the desktop app can **link** files/folders in place
  (`op:addReference` / `op:removeReference`) — indexing them from their real
  location on disk instead of copying a second time. Items can be **removed from
  the vault** non-destructively (`op:remove`): a vault file/folder moves to a
  recoverable trash (`.rag-vault/trash/<date>/`) and a linked item only unlinks,
  leaving your real files in place.
- **Retrieval** is real TF-IDF cosine over the text of the *included* files,
  combined with a file name/path match so a file is findable by what it's *called*
  as well as what it contains (a file named `creditcard.csv` answers "any credit
  cards?" even when its rows are anonymized numbers). Plain-text files are read
  directly; **PDF, Word (`.docx`), and Excel (`.xlsx`/`.xls`)** documents have
  their text extracted by parsers loaded lazily on first use and cached on disk
  (keyed by the file's mtime+size, so each document is parsed once — a failed
  parse is logged and *not* cached, so a transient error is retried on the next
  scan rather than pinned to empty), and an unreadable or corrupt document
  degrades gracefully to empty text yet stays findable by name
  (`src/server/extract.ts`). Catalog-style queries
  ("show me all files", "list my datasets", "how many PDFs") skip ranking and
  instead **enumerate** the included set, narrowing to a file kind (datasets,
  documents, PDFs, spreadsheets) or a named file type (`csv`, `pdf`, `md`, …) when
  the query names one. Large files are read up to a
  1 MB prefix and total chunks are capped, so a huge dataset can't stall a query
  (`src/server/vault.ts`) — local, no embeddings download.
- **Chat** is a running conversation that streams a grounded answer (`/api/chat`):
  Anthropic Claude when an API key is configured (set in onboarding or later from
  the settings gear's **AI models** dialog, or via `ANTHROPIC_API_KEY`), an
  on-device **local model** when the "Local model
  (private)" provider is selected (see **[Local model](#local-model)**), otherwise
  a local extractive fallback that needs no network. Answers render as Markdown
  (headings, lists, tables, code, bold, and links that open externally). Each
  question and answer is kept in a transcript so you can ask follow-ups about the
  documents that came back
  (prior turns — capped to the last few — are threaded to the model, and a bare
  follow-up blends in the previous question to anchor retrieval); **New chat**
  starts fresh. **Attach files to a question** by dragging one from the explorer
  onto the chat panel, or dropping files from your OS onto it (those upload into
  the vault first); attachments show as removable pills and scope the question
  (and its follow-ups) to just those files — even ones you haven't included
  globally — until you clear them or start a **New chat**. The answer's
  **Related files** cards
  are clickable on the desktop build — `/api/open` opens the cited file in its
  native app (web deployments report no such capability and the cards stay inert).
- **Profile/key** are stored locally in `vault/.rag-vault/profile.json` (gitignored).

Swap back to the in-memory mocks by pointing the three exports in
`src/contracts/index.ts` at `./mocks/*`. A cloud/Vercel deployment would add an
adapter behind the same `RagService`/`ChatService`/`AuthService` interfaces
(serverless hosts can't persist to a local directory — local storage means
running on your own machine).

## Pricing & trial

Start a **free 14-day trial** — no payment, no key to copy, and repeatable. When
a trial ends you can start another, or skip it and **subscribe for $14.99 a
month** for unlimited use.

Your files are always yours. A lapsed trial or subscription only **locks** the
app — your vault is greyed out, never deleted — until you start a new trial or
subscribe. Subscribing is one click: checkout opens in your browser and the app
unlocks itself the moment payment goes through, with no license key to paste.
Each subscription is tied to an email, so a team can buy several under one card.

> **Paid subscriptions aren't open yet.** The shipped build defaults to
> `PAID_ENABLED=0`, so the Subscribe affordances stay hidden and the app shows
> **"Get notified when purchasing opens"** instead — only the free trial is
> live. Flip `PAID_ENABLED=1` (see [Configuration](#configuration)) to surface
> the $14.99/mo checkout described above.

Self-hosting setup (Supabase tables + Edge Functions + Stripe) is in
**[docs/registration.md](docs/registration.md)**.

## Configuration

Copy `.env.local.example` → `.env.local` (gitignored). All vars are optional:

- `VAULT_DIR` — where your documents live (default `./vault`; the desktop app
  manages this for you).
- `ANTHROPIC_API_KEY` — live Claude chat; without it, a local extractive
  fallback answers with no network.
- `LIGHTHOUSE_LOCAL_LLM_URL` — OpenAI chat-completions endpoint for the "Local
  model (private)" provider (default `http://127.0.0.1:8080/v1/chat/completions`;
  for Ollama use `http://127.0.0.1:11434/v1/chat/completions`). See
  **[Local model](#local-model)**.
- `LIGHTHOUSE_LOCAL_LLM_MODEL` — model name sent to that server; required for
  Ollama / LM Studio (e.g. `llama3.2`), ignored by `llama-server`.
- `LICENSE_API_URL` / `SUPABASE_ANON_KEY` — public hosted-license config (the
  Edge Function URL + anon key). Shipped in the committed `.env.production`;
  override in `.env.local` to point a dev build at the same function.
- `CHECKOUT_API_URL` — public `create-checkout` Edge Function URL for the
  $14.99/mo plan. Shipped in `.env.production`; the Stripe secret, price ID, and
  webhook secret live only in the Edge Functions, never here. See
  **[docs/registration.md](docs/registration.md)**.
- `PAID_ENABLED` — set to `1` (then restart) to surface the Subscribe
  affordances (left-nav button, registration screen, lock gate); default `0`
  shows "Get notified when purchasing opens" instead. Public; shipped in
  `.env.production`.
- `LICENSE_ENFORCE` / `LICENSE_SECRET` — local-dev trial only: set
  `LICENSE_ENFORCE=1` (with no `LICENSE_API_URL`) for a self-contained trial
  using local crypto, with `LICENSE_SECRET` encrypting the local key. The
  service-role key and the production `LICENSE_SECRET` live in the Edge Function,
  never here. See **[docs/registration.md](docs/registration.md)**.

## Local model

Pick **"Local model (private)"** as your provider — in onboarding, or later from
the settings gear's **AI models** dialog — to answer
entirely on-device — no API key, no network, nothing leaves your machine.
This is the privacy-first option for governance-conscious teams.

Lighthouse talks to a local **OpenAI chat-completions compatible** server. Two
ways to provide one:

- **Bundled (zero setup):** the installer ships a `llama-server` binary and a
  small `.gguf` model under `resources/llm/`, and the desktop app launches it
  automatically on `127.0.0.1:8080` at startup and shuts it down on quit — no
  API key, no separate download, nothing to configure. Build it with
  `npm run dist`, which runs `next build` (so the production `.next` is bundled)
  and `npm run fetch:model` to download the binary (llama.cpp, MIT) and weights
  (SmolLM2-1.7B-Instruct Q4_K_M, ~1 GB, Apache-2.0) into `resources/llm/`, then
  packages them into the installer. The model assets are gitignored, fetched on
  the build machine; `npm run dist:nomodel` skips them (but still runs
  `next build`) for a lean build that relies on a bring-your-own server instead.
- **Bring your own:** run [Ollama](https://ollama.com) or
  [LM Studio](https://lmstudio.ai) yourself and point Lighthouse at it with
  `LIGHTHOUSE_LOCAL_LLM_URL` (default `http://127.0.0.1:8080/v1/chat/completions`;
  for Ollama use `http://127.0.0.1:11434/v1/chat/completions`). Servers that
  require a named model (Ollama, LM Studio) need `LIGHTHOUSE_LOCAL_LLM_MODEL` set
  to the model you pulled (e.g. `llama3.2`); `llama-server` ignores it.

If the local server isn't reachable, Lighthouse falls back to streaming the most
relevant passages so you still get a grounded, cited answer.

## Status

Working local-first vertical slice: real file tree, real retrieval (including
text extraction from PDF, Word, and Excel documents), real streamed chat, plus a
persistent **desktop app** (Electron) with a double-click launcher, a packaged
installer, and branded app/tray/installer icons. Next: optional vector
embeddings behind `RagService.search`.
