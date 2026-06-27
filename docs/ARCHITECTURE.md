# RAG Vault - Architecture

RAG Vault lets a user curate which of their files and data sources are exposed to a RAG (retrieval-augmented generation) system.
Browse files in an organic, oversized, dark-themed File-Explorer-like UI, then toggle items as **included** or **excluded** from retrieval.
Anything included is searchable by the AI; anything excluded is invisible to it.
A Google-style chat surface (answer on top, related files below, streamed in realtime) queries only the included material.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**, **npm**.
- **Fluent UI 2** (`@fluentui/react-components`, Griffel `makeStyles` + design tokens) - the only styling system. Dark theme (`webDarkTheme`, lightly customized) by default.
- **Zustand** for small, domain-scoped shared stores.
- Backend is **mocked behind real interfaces** (no real vector store / identity provider / model API yet).

## The decoupling seam

Everything hangs off `src/contracts/`. Features depend on the contract **interfaces and types**, never on each other's internals.

```
src/contracts/
  types.ts        # FileNode, DataSource, ModelProvider, RagReference, ChatMessage, ChatChunk, User, OnboardingState
  services.ts     # RagService, AuthService, ChatService  (interfaces)
  mocks/          # in-memory implementations + seed data
  index.ts        # public barrel - import from "@/contracts"
```

Two Zustand stores carry shared state between features:

- `src/stores/useRagStore.ts` - the file tree + inclusion state. The **explorer** writes it; **chat** reads `includedFileIds()`. This is the live wire that proves the seam.
- `src/stores/useAuthStore.ts` - onboarding progress + user. The **onboarding** feature drives it; the **shell** reads `onboarding.step`.

## Features (one git worktree each)

| Feature | Folder | Owns | Depends on |
|---|---|---|---|
| shell | `src/shell/` | `FluentProvider`/dark theme (`theme.ts`), app frame, collapsible left rail | contracts |
| onboarding | `src/features/onboarding/` | sign-in slides → model-select (provider/model/key + key links) | contracts, `AuthService`, `useAuthStore` |
| explorer | `src/features/explorer/` | oversized organic file tiles, hierarchical RAG toggle / selection mode | contracts, `RagService`, `useRagStore` |
| chat | `src/features/chat/` | answer-on-top + reference files below, realtime streaming | contracts, `ChatService`, `useRagStore` |

`app/page.tsx` composes the three feature components into the shell. Each team replaces **only its own** placeholder.

## Rules of the road (for parallel agents)

1. **Never import another feature's components or files.** Cross-feature communication goes through `@/contracts` and the Zustand stores.
2. **Don't change `src/contracts/types.ts` or `services.ts` unilaterally.** They are the shared interface; a breaking change blocks every other team. Propose contract changes first.
3. **Style with Fluent `tokens` and `makeStyles`.** No hardcoded colors; no second styling system. Theme overrides belong in `src/shell/theme.ts` (shell team).
4. **Keep mocks behind the interfaces.** When a real backend lands, it implements `RagService` / `AuthService` / `ChatService` and the barrel swaps the export - no feature code changes.
5. Run `npm run build` before opening a PR; types must compile against the contracts.

## Replacing the mocks with a real backend

Each mock in `src/contracts/mocks/` is a class implementing its interface and exported as a singleton from `index.ts`. To go live, implement the same interface against a real vector store / identity provider / model API and change the single `export` line in `src/contracts/index.ts`. No feature imports a mock directly.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
```
