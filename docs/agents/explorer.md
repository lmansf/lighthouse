# Agent brief: explorer

## Scope (yours)
- `src/features/explorer/` only (`FileExplorer.tsx`).

This is the centerpiece: a File-Explorer-like tree where the user curates RAG inclusion.

## Contract you implement against
- Read/write `src/stores/useRagStore.ts`: `sources`, `nodes`, `selectionMode`, `setSelectionMode`, `selectedIds`, `toggleSelected`, `clearSelection`, `applySelection`, `toggleIncluded`, `toggleSourceAvailable`, `upload`, `addReference`, `linkPaths` (link several real paths in place at once, tracking `processing`), `removeReference`, `removeFromVault`, `load` (re-scan the vault), `processing` (progress of an in-flight add, for the overlay), `includedFileIds()`.
- The store wraps `RagService` (`src/contracts/services.ts`). `setIncluded` already cascades to descendants (folder/source toggles its whole subtree). Inclusion defaults to **excluded**, and a node's rendered `ragIncluded` is the *effective* value: on only if its own flag is set and no ancestor folder is excluded — so a file discovered later (or moved in) under an excluded folder still reads as out. The real backend builds the tree from the on-disk `./vault` directory (`src/server/vault.ts`); the mock's seed tree is in `src/contracts/mocks/files.ts`.

## What to build
1. **File tree** - expand/collapse rows (chevron) with per-type icons (database / folder / pdf / doc); design for arbitrary depth via `parentId` (top-level folders open by default).
2. **Hierarchical toggling** at file, folder, and data-source granularity. Folders/sources cascade to children.
3. **Selection mode** - a multi-select pass: when on, clicking a row (or its checkbox) *picks* it (`toggleSelected`) instead of toggling inclusion. An action bar then exposes a single **Visible to AI** switch that both reflects and sets the whole selection's inclusion (`applySelection`; the selection is kept so the switch stays in sync with the result), a **Remove from vault** bulk action (see below), and **Clear** the picks (`clearSelection`). Picked rows are outlined; included rows still carry the brand fill. Unavailable sources render dimmed and cannot be included.
4. **Add files / folders** via the toolbar's **Browse…** menu or drag-and-drop. On the desktop, adds are **link-first**: a drop resolves each item to its real path (`@/shell/desktopBridge` `pathsForFiles`) and links it in place via `linkPaths` (no copy, whole folders work); **Browse… ▸ Files/Folder… (linked in place)** does the same through a native picker (`desktopBridge().linkDialog`). Copying in is the explicit secondary option (**Browse… ▸ Copy files in… / Copy folder in…**), which calls `upload` with `{ preferLink: false }`. In a plain browser (or for a file with no resolvable path), `upload` sends each file's `webkitRelativePath` so dropped/picked folders recreate their structure in the vault. A big add shows the `processing` overlay instead of appearing frozen.
5. **Linked items** - files/folders added *in place* (desktop-only, via `addReference`) render with a "linked" badge and an **Unlink** action (`removeReference`) on the subtree root; the real files stay on disk.
6. **Remove from vault** (non-destructive) - a right-click **Remove from vault** context-menu item on any row, plus the selection-mode bulk button, both behind a confirm dialog (`removeFromVault`). A vault-resident file/folder moves to a recoverable trash (`.rag-vault/trash/<date>/`) and its inclusion flags drop; a linked item only unlinks, leaving the user's real files untouched.
7. **Refresh** - a toolbar button (`load`) that re-scans the vault on demand, so files added outside an in-app upload show up. The shell also polls `load` in the background; this is the manual nudge.
8. **Drag a file out to chat** - file rows are `draggable`; dragging one onto the chat panel attaches it so the next question is scoped to just that file. Serialize the payload with the shared `@/shell/dnd` helpers (`FILE_DRAG_MIME`, `serializeDraggedFiles`) so the chat panel can tell internal drags from OS file drops. Only local-vault files are draggable — cloud-connector files (namespaced ids) live remotely, outside the vault that attachment retrieval walks.

## Acceptance criteria
- Toggling a file updates `useRagStore` immediately, and the chat panel's "sources available" count reflects it (cross-feature seam).
- Toggling a source's availability off excludes its whole subtree.
- "N in RAG" count is accurate and live.
- `npm run build` passes.

## Rules
- Style with Fluent `tokens` / `makeStyles`; corner radii/shadows from theme tokens.
- Don't import onboarding/chat/shell internals.
