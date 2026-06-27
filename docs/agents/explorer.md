# Agent brief: explorer

## Scope (yours)
- `src/features/explorer/` only. Replace the `FileExplorer.tsx` placeholder.

This is the centerpiece: an organic, oversized, File-Explorer-like grid where the user curates RAG inclusion.

## Contract you implement against
- Read/write `src/stores/useRagStore.ts`: `sources`, `nodes`, `selectionMode`, `setSelectionMode`, `toggleIncluded`, `toggleSourceAvailable`, `includedFileIds()`.
- The store wraps `RagService` (`src/contracts/services.ts`). `setIncluded` already cascades to descendants (folder/source toggles its whole subtree). Seed data is in `src/contracts/mocks/files.ts`.

## What to build
1. **Oversized organic tiles** - deliberately larger than real File Explorer, rounded (use `theme.ts` radii), with hover lift and per-type icons (database / folder / pdf / doc).
2. **Hierarchical toggling** at file, folder, and data-source granularity. Folders/sources cascade to children.
3. **Selection mode** - a fast highlight/unhighlight pass: when on, clicking rapidly flips inclusion; included tiles are visually "highlighted" (brand border/fill), excluded ones plain. Unavailable sources render dimmed and cannot be included.
4. Drill-in navigation into folders/databases (breadcrumb back out) - the seed tree is two levels deep but design for arbitrary depth via `parentId`.

## Acceptance criteria
- Toggling a file updates `useRagStore` immediately, and the chat panel's "sources available" count reflects it (cross-feature seam).
- Toggling a source's availability off excludes its whole subtree.
- "N in RAG" count is accurate and live.
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`; corner radii/shadows from theme tokens.
- Don't import onboarding/chat/shell internals.
