/**
 * Every `lighthouse:*` event a component DISPATCHES must have a LISTENER.
 *
 * 0.15.0 deleted the file explorer, and the `lighthouse:browse-files` listener
 * went with it — while both "Choose files…" and "Attach files" kept dispatching
 * the event. The buttons fired into nothing, so attaching by click was dead on
 * every platform. It shipped. On Windows it was total: the DOM drag events do
 * not fire in the desktop shell, leaving the native drop as the only way to
 * attach a file at all.
 *
 * The same deletion pass left a "Pinned questions" row in Settings dispatching
 * `lighthouse:open-pins` at a feature that no longer exists.
 *
 * Nothing caught either. choiceDensity.test.mjs asserts the browse-files
 * DISPATCH is present — one half of a two-ended seam — so it stayed green while
 * the other end was deleted. That is the shape of the bug: a custom event is a
 * seam whose ends live in different files, and deleting one end is invisible to
 * every test that only reads the other.
 *
 * This checks BOTH ends across the whole of src/. It is deliberately coarse: it
 * never asks whether a listener is correct, only that the event someone
 * dispatches is one someone else is waiting for.
 *
 * Run: `node --test test/eventSeams.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");

/** Every .ts/.tsx file under src/, recursively. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sources(SRC);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** `lighthouse:x` names appearing in a `new CustomEvent(...)`/`new Event(...)`. */
const DISPATCH = /new (?:Custom)?Event\(\s*"(lighthouse:[a-z-]+)"/g;
/** …and in an `addEventListener("lighthouse:x"`. */
const LISTEN = /addEventListener\(\s*"(lighthouse:[a-z-]+)"/g;

function collect(re) {
  const found = new Map(); // event -> [files]
  for (const [file, body] of text) {
    for (const m of body.matchAll(re)) {
      const rel = path.relative(path.join(SRC, ".."), file);
      found.set(m[1], [...(found.get(m[1]) ?? []), rel]);
    }
  }
  return found;
}

test("every dispatched lighthouse:* event has a listener somewhere in src/", () => {
  const dispatched = collect(DISPATCH);
  const listened = collect(LISTEN);

  assert.ok(dispatched.size > 0, "the scan found no dispatches at all — the regex is wrong");

  const orphans = [...dispatched.entries()]
    .filter(([evt]) => !listened.has(evt))
    .map(([evt, where]) => `${evt} (dispatched in ${where.join(", ")})`);

  assert.deepEqual(
    orphans,
    [],
    `dead button(s): these events are dispatched but nothing listens —\n  ${orphans.join("\n  ")}`,
  );
});

test("the browse-files seam — the one 0.15.0 broke — is whole at BOTH ends", () => {
  const chat = readFileSync(path.join(SRC, "features/chat/ChatPanel.tsx"), "utf8");
  assert.match(
    chat,
    /new CustomEvent\("lighthouse:browse-files"\)/,
    "the attach buttons still route through the shared browse-files event",
  );
  assert.match(
    chat,
    /addEventListener\("lighthouse:browse-files"/,
    "…and ChatPanel LISTENS for it — this is the half whose deletion shipped",
  );
  // The listener is only useful if it reaches a real picker and the picked
  // files reach the attach path.
  assert.match(chat, /type="file"/, "a file input backs the browse door");
  assert.match(chat, /multiple/, "…and takes more than one file");
  assert.match(
    chat,
    /attachOsFilesRef\.current\(picked\)/,
    "picked files go through the same attach seam a drop uses",
  );
});
