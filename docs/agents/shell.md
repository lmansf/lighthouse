# Agent brief: shell

## Scope (yours)
- `src/shell/` only: `AppShell.tsx`, `Sidebar.tsx`, `theme.ts`.
- `app/layout.tsx`, `app/providers.tsx`, `app/globals.css` (the Fluent SSR + light theme wiring).

You own the application frame, the collapsible left file sidebar, and the **design tokens** every other feature consumes.

## Contract you implement against
- Consume `useRagStore` only to drive the vault load (`load`) and to read counts if needed. Do not implement feature logic. The shell keeps the tree live: it re-runs `load()` on an interval and whenever the window regains focus/visibility, so files added outside an in-app upload appear without a manual reload. Each refresh swallows backend/IPC errors (logs them) so a transient failure can't crash the poll loop.
- Read `useAuthStore().onboarding.step` if you gate the workspace behind onboarding.
- `theme.ts` exports `lighthouseTheme` (Fluent `Theme`, a sandy-beach light palette), `ACCENTS` (lighthouse accent colors — sky blue, beacon amber, accessible red text, white card surface — for sparing feature use), and `LAYOUT`. This is the single source of truth for colors/radii/spacing constants. All foreground/background pairings are WCAG AA contrast-checked by `scripts/check-contrast.mjs` (`node scripts/check-contrast.mjs`); keep its palette in sync with `theme.ts`.

## Acceptance criteria
- Sandy-beach light Fluent theme applied with **no flash of unstyled content** (SSR Griffel via `app/providers.tsx`).
- The left file sidebar collapses/expands smoothly; collapsed it shrinks to a thin icon rail that hides the explorer body but keeps the expand toggle and the settings gear pinned bottom-left.
- The sidebar hosts the file explorer; the chat/Ask panel sits front-and-center in the main area. Onboarding renders full-screen (centered) until `onboarding.step === "done"`, before the sidebar + chat workspace appears. Responsive, never overflows the viewport.
- The organic look: larger corner radii than stock Fluent, soft shadows. Tune via `theme.ts`, not per-component hardcoding.
- `npm run build` passes.

## Rules
- Don't import feature components beyond what `app/page.tsx` composes.
- Don't put feature-specific styling here; expose tokens instead.
