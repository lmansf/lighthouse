/**
 * §35 §3: stat-run detection. Engines answering "what are the key numbers"
 * asks emit runs of `- **Label:** value` bullets; as a bullet list those read
 * as prose with decoration, when what the eye wants is a two-column scan.
 * `detectStatRun` decides — from the rendered list's hast node, so the
 * decision matches exactly what would have been displayed — whether a <ul> is
 * such a run: at least three items, EVERY item a bold label ending in a colon
 * followed by plain inline text. Anything else (mixed items, links or
 * citations in a label or value, nested lists, multi-paragraph items) returns
 * null and the list renders as ordinary bullets — on any doubt, fall back.
 *
 * Pure and renderer-free so the contract is unit-testable in node
 * (test/statRun.test.mjs); ChatPanel's `ul` markdown override is the only
 * caller.
 */

export interface StatRunItem {
  /** Bold label text, trailing colon stripped. */
  label: string;
  /** Plain-text remainder of the item. */
  value: string;
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: unknown[];
}

const asNode = (n: unknown): HastNode | null =>
  typeof n === "object" && n !== null ? (n as HastNode) : null;

const isElement = (n: unknown): boolean => Boolean(asNode(n)?.tagName);

const isText = (n: unknown): boolean => asNode(n)?.type === "text";

/** Concatenated text of a node's subtree. */
function textOf(node: unknown): string {
  const n = asNode(node);
  if (!n) return "";
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(textOf).join("");
}

/**
 * The meaningful children of an <li>: whitespace-only text nodes dropped,
 * and a single paragraph wrapper (a "loose" markdown list) unwrapped so
 * tight and loose spellings of the same run detect identically.
 */
function itemChildren(li: HastNode): unknown[] {
  const kids = (li.children ?? []).filter(
    (k) => !(isText(k) && textOf(k).trim() === ""),
  );
  if (kids.length === 1) {
    const only = asNode(kids[0]);
    if (only?.tagName === "p") {
      return (only.children ?? []).filter(
        (k) => !(isText(k) && textOf(k).trim() === ""),
      );
    }
  }
  return kids;
}

/**
 * Decide whether a rendered <ul> is a stat run, returning its label/value
 * pairs — or null (render ordinary bullets) on any deviation.
 */
export function detectStatRun(ul: unknown): StatRunItem[] | null {
  const list = asNode(ul);
  if (list?.tagName !== "ul") return null;
  const lis = (list.children ?? []).filter(isElement).map((n) => asNode(n)!);
  if (lis.length < 3 || lis.some((li) => li.tagName !== "li")) return null;

  const items: StatRunItem[] = [];
  for (const li of lis) {
    const kids = itemChildren(li);
    const [first, ...rest] = kids;
    const strong = asNode(first);
    // The label is a leading <strong> of PLAIN text — a link, citation, or
    // code inside the bold is doubt, so the whole list stays bullets.
    if (strong?.tagName !== "strong") return null;
    if ((strong.children ?? []).some(isElement)) return null;
    // The value is everything after the bold, and must be plain inline text —
    // an element there (citation chip, link, nested list) must survive, which
    // only the ordinary bullet rendering guarantees.
    if (rest.some(isElement)) return null;

    let label = textOf(strong).trim();
    let value = rest.map(textOf).join("").trim();
    if (label.endsWith(":")) {
      label = label.slice(0, -1).trimEnd(); // "**Label:** value"
    } else if (value.startsWith(":")) {
      value = value.slice(1).trimStart(); // "**Label**: value"
    } else {
      return null; // no colon — not a key-value item
    }
    if (!label || !value) return null;
    items.push({ label, value });
  }
  return items;
}
