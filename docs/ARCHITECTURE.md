# RAG Vault - Architecture

RAG Vault lets a user curate which of their files and data sources are exposed to a RAG (retrieval-augmented generation) system.
Browse files in an organic, dark-themed File-Explorer-like tree, then toggle items as **included** or **excluded** from retrieval.
Anything included is searchable by the AI; anything excluded is invisible to it.
A Google-style chat surface (answer on top, related files below, streamed in realtime) queries only the included material.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**, **npm**.
- **Fluent UI 2** (`@fluentui/react-components`, Griffel `makeStyles` + design tokens) - the only styling system. Dark theme (`webDarkTheme`, lightly customized) by default.
- **Zustand** for small, domain-scoped shared stores.
- Backend is a **local-first** implementation behind the real interfaces: a filesystem vault, local TF-IDF retrieval, and streamed Claude-or-extractive chat, served by Node routes under `app/api/` (logic in `src/server/`). No cloud database. The in-memory mocks stay swappable behind the same interfaces.

## The decoupling seam

Everything hangs off `src/contracts/`. Features depend on the contract **interfaces and types**, never on each other's internals.

```
src/contracts/
  types.ts        # FileNode, DataSource, ModelProvider, RagReference, ChatMessage, ChatChunk, User, OnboardingState
  services.ts     # RagService, AuthService, ChatService  (interfaces)
  mocks/          # in-memory implementations + seed data
  real/           # local-first implementations (call the app/api/* routes)
  index.ts        # public barrel - import from "@/contracts"
```

The barrel exports the **real** implementations by default; the server-side
logic they call lives in `src/server/` (`vault.ts`, `extract.ts` — text
extraction for PDF/Word/Excel documents, `llm.ts`, `profile.ts`, `config.ts`,
plus the `sources/` registry) and is exposed through the Node routes
in `app/api/{rag,chat,open,profile}`.
See [README.md](../README.md#backend-local-first-standalone) for what runs where.

### The source-connector seam

`src/server/sources/` keeps the explorer and the API source-agnostic. A
`SourceConnector` (`types.ts`) is one top-level origin of documents; the local
filesystem vault (`local.ts`, a thin adapter over `vault.ts`) is the first one
and the **fallback owner** for any bare node id. The `registry.ts` aggregates
listings across all connectors and routes each curation op (`setIncluded`,
`moveNode`, `addReference`, `remove`, …) and retrieval to the owning source.
Optional capabilities (e.g. `remove`) are advertised per connector, and the
registry rejects an op a source doesn't support. Cloud
connectors (SharePoint, S3, …) register here later, owning ids namespaced
`${sourceId}::<path>`; the registry consults them by id prefix first, then falls
back to local. `/api/rag` and chat retrieval go through the registry, not
`vault.ts` directly. This is groundwork — today only the local vault is wired in.

Two Zustand stores carry shared state between features:

- `src/stores/useRagStore.ts` - the file tree + inclusion state. The **explorer** writes it; **chat** reads `includedFileIds()`. This is the live wire that proves the seam.
- `src/stores/useAuthStore.ts` - onboarding progress + user. The **onboarding** feature drives it; the **shell** reads `onboarding.step`. It also calls `subscribeAuth` (from `@/contracts`) so a returning user's persisted profile, hydrated in the background, propagates into the store (the mock exports a no-op `subscribeAuth`).

## Features (one git worktree each)

| Feature | Folder | Owns | Depends on |
|---|---|---|---|
| shell | `src/shell/` | `FluentProvider`/dark theme (`theme.ts`), app frame, collapsible left rail | contracts |
| onboarding | `src/features/onboarding/` | sign-in slides → model-select (provider/model/key + key links) | contracts, `AuthService`, `useAuthStore` |
| explorer | `src/features/explorer/` | file tree, hierarchical RAG toggle / selection mode, add files/folders, link files in place, remove from vault (recoverable trash) | contracts, `RagService`, `useRagStore` |
| chat | `src/features/chat/` | answer-on-top + reference files below (clickable to open the cited file natively on desktop), realtime streaming | contracts, `ChatService`, `useRagStore` |

`app/page.tsx` composes the three feature components into the shell. Each team replaces **only its own** placeholder.

## Rules of the road (for parallel agents)

1. **Never import another feature's components or files.** Cross-feature communication goes through `@/contracts` and the Zustand stores.
2. **Don't change `src/contracts/types.ts` or `services.ts` unilaterally.** They are the shared interface; a breaking change blocks every other team. Propose contract changes first.
3. **Style with Fluent `tokens` and `makeStyles`.** No hardcoded colors; no second styling system. Theme overrides belong in `src/shell/theme.ts` (shell team).
4. **Keep implementations behind the interfaces.** The barrel now points at the real local-first backend; swapping back to the mocks (or forward to a cloud adapter) is the single `export` line in `index.ts` - no feature code changes.
5. Run `npm run build` before opening a PR; types must compile against the contracts.

## Swapping implementations behind the contracts

Each implementation - mock or real - is a singleton exported from `index.ts`, and
no feature imports one directly. Today the barrel exports `./real/*`: a local-first
backend (`src/server/` + `app/api/`) that reads a real `./vault` directory
(override with `VAULT_DIR`), persists inclusion to `vault/.rag-vault/state.json`,
runs TF-IDF retrieval over the included files, and streams Anthropic Claude answers
when an API key is set (in onboarding or `ANTHROPIC_API_KEY`) or a local extractive
fallback otherwise. Point the three exports at `./mocks/*` for the fully in-memory
mocks. A future cloud/Vercel deployment is another adapter behind the same
`RagService` / `AuthService` / `ChatService` interfaces - serverless hosts can't
persist to a local directory, so local storage means running on your own machine.

## Run

```bash
npm install
cp .env.local.example .env.local   # optional: set VAULT_DIR / ANTHROPIC_API_KEY
npm run dev      # http://localhost:3000
npm run build
```
