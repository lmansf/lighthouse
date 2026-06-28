# Agent brief: explorer

## Scope (yours)
- `src/features/explorer/` only (`FileExplorer.tsx`).

This is the centerpiece: a File-Explorer-like tree where the user curates RAG inclusion.

## Contract you implement against
- Read/write `src/stores/useRagStore.ts`: `sources`, `nodes`, `selectionMode`, `setSelectionMode`, `selectedIds`, `toggleSelected`, `clearSelection`, `applySelection`, `toggleIncluded`, `toggleSourceAvailable`, `upload`, `addReference`, `removeReference`, `load` (re-scan the vault), `includedFileIds()`.
- The store wraps `RagService` (`src/contracts/services.ts`). `setIncluded` already cascades to descendants (folder/source toggles its whole subtree). Inclusion defaults to **excluded**, and a node's rendered `ragIncluded` is the *effective* value: on only if its own flag is set and no ancestor folder is excluded — so a file discovered later (or moved in) under an excluded folder still reads as out. The real backend builds the tree from the on-disk `./vault` directory (`src/server/vault.ts`); the mock's seed tree is in `src/contracts/mocks/files.ts`.

## What to build
1. **File tree** - expand/collapse rows (chevron) with per-type icons (database / folder / pdf / doc); design for arbitrary depth via `parentId` (top-level folders open by default).
2. **Hierarchical toggling** at file, folder, and data-source granularity. Folders/sources cascade to children.
3. **Selection mode** - a multi-select pass: when on, clicking a row (or its checkbox) *picks* it (`toggleSelected`) instead of toggling inclusion. An action bar then applies one action to every picked row — **Make visible** (include) / **Remove** (exclude) via `applySelection`, or **Clear** the picks (`clearSelection`). Picked rows are outlined; included rows still carry the brand fill. Unavailable sources render dimmed and cannot be included.
4. **Add files / folders** via the toolbar's **Browse…** menu (**Files…** / **Folder…**) or drag-and-drop - `upload` sends each file's `webkitRelativePath` so dropped/picked folders recreate their structure in the vault.
5. **Linked items** - files/folders added *in place* (desktop-only, via `addReference`) render with a "linked" badge and an **Unlink** action (`removeReference`) on the subtree root; the real files stay on disk.
6. **Refresh** - a toolbar button (`load`) that re-scans the vault on demand, so files added outside an in-app upload show up. The shell also polls `load` in the background; this is the manual nudge.

## Acceptance criteria
- Toggling a file updates `useRagStore` immediately, and the chat panel's "sources available" count reflects it (cross-feature seam).
- Toggling a source's availability off excludes its whole subtree.
- "N in RAG" count is accurate and live.
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`; corner radii/shadows from theme tokens.
- Don't import onboarding/chat/shell internals.
