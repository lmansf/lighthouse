/**
 * Survivor-killing boundary pins for the session workspace.
 *
 * Why a second file beside workspace.test.mjs. The PR-scoped mutation harness
 * (.github/workflows/mutation.yml) scored `src/server/workspace.ts` at 43.9%
 * — 46 surviving mutants — while every functional test above it passed. That
 * gap is the classic one: the suite proves the HAPPY PATH of the module the
 * whole 0.15.0 refocus rests on, but never pins the exact constants, the
 * exact comparison operators, or the exact slice widths. Flip `>=` to `>` in
 * the cap check, or `slice(0, 12)` to `slice(0, 13)` in the id, and the
 * functional tests stay green.
 *
 * Every test here exists to make one such flip fail. PARITY: each boundary is
 * the same one workspace.rs asserts — these twins must agree byte-for-byte or
 * an attachment minted on desktop would not resolve on iOS.
 *
 * Run: `node --test test/workspaceMutants.test.mjs`
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

function freshState(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-wsm-${tag}-`));
  process.env.LIGHTHOUSE_APP_STATE_DIR = dir;
  return dir;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- the two exported constants ARE the product promise ----------------------

test("MAX_ATTACHMENTS is exactly 10 and MAX_ATTACHMENT_BYTES exactly 25 MiB", () => {
  // A mutant that makes either off-by-one changes what the app promises.
  assert.equal(ws.MAX_ATTACHMENTS, 10);
  assert.equal(ws.MAX_ATTACHMENT_BYTES, 26_214_400);
  assert.equal(ws.MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024, "MiB, not MB");
});

// --- id minting: width, prefix, and the ORDER of the concatenation -----------

test("an attachment id is `att-` plus exactly 12 lowercase hex characters", () => {
  const id = ws.attachmentId(sha("bytes"), "a.csv");
  assert.match(id, /^att-[0-9a-f]{12}$/);
  assert.equal(id.length, 16, "att- (4) + 12");
});

test("the id hashes hash+name in THAT order, so a swap is detectable", () => {
  // `sha256(hash + name)` and `sha256(name + hash)` are both stable and both
  // 12 hex wide — only a fixture pins which one shipped. The Rust twin mints
  // the first; an id minted under the second would not resolve cross-engine.
  const h = sha("payload");
  const expected = `att-${sha(`${h}a.csv`).slice(0, 12)}`;
  assert.equal(ws.attachmentId(h, "a.csv"), expected);
  assert.notEqual(ws.attachmentId(h, "a.csv"), `att-${sha(`a.csv${h}`).slice(0, 12)}`);
});

test("id varies with BOTH inputs independently", () => {
  const h1 = sha("one");
  const h2 = sha("two");
  assert.notEqual(ws.attachmentId(h1, "a.csv"), ws.attachmentId(h2, "a.csv"), "hash matters");
  assert.notEqual(ws.attachmentId(h1, "a.csv"), ws.attachmentId(h1, "b.csv"), "name matters");
});

// --- the caps: the exact refusal boundary, both sides ------------------------

test("the 10th file attaches and the 11th is refused — the boundary, not near it", () => {
  freshState("cap10");
  for (let i = 1; i <= ws.MAX_ATTACHMENTS; i++) {
    ws.attach("c", `f${i}.txt`, Buffer.from(`body ${i}`));
  }
  assert.equal(ws.list("c").length, 10, "exactly ten fit");
  assert.throws(
    () => ws.attach("c", "f11.txt", Buffer.from("one too many")),
    /a conversation holds at most 10 files — remove one first/,
  );
  assert.equal(ws.list("c").length, 10, "the refusal did not half-commit");
});

test("a full conversation still accepts a RE-attach of a file it already holds", () => {
  // `existing` is checked BEFORE the cap. A mutant reordering those two makes
  // a full conversation unable to re-attach its own file.
  freshState("capidem");
  for (let i = 1; i <= ws.MAX_ATTACHMENTS; i++) ws.attach("c", `f${i}.txt`, Buffer.from(`b${i}`));
  const again = ws.attach("c", "f3.txt", Buffer.from("b3"));
  assert.equal(again.name, "f3.txt");
  assert.equal(ws.list("c").length, 10);
});

test("exactly 25 MiB attaches; one byte more is refused", () => {
  freshState("capbytes");
  const atCap = Buffer.alloc(ws.MAX_ATTACHMENT_BYTES, 0x61);
  const over = Buffer.alloc(ws.MAX_ATTACHMENT_BYTES + 1, 0x61);
  const ok = ws.attach("c", "big.txt", atCap);
  assert.equal(ok.size, ws.MAX_ATTACHMENT_BYTES, "the cap itself is allowed");
  assert.throws(() => ws.attach("c", "bigger.txt", over), /files are capped at 25 MB/);
});

test("an empty file is refused with its own message, not the size one", () => {
  freshState("empty");
  assert.throws(() => ws.attach("c", "e.txt", Buffer.alloc(0)), /this file is empty/);
});

// --- blob naming: extension handling is what the format layer sniffs ---------

test("the blob keeps a LOWERCASED extension, and a bare hash when there is none", () => {
  freshState("blob");
  const a = ws.attach("c", "REPORT.CSV", Buffer.from("x,y\n"));
  assert.ok(ws.resolve("c", a.id).path.endsWith(`${a.hash}.csv`), "extension lowercased");
  const b = ws.attach("c", "README", Buffer.from("no extension here"));
  assert.ok(ws.resolve("c", b.id).path.endsWith(b.hash), "bare hash, no trailing dot");
  assert.ok(!ws.resolve("c", b.id).path.endsWith("."), "and definitely no trailing dot");
});

test("identical bytes under different extensions get SEPARATE blobs", () => {
  // The extension rides the blob name precisely so the format layer sniffs
  // correctly; a mutant dropping it would collapse these two onto one file.
  freshState("blobext");
  const body = Buffer.from("a,b\n1,2\n");
  const asCsv = ws.attach("c", "t.csv", body);
  const asTxt = ws.attach("c", "t.txt", body);
  assert.equal(asCsv.hash, asTxt.hash, "same bytes, same hash");
  assert.notEqual(ws.resolve("c", asCsv.id).path, ws.resolve("c", asTxt.id).path);
});

// --- manifest path: sanitization must not let two ids collide ----------------

test("two different conversation ids that sanitize alike stay separate", () => {
  // "a/b" and "a:b" both sanitize to "ab". Without the hash suffix they would
  // share one manifest — one chat seeing another's attachments.
  freshState("collide");
  const one = ws.attach("a/b", "x.txt", Buffer.from("from a-slash-b"));
  ws.attach("a:b", "y.txt", Buffer.from("from a-colon-b"));
  const namesOne = ws.list("a/b").map((f) => f.name);
  const namesTwo = ws.list("a:b").map((f) => f.name);
  assert.deepEqual(namesOne, ["x.txt"]);
  assert.deepEqual(namesTwo, ["y.txt"]);
  assert.equal(ws.resolve("a:b", one.id), null, "a's attachment is invisible to b");
});

test("an id that needs no sanitizing gets NO hash suffix", () => {
  // The plain path is what keeps manifests readable; a mutant that always
  // appends the suffix would still "work", so pin the filename shape.
  const dir = freshState("plain");
  ws.attach("conv-1", "x.txt", Buffer.from("plain id"));
  const files = fs.readdirSync(path.join(dir, "workspace")).filter((f) => f.endsWith(".json"));
  assert.deepEqual(files, ["conv-1.json"]);
});

test("an all-punctuation id still lands on a stable, non-empty manifest name", () => {
  const dir = freshState("punct");
  ws.attach("///", "x.txt", Buffer.from("all punctuation"));
  const files = fs.readdirSync(path.join(dir, "workspace")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^conv-[0-9a-f]{8}\.json$/, "conv- prefix plus 8 hex");
  assert.equal(ws.list("///").length, 1, "and it round-trips");
});

test("a long conversation id truncates its manifest stem to EXACTLY 64 characters", () => {
  // Two ids differing only past character 64 both take the hash-suffix path
  // whatever the slice width, so isolation alone does not pin the number.
  // Assert the stem's length on disk.
  const dir = freshState("long");
  const longId = "z".repeat(100);
  ws.attach(longId, "a.txt", Buffer.from("alpha side"));
  const files = fs.readdirSync(path.join(dir, "workspace")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const stem = files[0].replace(/-[0-9a-f]{8}\.json$/, "");
  assert.equal(stem.length, 64, "sanitized stem is capped at 64 characters");
  assert.equal(stem, "z".repeat(64));
});

test("ids differing only past the 64-character cap stay separate", () => {
  freshState("longsep");
  const a = "z".repeat(64) + "-alpha";
  const b = "z".repeat(64) + "-beta";
  ws.attach(a, "a.txt", Buffer.from("alpha side"));
  ws.attach(b, "b.txt", Buffer.from("beta side"));
  assert.deepEqual(ws.list(a).map((f) => f.name), ["a.txt"]);
  assert.deepEqual(ws.list(b).map((f) => f.name), ["b.txt"]);
});

// --- manifest envelope -------------------------------------------------------

test("a manifest with a foreign envelope version reads as empty, not as garbage", () => {
  const dir = freshState("ver");
  ws.attach("c", "x.txt", Buffer.from("original"));
  const mf = path.join(dir, "workspace", "c.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  assert.equal(m.v, 1, "the shipped envelope version");
  fs.writeFileSync(mf, JSON.stringify({ ...m, v: 99 }));
  assert.deepEqual(ws.list("c"), [], "a future version is not read as v1");
});

test("a manifest whose files field is not an array reads as empty", () => {
  const dir = freshState("shape");
  ws.attach("c", "x.txt", Buffer.from("original"));
  fs.writeFileSync(path.join(dir, "workspace", "c.json"), JSON.stringify({ v: 1, files: "nope" }));
  assert.deepEqual(ws.list("c"), []);
});

// --- detach / resolve gaps ---------------------------------------------------

test("detaching an id the conversation never held changes nothing", () => {
  freshState("detachmiss");
  const a = ws.attach("c", "x.txt", Buffer.from("keep me"));
  ws.detach("c", "att-000000000000");
  assert.deepEqual(ws.list("c").map((f) => f.id), [a.id], "the real entry survives");
});

test("resolve answers null for an unknown id AND for a vanished blob", () => {
  freshState("gap");
  const a = ws.attach("c", "x.txt", Buffer.from("body"));
  assert.equal(ws.resolve("c", "att-deadbeef0000"), null, "unknown id");
  fs.unlinkSync(ws.resolve("c", a.id).path);
  assert.equal(ws.resolve("c", a.id), null, "manifest entry without its blob");
});

// --- retrieve narrowing ------------------------------------------------------

test("retrieve over an empty conversation returns empty, without calling the ranker", async () => {
  freshState("retr0");
  assert.deepEqual(await ws.retrieve("c", "anything", []), { references: [], contexts: [] });
});

test("an attachmentIds subset NARROWS; an empty list means the whole conversation", async () => {
  freshState("retrsub");
  const keep = ws.attach("c", "revenue.md", Buffer.from("# Revenue\nNortheast revenue rose.\n"));
  ws.attach("c", "hiring.md", Buffer.from("# Hiring\nWe opened twelve support roles.\n"));

  const narrowed = await ws.retrieve("c", "revenue", [keep.id]);
  const narrowedNames = narrowed.references.map((r) => r.name);
  assert.ok(narrowedNames.includes("revenue.md"));
  assert.ok(!narrowedNames.includes("hiring.md"), "the subset excluded the other file");

  const all = await ws.retrieve("c", "revenue hiring roles", []);
  assert.ok(all.references.length >= 1, "an empty subset searches everything");
});

test("an attachmentIds list naming nothing in this conversation retrieves nothing", () => {
  freshState("retrmiss");
  ws.attach("c", "revenue.md", Buffer.from("# Revenue\nNortheast revenue rose.\n"));
  return ws.retrieve("c", "revenue", ["att-not-here-000"]).then((r) => {
    assert.deepEqual(r, { references: [], contexts: [] });
  });
});

// --- docText / docChunks honesty --------------------------------------------

test("docText answers null for an unknown id and for a whitespace-only file", async () => {
  freshState("doctext");
  assert.equal(await ws.docText("c", "att-000000000000"), null, "unknown id");
  const blank = ws.attach("c", "blank.txt", Buffer.from("   \n\t \n"));
  assert.equal(await ws.docText("c", blank.id), null, "whitespace is not content");
});

test("previewChars truncates to EXACTLY that many characters, and 0 means no cap", async () => {
  freshState("preview");
  const a = ws.attach("c", "long.txt", Buffer.from("abcdefghij"));
  assert.equal((await ws.docText("c", a.id, 4)).text, "abcd");
  assert.equal((await ws.docText("c", a.id)).text, "abcdefghij", "absent = whole file");
  assert.equal((await ws.docText("c", a.id, 0)).text, "abcdefghij", "0 is falsy = whole file");
});

test("docChunks returns null exactly when docText does", async () => {
  freshState("chunks");
  assert.equal(await ws.docChunks("c", "att-000000000000"), null);
  const blank = ws.attach("c", "blank.txt", Buffer.from("  \n "));
  assert.equal(await ws.docChunks("c", blank.id), null);
  const real = ws.attach("c", "prose.md", Buffer.from("# Title\nSome real content here.\n"));
  const [name, chunks] = await ws.docChunks("c", real.id);
  assert.equal(name, "prose.md");
  assert.ok(chunks.length > 0);
});

// --- sweep: the age boundary and the reference set ---------------------------

test("sweep keeps a referenced blob no matter how old it is", () => {
  const dir = freshState("sweepref");
  const a = ws.attach("c", "x.txt", Buffer.from("referenced forever"));
  const blob = ws.resolve("c", a.id).path;
  const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
  fs.utimesSync(blob, ancient / 1000, ancient / 1000);
  ws.sweep();
  assert.ok(fs.existsSync(blob), "a referenced blob is never swept");
  assert.ok(fs.existsSync(path.join(dir, "workspace")));
});

test("sweep spares an unreferenced blob inside the grace window and drops it outside", () => {
  freshState("sweepage");
  const a = ws.attach("c", "x.txt", Buffer.from("soon to be orphaned"));
  const blob = ws.resolve("c", a.id).path;
  ws.detach("c", a.id);

  // Probe within an HOUR of the cutoff, not a day or two either side. A day-
  // wide probe leaves every inner factor of `30 * 24 * 60 * 60 * 1000`
  // unpinned: a mutant turning one 60 into 61 moves the window to ~30.5 days,
  // which a 29d/31d pair still straddles correctly. An hour-wide probe does
  // not survive any single-factor change.
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const window = 30 * day;

  const justInside = (Date.now() - (window - hour)) / 1000;
  fs.utimesSync(blob, justInside, justInside);
  ws.sweep();
  assert.ok(fs.existsSync(blob), "an hour short of 30 days is inside the window");

  const justOutside = (Date.now() - (window + hour)) / 1000;
  fs.utimesSync(blob, justOutside, justOutside);
  ws.sweep();
  assert.ok(!fs.existsSync(blob), "an hour past 30 days is outside it");
});

test("a blob referenced by ANOTHER conversation survives the sweep", () => {
  freshState("sweepshared");
  const body = Buffer.from("shared across two chats");
  const a = ws.attach("c1", "s.txt", body);
  ws.attach("c2", "s.txt", body);
  const blob = ws.resolve("c1", a.id).path;
  ws.detach("c1", a.id);
  const old = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(blob, old, old);
  ws.sweep();
  assert.ok(fs.existsSync(blob), "c2 still references it");
  assert.ok(ws.resolve("c2", a.id), "and c2 can still resolve it");
});

test("sweep ignores non-manifest files in the workspace directory", () => {
  const dir = freshState("sweepjunk");
  const a = ws.attach("c", "x.txt", Buffer.from("still referenced"));
  fs.writeFileSync(path.join(dir, "workspace", "notes.txt"), "not a manifest");
  ws.sweep();
  assert.ok(fs.existsSync(ws.resolve("c", a.id).path), "the junk file did not break the scan");
});
