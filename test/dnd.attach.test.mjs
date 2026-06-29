/**
 * Regression test for the explorer → chat drag-and-drop channel (src/shell/dnd.ts).
 *
 * Dragging a file row out of the explorer onto the chat panel attaches it to the
 * next question. The custom MIME (`application/x-lighthouse-file`) is what keeps
 * these internal drags distinguishable from OS file drops: ChatPanel parses the
 * custom payload to attach vault files, and only falls through to upload-then-
 * attach when the drop carries no such payload (a real OS file). This guards that
 * contract — a regression here would silently break attaching, or make an OS drop
 * look like an internal one (and never upload).
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_DRAG_MIME,
  serializeDraggedFiles,
  parseDraggedFiles,
} from "../src/shell/dnd.ts";

/** Minimal DataTransfer stand-in: only getData is read by parseDraggedFiles. */
const dt = (store = {}) => ({ getData: (mime) => store[mime] ?? "" });

test("explorer serialize → chat parse round-trips the dragged vault files", () => {
  const files = [
    { id: "secret.txt", name: "secret.txt" },
    { id: "folder/alpha.txt", name: "alpha.txt" },
  ];
  const payload = serializeDraggedFiles(files);
  const parsed = parseDraggedFiles(dt({ [FILE_DRAG_MIME]: payload }));
  assert.deepEqual(parsed, files, "the chat panel sees exactly the dragged files");
});

test("an OS file drop (no custom MIME) parses as empty so chat uploads instead", () => {
  // OS drops expose only DataTransfer.files / the "Files" type, never our MIME.
  assert.deepEqual(parseDraggedFiles(dt({})), []);
});

test("malformed or foreign payloads are tolerated, never throw, never leak", () => {
  assert.deepEqual(parseDraggedFiles(dt({ [FILE_DRAG_MIME]: "not json" })), []);
  assert.deepEqual(parseDraggedFiles(dt({ [FILE_DRAG_MIME]: "{}" })), []);
  // Wrong-shaped entries are filtered out (id/name must both be strings).
  assert.deepEqual(
    parseDraggedFiles(dt({ [FILE_DRAG_MIME]: JSON.stringify([{ foo: 1 }, { id: 1, name: 2 }]) })),
    [],
  );
});
