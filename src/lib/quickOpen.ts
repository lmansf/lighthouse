/**
 * Quick-open (time-savers): the pure ranker behind the Ctrl/Cmd+P fuzzy
 * finder over the already-walked vault tree.
 *
 * Given the tree the RAG store already holds (no re-walk, no network), rank
 * the findable items — files, never folders — against a typed query by
 * case-insensitive SUBSEQUENCE match over the item's name and its
 * "/"-joined relative path (built by walking `parentId` up, so it works for
 * vault, linked, and connector nodes alike, whatever their id scheme).
 *
 * Ranking, in dominance order (askTypeahead's tier structure):
 *   1. Match tier — name-PREFIX beats any name-subsequence, which beats a
 *      match that only lands in the path.
 *   2. Match quality — how tightly the query's characters cluster in the
 *      matched text (a substring scores 1; scattered letters less).
 *   3. Ties — shorter full path first (the shallow "report.md" over the
 *      deep one), then path alphabetically, then id, so identical inputs
 *      always produce identical output.
 *
 * Empty (or blank) query → [] — it's a finder, not a browser: the palette
 * shows nothing until there's something to match. DOM-free and
 * dependency-free by construction (test/quickOpen.test.mjs runs it straight
 * under node); the input shape is structural so `FileNode` assigns directly.
 */

/** The slice of a FileNode the ranker needs (structurally FileNode-compatible). */
export interface QuickOpenNode {
  id: string;
  parentId: string | null;
  name: string;
  /** "file" | "folder" | "database" — folders are containers, never results. */
  kind: string;
  mimeType?: string;
  ragIncluded: boolean;
  localOnly?: boolean;
}

/** One palette row: identity, display fields, glance state, and rank score. */
export interface QuickOpenCandidate {
  id: string;
  name: string;
  /** Ancestor names joined by "/" ("" for a root-level item) — the dimmed
   *  relative path the row shows beside the name. */
  dir: string;
  kind: string;
  mimeType?: string;
  /** Effective AI-visibility (the explorer's eye), straight off the node. */
  ragIncluded: boolean;
  /** Effective "Private — this device only" (the explorer's lock). */
  localOnly: boolean;
  score: number;
  /**
   * Indices into `name` of the matched query characters, for subtle
   * emphasis — empty when the match landed only in the path (or when a
   * case-fold length change would misalign them).
   */
  nameHits: number[];
}

export interface QuickOpenOptions {
  /** Max rows to return (default QUICK_OPEN_LIMIT). */
  limit?: number;
}

/** Default row cap — the palette stays a glance, not a list to read. */
export const QUICK_OPEN_LIMIT = 12;

// Weights. Tiers dominate by construction: the largest possible quality
// contribution (W_QUALITY = 100) can never cross a tier boundary (1000), so
// "name-prefix > name-subsequence > path-subsequence" holds regardless of
// how tight a lower-tier match is.
const TIER_NAME_PREFIX = 2000;
const TIER_NAME_SUBSEQUENCE = 1000;
const TIER_PATH_SUBSEQUENCE = 0;
const W_QUALITY = 100;

/**
 * Greedy in-order scan: the positions of `q`'s characters in `candidate`,
 * or null when `q` isn't a subsequence. The window they span measures match
 * tightness (a contiguous substring spans exactly q.length).
 */
function subsequencePositions(q: string, candidate: string): number[] | null {
  const out: number[] = [];
  let from = 0;
  for (let i = 0; i < q.length; i += 1) {
    const at = candidate.indexOf(q[i], from);
    if (at < 0) return null;
    out.push(at);
    from = at + 1;
  }
  return out;
}

/** Tightness in (0, 1]: query length over the width of the matched window. */
function spanQuality(q: string, positions: number[]): number {
  const span = positions[positions.length - 1] - positions[0] + 1;
  return q.length / span;
}

/**
 * Full path ("/"-joined names from the root down) for every node, by walking
 * `parentId` up with memoization — one pass, cycle-safe (a corrupt parent
 * chain terminates as if at the root rather than hanging).
 */
function buildPaths(nodes: readonly QuickOpenNode[]): Map<string, string> {
  const byId = new Map<string, QuickOpenNode>();
  for (const n of nodes) byId.set(n.id, n);
  const paths = new Map<string, string>();
  const resolve = (node: QuickOpenNode): string => {
    const cached = paths.get(node.id);
    if (cached !== undefined) return cached;
    // Collect the unresolved chain root-ward, then fill it in top-down.
    const chain: QuickOpenNode[] = [];
    const seen = new Set<string>();
    let cur: QuickOpenNode | undefined = node;
    let base = "";
    while (cur) {
      const hit = paths.get(cur.id);
      if (hit !== undefined) {
        base = hit;
        break;
      }
      if (seen.has(cur.id)) break; // cycle guard: treat as a root
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      base = base === "" ? chain[i].name : `${base}/${chain[i].name}`;
      paths.set(chain[i].id, base);
    }
    return paths.get(node.id) ?? node.name;
  };
  for (const n of nodes) resolve(n);
  return paths;
}

/**
 * Rank the tree's findable items against `query`. Best first, at most
 * `limit` rows; deterministic for identical inputs. Folders never match —
 * every other kind (files, and the database roots the tree treats as leaves)
 * is fair game, per the explorer's own "containers vs items" split.
 */
export function quickOpenMatches(
  query: string,
  nodes: readonly QuickOpenNode[],
  opts: QuickOpenOptions = {},
): QuickOpenCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? QUICK_OPEN_LIMIT;
  const paths = buildPaths(nodes);

  interface Scored {
    candidate: QuickOpenCandidate;
    path: string;
  }
  const scored: Scored[] = [];
  for (const n of nodes) {
    if (n.kind === "folder") continue;
    const path = paths.get(n.id) ?? n.name;
    const nameLower = n.name.toLowerCase();
    const pathLower = path.toLowerCase();

    let tier: number;
    let quality: number;
    let nameHits: number[] = [];
    const namePositions = subsequencePositions(q, nameLower);
    if (namePositions) {
      tier = nameLower.startsWith(q) ? TIER_NAME_PREFIX : TIER_NAME_SUBSEQUENCE;
      // A prefix is the tightest possible window; score its quality off the
      // contiguous run rather than the greedy scan (identical here anyway).
      quality = spanQuality(q, namePositions);
      // Case-folding can change string length for exotic characters (e.g.
      // "İ"); skip emphasis rather than mis-highlight when it does.
      if (nameLower.length === n.name.length) nameHits = namePositions;
    } else {
      const pathPositions = subsequencePositions(q, pathLower);
      if (!pathPositions) continue;
      tier = TIER_PATH_SUBSEQUENCE;
      quality = spanQuality(q, pathPositions);
    }

    const dirEnd = path.length - n.name.length - 1; // "…/name" → dir length
    scored.push({
      path,
      candidate: {
        id: n.id,
        name: n.name,
        dir: dirEnd > 0 ? path.slice(0, dirEnd) : "",
        kind: n.kind,
        mimeType: n.mimeType,
        ragIncluded: n.ragIncluded,
        localOnly: n.localOnly === true,
        score: tier + quality * W_QUALITY,
        nameHits,
      },
    });
  }

  scored.sort((a, b) => {
    if (a.candidate.score !== b.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
  });
  return scored.slice(0, Math.max(0, limit)).map((s) => s.candidate);
}
