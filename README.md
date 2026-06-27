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

## Status

Scaffold. Backend is mocked behind real interfaces (`RagService`, `AuthService`, `ChatService`); auth and onboarding are local-state mocks.
