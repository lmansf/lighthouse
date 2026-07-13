import type { FileNode } from "@/contracts";

/** One visible row of the flattened tree: a node plus its indentation depth. */
export interface FlatRow {
  node: FileNode;
  depth: number;
}

/**
 * Depth-first flatten of one source's visible tree into a linear row list,
 * descending into a folder's children only when it's expanded. This is the
 * behavioral heart of the virtualized explorer: it must reproduce EXACTLY what
 * the old recursive TreeRow rendered — same `visibleIds` filter, same sibling
 * comparator, same expand gate — so the flat list a viewport windows is
 * indistinguishable from the tree it replaced. Kept dependency-free (a
 * type-only FileNode import) so it unit-tests without React/Fluent.
 *
 * @param roots       This source's root nodes, already filtered + sorted.
 * @param childrenOf  Direct children of a folder id (unsorted, unfiltered).
 * @param compareNodes Sibling comparator (folders first, then the sort key).
 * @param isExpanded  Whether a folder id is currently expanded.
 * @param visibleIds  Ids an active search keeps, or null when no filter is on.
 */
export function flattenVisible(
  roots: FileNode[],
  childrenOf: (id: string) => FileNode[],
  compareNodes: (a: FileNode, b: FileNode) => number,
  isExpanded: (id: string) => boolean,
  visibleIds: Set<string> | null,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (node: FileNode, depth: number) => {
    out.push({ node, depth });
    if (node.kind === "folder" && isExpanded(node.id)) {
      const kids = (visibleIds ? childrenOf(node.id).filter((k) => visibleIds.has(k.id)) : childrenOf(node.id))
        .slice()
        .sort(compareNodes);
      for (const k of kids) walk(k, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}
