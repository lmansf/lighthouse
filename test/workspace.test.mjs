/**
 * Unit tests for the session workspace (src/server/workspace.ts) — the
 * attachments-only corpus of the 0.15.0 refocus.
 *
 * PARITY: workspace.rs's unit tests pin the same id literal and the same
 * cap messages; the twins share these fixtures.
 *
 * Run: `node --test test/workspace.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ws = await import("../src/server/workspace.ts");

/** Fresh app-state root per test — appStateDir() re-reads the env var. */
function freshState(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-ws-${tag}-`));
  process.env.LIGHTHOUSE_APP_STATE_DIR = dir;
  return dir;
}

test("attachment ids are pinned across engines (att- + sha256(hash+name)[..12])", () => {
  // PARITY: workspace.rs asserts the SAME literal.
  const hash = createHash("sha256").update("hello,world\n").digest("hex");
  assert.equal(ws.attachmentId(hash, "a.csv"), "att-69f7e4ec78ca");
});

test("attach round-trips, re-attach is idempotent, blobs are shared", () => {
  freshState("rt");
  const a = ws.attach("conv-1", "a.csv", Buffer.from("x,y\n1,2\n"));
  assert.ok(a.id.startsWith("att-"));
  assert.equal(a.size, 8);
  const again = ws.attach("conv-1", "a.csv", Buffer.from("x,y\n1,2\n"));
  assert.deepEqual(again, a, "same bytes + name = same entry, no growth");
  assert.equal(ws.list("conv-1").length, 1);
  const r = ws.resolve("conv-1", a.id);
  assert.equal(r.name, "a.csv");
  assert.equal(fs.readFileSync(r.path, "utf8"), "x,y\n1,2\n");
  const b = ws.attach("conv-2", "a.csv", Buffer.from("x,y\n1,2\n"));
  assert.equal(b.id, a.id, "same bytes in another conversation share id + blob");
});

test("caps refuse at the boundary with the pinned messages", () => {
  freshState("cap");
  for (let i = 0; i < ws.MAX_ATTACHMENTS; i++) {
    ws.attach("conv-cap", `f${i}.txt`, Buffer.from(`body ${i}`));
  }
  assert.throws(
    () => ws.attach("conv-cap", "one-more.txt", Buffer.from("z")),
    new Error("a conversation holds at most 10 files — remove one first"),
  );
  assert.equal(ws.list("conv-cap").length, ws.MAX_ATTACHMENTS, "refusal added nothing");
  // Re-attaching an EXISTING file still works at the cap.
  ws.attach("conv-cap", "f0.txt", Buffer.from("body 0"));
  assert.throws(
    () => ws.attach("conv-2", "big.bin", Buffer.alloc(ws.MAX_ATTACHMENT_BYTES + 1)),
    new Error("files are capped at 25 MB"),
  );
  assert.throws(
    () => ws.attach("conv-2", "empty.bin", Buffer.alloc(0)),
    new Error("this file is empty"),
  );
});

test("detach leaves the blob; resolve reports gaps honestly", () => {
  freshState("det");
  const a = ws.attach("conv-d", "a.txt", Buffer.from("abc"));
  const b = ws.attach("conv-e", "a.txt", Buffer.from("abc"));
  ws.detach("conv-d", a.id);
  assert.deepEqual(ws.list("conv-d"), []);
  assert.equal(ws.resolve("conv-d", a.id), null, "detached = gone from HERE");
  const r = ws.resolve("conv-e", b.id);
  assert.ok(fs.existsSync(r.path), "blob survives while referenced anywhere");
  fs.unlinkSync(r.path);
  assert.equal(ws.resolve("conv-e", b.id), null, "vanished blob = null, never a crash");
});

test("traversal-shaped conversation ids stay inside the workspace", () => {
  const root = freshState("trav");
  const a = ws.attach("../../etc/passwd", "a.txt", Buffer.from("abc"));
  const names = fs.readdirSync(path.join(root, "workspace"));
  assert.ok(
    names.some((n) => n.startsWith("etcpasswd-")),
    `sanitized + hash-suffixed manifest, in place: ${names}`,
  );
  assert.ok(ws.resolve("../../etc/passwd", a.id));
  // Distinct raw ids that sanitize identically stay distinct files.
  ws.attach("etc/passwd", "b.txt", Buffer.from("xyz"));
  assert.equal(ws.list("../../etc/passwd").length, 1);
  assert.equal(ws.list("etc/passwd").length, 1);
});

test("sweep drops only old unreferenced blobs", () => {
  freshState("swp");
  const kept = ws.attach("conv-s", "kept.txt", Buffer.from("keep me"));
  const gone = ws.attach("conv-s", "gone.txt", Buffer.from("drop me"));
  ws.detach("conv-s", gone.id);
  ws.sweep();
  assert.ok(fs.existsSync(ws.blobPath(gone.hash, gone.name)), "young blob survives the sweep");
  const old = new Date(1_000_000_000);
  fs.utimesSync(ws.blobPath(gone.hash, gone.name), old, old);
  fs.utimesSync(ws.blobPath(kept.hash, kept.name), old, old);
  ws.sweep();
  assert.ok(!fs.existsSync(ws.blobPath(gone.hash, gone.name)), "old unreferenced blob swept");
  assert.ok(fs.existsSync(ws.blobPath(kept.hash, kept.name)), "referenced blob immortal");
});

test("ingest warms extraction for rich files and no-ops on plain or missing blobs", async () => {
  freshState("ing");
  const csv = ws.attach("conv-i", "sales.csv", Buffer.from("region,amount\nNE,10\n"));
  await ws.ingest(csv); // plain text: nothing to warm, nothing to throw
  await ws.ingest({ id: "att-none", name: "gone.pdf", hash: "0".repeat(64), size: 1, addedMs: 0 });
});

test("blobs keep the extension the format layer sniffs", () => {
  freshState("ext");
  const a = ws.attach("conv-x", "sales.CSV", Buffer.from("region,amount\nNE,1\n"));
  assert.equal(path.extname(ws.resolve("conv-x", a.id).path), ".csv", "lowercased extension rides the blob");
  // Same bytes under a different extension is a different blob AND attachment.
  const b = ws.attach("conv-x", "sales.txt", Buffer.from("region,amount\nNE,1\n"));
  assert.notEqual(b.id, a.id);
  assert.equal(b.hash, a.hash, "one hash, two blobs");
  assert.notEqual(ws.resolve("conv-x", b.id).path, ws.resolve("conv-x", a.id).path);
  // An extension-less name still resolves (bare hash).
  const c = ws.attach("conv-x", "README", Buffer.from("hello"));
  assert.ok(ws.resolve("conv-x", c.id));
});
