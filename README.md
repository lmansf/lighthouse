# RAG Vault

Curate which of your files and data sources your AI can see.
Browse files in an organic, dark, oversized File-Explorer-style UI, toggle items **in** or **out** of the RAG index, and ask a Google-style chat that answers only from what you've included.

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
```

## Architecture

This repo is structured so independent agent teams can each own one feature in its own git worktree and converge cleanly.
Everything decouples through `src/contracts/` (typed interfaces + mock implementations) and two Zustand stores.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** - the design, the contract seam, and the rules of the road.
- **docs/agents/** - one brief per feature team: [shell](docs/agents/shell.md), [onboarding](docs/agents/onboarding.md), [explorer](docs/agents/explorer.md), [chat](docs/agents/chat.md).

The feature components in `app/page.tsx` are working placeholders today - each team replaces its own.

## Backend (local-first, standalone)

The mocks are now backed by a real **local-first** implementation behind the same
contracts — no cloud database required:

- **Files** live in a real directory (`./vault`, or set `VAULT_DIR` to any path).
  The explorer lists them; inclusion flags persist to `vault/.rag-vault/state.json`.
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

## Status

Working local-first vertical slice: real file tree, real retrieval, real streamed
chat. Next: optional vector embeddings behind `RagService.search`, binary
formats (PDF/DOCX) extraction, and richer explorer/onboarding polish.
