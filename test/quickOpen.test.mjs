// Quick-open ranker (src/lib/quickOpen.ts) — the pure half of the Ctrl/Cmd+P
// fuzzy finder. Pins the tier dominance (name-prefix > name-subsequence >
// path-subsequence), span tightness, the shorter-path/alpha tie-breaks, the
// files-only filter, path building by parentId walk, the empty-query gate,
// the row cap, and determinism. The palette (QuickOpen.tsx) is wiring — this
// module ranks whatever tree it's given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { quickOpenMatches, QUICK_OPEN_LIMIT } = await import("../src/lib/quickOpen.ts");

/** Node shorthand: id doubles as the name unless overridden. */
const n = (id, parentId, kind, extra = {}) => ({
  id,
  parentId,
  name: extra.name ?? id,
  kind,
  ragIncluded: extra.ragIncluded ?? false,
  ...(extra.localOnly !== undefined ? { localOnly: extra.localOnly } : {}),
  ...(extra.mimeType !== undefined ? { mimeType: extra.mimeType } : {}),
});

// A small tree: root folder "docs" > "2026" > files, plus a root-level file.
const TREE = [
  n("docs", null, "folder"),
  n("2026", "docs", "folder"),
  n("report.md", "2026", "file"),
  n("roadmap.pdf", "docs", "file", { mimeType: "application/pdf" }),
  n("readme.md", null, "file"),
];

test("empty or blank query matches nothing (a finder, not a browser)", () => {
  assert.deepEqual(quickOpenMatches("", TREE), []);
  assert.deepEqual(quickOpenMatches("   \n ", TREE), []);
});

test("folders never match, even on an exact name hit", () => {
  const got = quickOpenMatches("docs", TREE);
  assert.ok(got.length > 0, "files under docs/ still match by path");
  assert.ok(got.every((c) => c.kind !== "folder"));
  assert.ok(!got.some((c) => c.id === "docs"));
});

test("paths come from the parentId walk: dir joins ancestor names with /", () => {
  const got = quickOpenMatches("report", TREE);
  assert.equal(got[0].id, "report.md");
  assert.equal(got[0].dir, "docs/2026");
  const root = quickOpenMatches("readme", TREE);
  assert.equal(root[0].dir, "", "root-level items carry an empty dir");
});

test("matching is case-insensitive over name and path", () => {
  assert.equal(quickOpenMatches("REPORT", TREE)[0].id, "report.md");
  assert.equal(quickOpenMatches("DOCS/2026", TREE)[0].id, "report.md");
});

test("name-prefix beats name-subsequence beats path-subsequence", () => {
  const tree = [
    n("q", null, "folder", { name: "quarterly" }),
    // Only the PATH ("quarterly/summary.txt") contains "qu".
    n("path-hit", "q", "file", { name: "summary.txt" }),
    // Name contains "qu" as a subsequence, not a prefix.
    n("sub-hit", null, "file", { name: "my-quips.txt" }),
    // Name STARTS with "qu" — but bury it deep so only the tier can win.
    n("prefix-hit", "q", "file", { name: "quips-archive-2026-backup.txt" }),
  ];
  const got = quickOpenMatches("qu", tree);
  assert.deepEqual(
    got.map((c) => c.id),
    ["prefix-hit", "sub-hit", "path-hit"],
  );
  assert.ok(got[0].score > got[1].score && got[1].score > got[2].score);
});

test("within a tier, a tighter span ranks higher", () => {
  const tree = [
    n("loose", null, "file", { name: "monthly-rollup-example.md" }), // m…r…e scattered
    n("tight", null, "file", { name: "z-mre-notes.md" }), // "mre" contiguous
  ];
  const got = quickOpenMatches("mre", tree);
  assert.deepEqual(
    got.map((c) => c.id),
    ["tight", "loose"],
  );
});

test("score ties break by shorter path, then alphabetically", () => {
  const tree = [
    n("deep", null, "folder", { name: "archive" }),
    n("deep-report", "deep", "file", { name: "report.md" }),
    n("shallow-report", null, "file", { name: "report.md" }),
    n("sibling", null, "file", { name: "report.py" }), // same length, alpha after .md
  ];
  const got = quickOpenMatches("report", tree);
  assert.deepEqual(
    got.map((c) => c.id),
    ["shallow-report", "sibling", "deep-report"],
  );
});

test("caps at the limit (default 12)", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    n(`file-${String(i).padStart(2, "0")}.txt`, null, "file"),
  );
  assert.equal(QUICK_OPEN_LIMIT, 12);
  assert.equal(quickOpenMatches("file", many).length, 12);
  assert.equal(quickOpenMatches("file", many, { limit: 3 }).length, 3);
});

test("rows carry the glance state and emphasis hits the UI renders", () => {
  const tree = [
    n("visible.md", null, "file", { ragIncluded: true, localOnly: true }),
    n("hidden.md", null, "file", { ragIncluded: false }),
  ];
  const [vis] = quickOpenMatches("visible", tree);
  assert.equal(vis.ragIncluded, true);
  assert.equal(vis.localOnly, true);
  const [hid] = quickOpenMatches("hidden", tree);
  assert.equal(hid.ragIncluded, false);
  assert.equal(hid.localOnly, false, "absent localOnly reads as unmarked");
  // Prefix match: the hit indices are the first query-length name positions.
  assert.deepEqual(vis.nameHits, [0, 1, 2, 3, 4, 5, 6]);
  // Path-only match: no name emphasis.
  const deep = [n("d", null, "folder", { name: "ledger" }), n("inside", "d", "file", { name: "x.txt" })];
  const [pathOnly] = quickOpenMatches("ledger", deep);
  assert.equal(pathOnly.id, "inside");
  assert.deepEqual(pathOnly.nameHits, []);
});

test("deterministic: identical inputs give identical output", () => {
  const a = quickOpenMatches("re", TREE);
  const b = quickOpenMatches("re", TREE);
  assert.deepEqual(a, b);
});
