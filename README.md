# Lighthouse

Curate which of your files and data sources your AI can see.
Browse files in a calm, sandy-beach File-Explorer-style UI (red used sparingly as the beacon accent), toggle items **in** or **out** of the RAG index, and ask a Google-style chat that answers only from what you've included. Local-first: your documents stay in a folder on your own machine.

> The npm package is still named `rag-vault`; the product and repo are **Lighthouse**.

## Run it

### Desktop app (recommended)

Lighthouse runs as a persistent desktop app (system tray, launch-at-login,
native file/vault dialogs). You don't need a terminal:

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
  location on disk instead of copying a second time.
- **Retrieval** is real TF-IDF cosine over the text of the *included* files
  (`src/server/vault.ts`) — local, no embeddings download.
- **Chat** streams a grounded answer (`/api/chat`): Anthropic Claude when an API
  key is configured (set in onboarding or `ANTHROPIC_API_KEY`), otherwise a local
  extractive fallback that needs no network.
- **Profile/key** are stored locally in `vault/.rag-vault/profile.json` (gitignored).

Swap back to the in-memory mocks by pointing the three exports in
`src/contracts/index.ts` at `./mocks/*`. A cloud/Vercel deployment would add an
adapter behind the same `RagService`/`ChatService`/`AuthService` interfaces
(serverless hosts can't persist to a local directory — local storage means
running on your own machine).

## Welcome form & trial licensing (optional)

After sign-in, a one-time welcome form in the left rail collects basic contact
info — or **Skip** it entirely. Either way it mints a **14-day trial** (unique
GUID + encrypted license key). The trial secrets — the Supabase service-role key
and the `LICENSE_SECRET` that encrypts keys — live **only** in a hosted Supabase
**Edge Function**, never in the shipped app; the desktop holds only public config
(the function URL + anon key, committed in `.env.production`) and calls the
function to mint and verify trials. The license is checked once per launch; only
a verified time-expiry resets the vault and prompts a fresh trial (a forged key
or an offline check never wipes anything). Re-registration is unlimited, and
trials can be extended by editing `trial_end` in Supabase.

Trial enforcement is active when the hosted function is configured
(`LICENSE_API_URL`, the shipping default) or `LICENSE_ENFORCE=1` (a self-contained
local-dev trial); otherwise the app runs unlicensed and fully usable. Setup
(table SQL + Edge Function deploy) is in
**[docs/registration.md](docs/registration.md)**.

## Configuration

Copy `.env.local.example` → `.env.local` (gitignored). All vars are optional:

- `VAULT_DIR` — where your documents live (default `./vault`; the desktop app
  manages this for you).
- `ANTHROPIC_API_KEY` — live Claude chat; without it, a local extractive
  fallback answers with no network.
- `LICENSE_API_URL` / `SUPABASE_ANON_KEY` — public hosted-license config (the
  Edge Function URL + anon key). Shipped in the committed `.env.production`;
  override in `.env.local` to point a dev build at the same function.
- `LICENSE_ENFORCE` / `LICENSE_SECRET` — local-dev trial only: set
  `LICENSE_ENFORCE=1` (with no `LICENSE_API_URL`) for a self-contained trial
  using local crypto, with `LICENSE_SECRET` encrypting the local key. The
  service-role key and the production `LICENSE_SECRET` live in the Edge Function,
  never here. See **[docs/registration.md](docs/registration.md)**.

## Status

Working local-first vertical slice: real file tree, real retrieval, real streamed
chat, plus a persistent **desktop app** (Electron) with a double-click launcher
a packaged installer, and branded app/tray/installer icons. Next: optional vector
embeddings behind `RagService.search`, and binary formats (PDF/DOCX) extraction.
