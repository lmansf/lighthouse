# Agent brief: shell

## Scope (yours)
- `src/shell/` only: `AppShell.tsx`, `Sidebar.tsx`, `ConversePlaceholder.tsx`, `theme.ts`, `dnd.ts`.
- `app/layout.tsx`, `app/providers.tsx`, `app/globals.css` (the Fluent SSR + light theme wiring).

You own the application frame, the collapsible left file sidebar, the **design tokens** every other feature consumes, and neutral shared infra like `dnd.ts` (the drag-and-drop payload for moving vault files between features, e.g. explorer → chat) that lets two features share a contract without importing each other.

## Contract you implement against
- Consume `useRagStore` only to drive the vault load (`load`) and to read counts if needed. Do not implement feature logic. The shell keeps the tree live: it re-runs `load()` on an interval and whenever the window regains focus/visibility, so files added outside an in-app upload appear without a manual reload. Each refresh swallows backend/IPC errors (logs them) so a transient failure can't crash the poll loop.
- Read `useAuthStore().onboarding.step` if you gate the workspace behind onboarding.
- `theme.ts` exports the Beam identity: `lighthouseTheme` (Fluent `Theme`, the "Paper" light palette — warm paper neutrals, ink text, one warm-amber accent) and `darkLighthouseTheme` (the "Ink" night variant), plus `BEAM_SWEEP` (the ink→amber signature gradient, hero moments only — never behind content), `ACCENTS` (just `beam`, the beacon's decorative amber glow — never text), and `LAYOUT`. This is the single source of truth for colors/radii/spacing constants. All foreground/background pairings in BOTH themes are WCAG AA contrast-checked by `scripts/check-contrast.mjs` (`node scripts/check-contrast.mjs`, exit 1 on failure); keep its palettes in sync with `theme.ts`.

## Acceptance criteria
- Beam Fluent themes (Paper light / Ink dark) applied with **no flash of unstyled content** (SSR Griffel via `app/providers.tsx`; `app/globals.css` paints the matching pre-hydration frame).
- The left file sidebar collapses/expands smoothly; collapsed it shrinks to a thin icon rail that hides the explorer body but keeps the expand toggle and the settings gear pinned bottom-left.
- The sidebar hosts the file explorer; the chat/Ask panel sits front-and-center in the main area. Onboarding renders full-screen (centered) until `onboarding.step === "done"`, before the sidebar + chat workspace appears. Responsive, never overflows the viewport.
- The shell owns the **Converse** coming-soon placeholder (`ConversePlaceholder.tsx`): a demand-gauging entry point for the future conversational mode (GitHub issue #66) that only opens a "coming soon" dialog (no badge). The chat feature renders it in the chat header, immediately left of **New chat**. It records nothing — clicking only opens the local "coming soon" dialog (ambient click telemetry was removed product-wide).
- The Beam look: restrained radii (12/10/8 for surfaces/cards/controls), exactly two elevation levels (hairline + soft shadow), motion 150–200ms ease-out and guarded for `prefers-reduced-motion`. Tune via `theme.ts`, not per-component hardcoding.
- `npm run build` passes.

## Rules
- Don't import feature components beyond what `app/page.tsx` composes.
- Don't put feature-specific styling here; expose tokens instead.
