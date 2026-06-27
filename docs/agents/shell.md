# Agent brief: shell

## Scope (yours)
- `src/shell/` only: `AppShell.tsx`, `LeftRail.tsx`, `theme.ts`.
- `app/layout.tsx`, `app/providers.tsx`, `app/globals.css` (the Fluent SSR + dark theme wiring).

You own the application frame, the collapsible left rail, and the **design tokens** every other feature consumes.

## Contract you implement against
- Consume `useRagStore` only to trigger the one-time data load and to read counts if needed. Do not implement feature logic.
- Read `useAuthStore().onboarding.step` if you gate the workspace behind onboarding.
- `theme.ts` exports `ragVaultDarkTheme` (Fluent `Theme`) and `LAYOUT`. This is the single source of truth for colors/radii/spacing constants.

## Acceptance criteria
- Dark Fluent theme applied with **no flash of unstyled content** (SSR Griffel via `app/providers.tsx`).
- Left rail collapses/expands smoothly; collapsed width hides the rail body, keeps the toggle.
- Left rail hosts onboarding until `onboarding.step === "done"`, then the chat/Ask panel; the file explorer fills the rest of the screen. Responsive, never overflows the viewport.
- The organic look: larger corner radii than stock Fluent, soft shadows. Tune via `theme.ts`, not per-component hardcoding.
- `npm run build` passes.

## Rules
- Don't import feature components beyond what `app/page.tsx` composes.
- Don't put feature-specific styling here; expose tokens instead.
