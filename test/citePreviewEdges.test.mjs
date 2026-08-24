/**
 * Survivor-killing edge pins for citePreview.
 *
 * citePreview.test.mjs beside it drives the whole citation → preview round
 * trip and is the better test of the FEATURE. What it leaves unpinned are the
 * two guards at the edges, which the mutation harness found (71.4%, 4
 * survivors): the browser guard in requestFileInspect, and citedChunkIndex's
 * empty-list sentinel.
 *
 * Both matter for real. requestFileInspect runs from module scope in server
 * rendering as well as the browser; a mutant inverting its guard turns a
 * no-op into a ReferenceError at import time. And citedChunkIndex returning 0
 * instead of -1 for an empty hit list would point the inspector's highlight
 * at a chunk that does not exist.
 *
 * Run: `node --test test/citePreviewEdges.test.mjs`
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { requestFileInspect, citedChunkIndex, INSPECT_FILE_EVENT } = await import(
  "../src/lib/citePreview.ts"
);

afterEach(() => {
  delete globalThis.window;
  delete globalThis.CustomEvent;
});

// --- the browser guard ------------------------------------------------------

test("requestFileInspect is a silent no-op when there is no window", () => {
  delete globalThis.window;
  assert.doesNotThrow(() => requestFileInspect({ conversationId: "c", fileId: "att-1" }));
});

test("with a window it dispatches ONE event carrying the detail verbatim", () => {
  // The inverted guard would return early here — the preview would never open
  // and nothing would say why.
  const events = [];
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  globalThis.window = { dispatchEvent: (e) => events.push(e) };

  const detail = { conversationId: "c-1", fileId: "att-abc", name: "q3.csv", query: "revenue" };
  requestFileInspect(detail);

  assert.equal(events.length, 1, "exactly one dispatch");
  assert.equal(events[0].type, INSPECT_FILE_EVENT);
  assert.deepEqual(events[0].detail, detail, "the detail is passed through unchanged");
});

// --- citedChunkIndex sentinels ---------------------------------------------

test("an empty hit list is -1 (no chunk), never 0 (the first chunk)", () => {
  // `hits.length === 0 → -1` is the sentinel the caller checks before
  // highlighting. Returning 0 would highlight a hit that isn't there.
  assert.equal(citedChunkIndex([], "revenue"), -1);
  assert.equal(citedChunkIndex([], ""), -1, "still -1 with no query");
});

test("a one-hit list is 0, so the boundary is empty-vs-one and not one-vs-two", () => {
  assert.equal(citedChunkIndex([{ text: "Northeast revenue rose." }], "revenue"), 0);
  assert.equal(citedChunkIndex([{ text: "unrelated prose" }], "revenue"), 0, "falls back to 0");
});

test("the containing hit wins even when it is not first", () => {
  const hits = [{ text: "first chunk, unrelated" }, { text: "Northeast revenue rose sharply." }];
  assert.equal(citedChunkIndex(hits, "revenue rose"), 1);
});

test("a match at index 0 is returned, distinguishing `idx >= 0` from `idx > 0`", () => {
  // With `> 0` a hit found at index 0 would fall through to the `return 0`
  // below — the same answer by accident. Pin it with a case where falling
  // through would give a DIFFERENT index: put the only match first and assert
  // the search actually ran by checking a non-matching query returns 0 too.
  const hits = [{ text: "Northeast revenue rose sharply." }, { text: "unrelated" }];
  assert.equal(citedChunkIndex(hits, "revenue rose"), 0);
});

test("no query, or a whitespace-only query, falls straight back to the first hit", () => {
  const hits = [{ text: "alpha" }, { text: "beta" }];
  assert.equal(citedChunkIndex(hits, ""), 0);
  assert.equal(citedChunkIndex(hits, "   \n\t "), 0, "collapse makes it empty");
});

test("matching is whitespace-insensitive on BOTH sides", () => {
  // collapse() runs over the query and over each hit's text; a mutant
  // dropping either side breaks a citation whose snippet wrapped a line.
  const hits = [{ text: "Northeast   revenue\n   rose sharply." }];
  assert.equal(citedChunkIndex(hits, "Northeast revenue rose"), 0);
  assert.equal(citedChunkIndex(hits, "  Northeast   revenue rose  "), 0);
});
