/**
 * §35 §4: progressive disclosure for long sectioned answers on the phone. A
 * remark transform in the remarkAnswerCard mold (plain tree surgery, no new
 * dependency): when ENABLED — the caller passes `enabled` only for a settled
 * answer on the compact layout, never mid-stream, never on desktop — each
 * h2/h3-delimited section whose text runs past ~1,200 characters keeps its
 * heading and first two blocks, and the remainder moves into one
 * `lh-collapsed-section` wrapper the renderer swaps for a quiet 44pt
 * "Show more" (per-message React state, nothing persisted). The lead — every
 * block before the first h2/h3 — is NEVER collapsed, and a section already
 * short enough, or with nothing beyond the visible blocks, is left alone.
 *
 * Pure and renderer-free so the sectioning contract is unit-testable in node
 * (test/collapseSections.test.mjs); ChatPanel owns the interactive swap.
 */

/** A section must exceed this many text characters to collapse. */
export const COLLAPSE_THRESHOLD_CHARS = 1200;

/** How many body blocks stay visible ahead of the fold. */
export const COLLAPSE_VISIBLE_BLOCKS = 2;

/** The class the renderer's div override watches for. */
export const COLLAPSED_SECTION_CLASS = "lh-collapsed-section";

interface MdNode {
  type?: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

function mdText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(mdText).join("");
}

const isSectionHead = (n: MdNode): boolean =>
  n.type === "heading" && (n.depth === 2 || n.depth === 3);

/**
 * §44 §3: the engine's deterministic transparency footers — the Query-used
 * disclosure (folded to `lhQueryDetails` / an `lh-query-used` div by
 * remarkAnswerCard, which runs first), the assumption ledger, and the raw
 * Computed-from / Certified / §1b "Computed exactly by Lighthouse" lines. A
 * verified number's proof is shown BY DEFAULT, on compact as on desktop, so
 * these are never parked behind "Show more".
 */
function isProvenanceFooter(n: MdNode): boolean {
  if (n.type === "lhQueryDetails" || n.type === "lhAssumptions") return true;
  const cls = (n.data?.hProperties as { className?: string[] } | undefined)?.className;
  if (Array.isArray(cls) && cls.includes("lh-query-used")) return true;
  const t = mdText(n).trimStart();
  return (
    t.startsWith("Query used:") ||
    t.startsWith("Queries used") ||
    t.startsWith("Computed from:") ||
    t.startsWith("Computed exactly by Lighthouse") ||
    t.startsWith("Certified:")
  );
}

/**
 * Remark plugin. `enabled: true` is the compact-and-settled gate — the
 * default is a no-op so the streaming path and desktop never fold anything.
 */
export function remarkCollapseSections(options?: { enabled?: boolean }) {
  const enabled = options?.enabled === true;
  return (tree: unknown) => {
    if (!enabled) return;
    const root = tree as MdNode;
    const children = root.children;
    if (!children) return;

    const heads: number[] = [];
    children.forEach((n, i) => {
      if (isSectionHead(n)) heads.push(i);
    });
    if (heads.length === 0) return; // unsectioned answer = all lead, untouched

    // Back to front so earlier indices survive each splice.
    for (let h = heads.length - 1; h >= 0; h -= 1) {
      const start = heads[h];
      const end = h + 1 < heads.length ? heads[h + 1] : children.length;
      const body = children.slice(start + 1, end);
      if (body.length <= COLLAPSE_VISIBLE_BLOCKS) continue;
      const chars = [children[start], ...body].reduce(
        (sum, n) => sum + mdText(n).length,
        0,
      );
      if (chars <= COLLAPSE_THRESHOLD_CHARS) continue;
      let hidden = body.slice(COLLAPSE_VISIBLE_BLOCKS);
      // §44 §3: trim the collapsible tail at the first engine provenance footer
      // so the Query-used / Computed-from / §1b computation stays visible even
      // when the section is long — the constitution shows a verified number's
      // proof by default, mobile as desktop.
      const footerAt = hidden.findIndex(isProvenanceFooter);
      if (footerAt >= 0) hidden = hidden.slice(0, footerAt);
      if (hidden.length === 0) continue;
      const wrapper: MdNode = {
        type: "lhCollapsedSection",
        data: {
          hName: "div",
          hProperties: { className: [COLLAPSED_SECTION_CLASS] },
        },
        children: hidden,
      };
      children.splice(start + 1 + COLLAPSE_VISIBLE_BLOCKS, hidden.length, wrapper);
    }
  };
}
