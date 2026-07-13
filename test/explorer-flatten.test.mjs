// Flatten logic behind the virtualized vault tree (src/features/explorer/
// flatten.ts). The windowed explorer renders whatever this produces, so these
// pin the behavior the old recursive TreeRow had: DFS order + depth, the expand
// gate, the search (visibleIds) filter, and the sibling comparator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { flattenVisible } = await import("../src/features/explorer/flatten.ts");

// Tree:  root1/ { sub/ { b.md }, a.md }   root2/ { c.md }
const N = {
  root1: { id: "root1", parentId: null, sourceId: "s", name: "root1", kind: "folder", ragIncluded: false },
  sub: { id: "sub", parentId: "root1", sourceId: "s", name: "sub", kind: "folder", ragIncluded: false },
  b: { id: "b", parentId: "sub", sourceId: "s", name: "b.md", kind: "file", ragIncluded: true },
  a: { id: "a", parentId: "root1", sourceId: "s", name: "a.md", kind: "file", ragIncluded: true },
  root2: { id: "root2", parentId: null, sourceId: "s", name: "root2", kind: "folder", ragIncluded: false },
  c: { id: "c", parentId: "root2", sourceId: "s", name: "c.md", kind: "file", ragIncluded: true },
};
const all = Object.values(N);
const childrenOf = (id) => all.filter((n) => n.parentId === id);
// Folders first, then name — the explorer's real ordering.
const compareNodes = (x, y) => {
  if (x.kind !== y.kind) return x.kind === "folder" ? -1 : 1;
  return x.name.localeCompare(y.name);
};
const ids = (rows) => rows.map((r) => `${r.node.id}@${r.depth}`);

test("fully expanded, no filter: DFS order, folders-first, correct depths", () => {
  const rows = flattenVisible([N.root1, N.root2], childrenOf, compareNodes, () => true, null);
  // sub (folder) sorts before a.md (file) under root1; b.md nests under sub.
  assert.deepEqual(ids(rows), ["root1@0", "sub@1", "b@2", "a@1", "root2@0", "c@1"]);
});

test("a collapsed folder hides its whole subtree", () => {
  const isExpanded = (id) => id !== "root1"; // root1 collapsed, everything else open
  const rows = flattenVisible([N.root1, N.root2], childrenOf, compareNodes, isExpanded, null);
  assert.deepEqual(ids(rows), ["root1@0", "root2@0", "c@1"]);
});

test("a collapsed nested folder keeps its parent but drops its children", () => {
  const isExpanded = (id) => id !== "sub"; // sub collapsed
  const rows = flattenVisible([N.root1], childrenOf, compareNodes, isExpanded, null);
  assert.deepEqual(ids(rows), ["root1@0", "sub@1", "a@1"]); // b.md gone, a.md stays
});

test("visibleIds (search) filters children to the kept set", () => {
  // A search that matched b.md keeps the path root1 > sub > b.md, drops a.md.
  const visible = new Set(["root1", "sub", "b"]);
  const rows = flattenVisible([N.root1], childrenOf, compareNodes, () => true, visible);
  assert.deepEqual(ids(rows), ["root1@0", "sub@1", "b@2"]);
});

test("files are leaves — never recursed even if isExpanded is true for their id", () => {
  const rows = flattenVisible([N.a], childrenOf, compareNodes, () => true, null);
  assert.deepEqual(ids(rows), ["a@0"]);
});

test("empty roots produce no rows", () => {
  assert.deepEqual(flattenVisible([], childrenOf, compareNodes, () => true, null), []);
});
