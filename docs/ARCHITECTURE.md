# Lighthouse - Architecture

> **Founding-era document (pre-rewrite).** The contract seam
> (`src/contracts/`) and store design below still govern the UI, but the
> product has moved on from what this file describes: the engine is Rust
> (`native/` — see `native/README.md` and `docs/ts-twin.md`), the shell is
> Tauri (not Electron), and the theme is the Beam identity — warm paper/ink
> neutrals with a single amber accent (the sandy-beach theme described below
> shipped Jun 28 and has been re-skinned twice since).
>
> **And the premise changed in 0.15.0** (openspec:
> `refocus-chat-attachments`). The vault this document is named for — a
> curated folder tree with per-file include/exclude flags, browsed in a
> sidebar explorer — is gone. A conversation holds up to **ten attachments**,
> attaching one IS the decision, and there is no tree, no inclusion gate and
> no curation layer. Read the sections below as history; where they describe
> the vault, the replacement is `workspace.rs` ⇄ `workspace.ts`.
>
> Kept for the seams and the history.

Lighthouse answers questions about a small group of files. Attach up to ten
files to a chat and ask about them: the engine extracts, chunks, indexes and
ranks them locally, and the answer cites the files it actually read. The files
stay where they are on disk — the app copies their bytes into its own
content-addressed store and never moves, renames, or watches anything.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**, **npm**.
- **Fluent UI 2** (`@fluentui/react-components`, Griffel `makeStyles` + design tokens) - the only styling system. Two Beam themes in `theme.ts` (Paper light / Ink dark: warm neutral surfaces, hairline strokes, one amber accent), AA-gated by `scripts/check-contrast.mjs`.
- **Zustand** for small, domain-scoped shared stores.
- Backend is a **local-first** implementation behind the real interfaces: a filesystem vault, local TF-IDF retrieval, and streamed chat (Claude, an on-device local model, or an extractive fallback), served by Node routes under `app/api/` (logic in `src/server/`). No cloud database. The in-memory mocks stay swappable behind the same interfaces.

## The decoupling seam

Everything hangs off `src/contracts/`. Features depend on the contract **interfaces and types**, never on each other's internals.

```
src/contracts/
  types.ts        # Attachment, ModelProvider, RagReference, ChatTurn, ChatMessage, ChatChunk, User, OnboardingState
  services.ts     # RagService, AuthService, ChatService  (interfaces)
  mocks/          # in-memory implementations + seed data
  real/           # local-first implementations (call the app/api/* routes)
  index.ts        # public barrel - import from "@/contracts"
```

The barrel exports the **real** implementations by default; the server-side
logic they call lives in `src/server/` (`workspace.ts` — the attachment blob
store and manifests, `retrieval.ts` — the ranker, `extract.ts` — text
extraction for PDF/Word/Excel documents, `llm.ts`, `profile.ts`, `config.ts`)
and is exposed through the Node routes in
`app/api/{rag,chat,upload,open,profile,settings}` (`settings` reads/writes the
desktop-only launch-at-login preference).
See [README.md](../README.md#backend-local-first-standalone) for what runs where.

### The source-connector seam (retired)

`src/server/sources/` kept the explorer and the API source-agnostic: a
`SourceConnector` per top-level origin, a registry routing each curation op and
retrieval to the owning source, and cloud connectors (SharePoint, S3, …)
registering later behind namespaced ids. It went with the vault in 0.15.0 —
there are no sources to aggregate when the corpus is the files a user attached
to one chat, and no curation ops to route.

Two Zustand stores carry shared state between features:

- `src/stores/useRagStore.ts` - engine state that isn't per-conversation: what this build can do, the managed-policy locks, the session egress figure, and upload progress. (Until 0.15.0 this store WAS the vault — the file tree, the inclusion flags, and the `includedFileIds()` chat retrieved against. A conversation's attachments are chat state now, held next to the chat that owns them.)
- `src/stores/useAuthStore.ts` - onboarding progress + user. The **onboarding** feature drives it; the **shell** reads `onboarding.step`. It also calls `subscribeAuth` (from `@/contracts`) so a returning user's persisted profile, hydrated in the background, propagates into the store (the mock exports a no-op `subscribeAuth`).

## Features (one git worktree each)

| Feature | Folder | Owns | Depends on |
|---|---|---|---|
| shell | `src/shell/` | `FluentProvider`/the Beam Paper & Ink themes (`theme.ts`), app frame | contracts |
| onboarding | `src/features/onboarding/` | one first-run screen: welcome + model-select (provider/model/key + key links; the local provider needs no key) | contracts, `AuthService`, `useAuthStore` |
| chat | `src/features/chat/` | running conversation (transcript of turns + follow-ups, "New chat" to reset) of answer-on-top (Markdown-rendered via `react-markdown`/`remark-gfm`) + reference files below (clickable to open the cited file natively on desktop), realtime streaming, and the attach flow (drop, picker, or tray) that gives a chat its corpus | contracts, `ChatService`, `useRagStore`, `src/shell/dnd` |

The `explorer` feature — the file tree, the hierarchical RAG toggle, add/link/remove-to-trash — went with the vault in 0.15.0.

## Rules of the road (for parallel agents)

1. **Never import another feature's components or files.** Cross-feature communication goes through `@/contracts` and the Zustand stores.
2. **Don't change `src/contracts/types.ts` or `services.ts` unilaterally.** They are the shared interface; a breaking change blocks every other team. Propose contract changes first.
3. **Style with Fluent `tokens` and `makeStyles`.** No hardcoded colors; no second styling system. Theme overrides belong in `src/shell/theme.ts` (shell team).
4. **Keep implementations behind the interfaces.** The barrel now points at the real local-first backend; swapping back to the mocks (or forward to a cloud adapter) is the single `export` line in `index.ts` - no feature code changes.
5. Run `npm run build` before opening a PR; types must compile against the contracts.

## Swapping implementations behind the contracts

Each implementation - mock or real - is a singleton exported from `index.ts`, and
no feature imports one directly. Today the barrel exports `./real/*`: a local-first
backend (`src/server/` + `app/api/`) that keeps each conversation's attachments
in a content-addressed store under the app-state dir (override the root with
`LIGHTHOUSE_APP_STATE_DIR`), runs TF-IDF retrieval over them, and streams Anthropic Claude answers
when an API key is set (in onboarding or the settings gear's AI models dialog, or
`ANTHROPIC_API_KEY`), an on-device local
model when the "local" provider is selected (via an OpenAI-compatible server, see
[README.md](../README.md#local-model)), or a local extractive fallback otherwise. Point the three exports at `./mocks/*` for the fully in-memory
mocks. A future cloud/Vercel deployment is another adapter behind the same
`RagService` / `AuthService` / `ChatService` interfaces - serverless hosts can't
persist to a local directory, so local storage means running on your own machine.

## Run

```bash
npm install
cp .env.local.example .env.local   # optional: set LIGHTHOUSE_APP_STATE_DIR / ANTHROPIC_API_KEY
npm run dev      # http://localhost:3000
npm run build
```
