/**
 * Named-file guarantees (0.6.0 field report: a question naming a file
 * verbatim got "the file is not present in the provided context").
 *
 *   1. retrieve() PINS the strongly-named file into the top-k even when
 *      keyword-heavy chunks from other files outscore it — KEEP IN SYNC with
 *      the Rust twin (retrieval.rs, named-file guarantee + embed_test.rs repro).
 *   2. pinnedNamedFile()'s selection rules stay conservative.
 *
 * A third case here checked `namedButExcluded`, the honesty note for a file the
 * question NAMES but the vault had EXCLUDED. Since 0.15.0 there is no inclusion
 * gate and no folder the app can see past the attachments: a file the user
 * names but never attached is simply not something the app knows exists.
 *
 * Run: `node --test test/namedFile.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

function freshState() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-named-"));
  process.env.LIGHTHOUSE_APP_STATE_DIR = path.join(home, ".rag-vault");
  mkdirSync(process.env.LIGHTHOUSE_APP_STATE_DIR, { recursive: true });
  return home;
}

test("retrieve pins the literally-named file into the top-k under keyword crowding", async () => {
  freshState();
  const { attach, retrieve } = await import("../src/server/workspace.ts");
  const CONV = "conv-named";

  // The wanted file: named like the question, content shares no query words.
  attach(CONV, "1 Galaxy Servers.md", Buffer.from("srv-001 10.0.0.1 rack-a\nsrv-002 10.0.0.2 rack-b"));
  // Six distractors whose CONTENT is practically the query, repeated — their
  // chunks outscore anything the named file offers. Seven files fits inside the
  // ten-attachment cap with room to spare.
  const crowd = "galaxy servers rollout deployment cluster summary inside ";
  for (let i = 0; i < 6; i += 1) {
    attach(CONV, `meeting-notes-${i}.md`, Buffer.from(crowd.repeat(12)));
  }

  const r = await retrieve(CONV, "galaxy servers rollout deployment cluster summary inside", [], 5);
  assert.ok(
    r.references.some((ref) => ref.name === "1 Galaxy Servers.md"),
    `named file must be retrieved; got ${r.references.map((ref) => ref.name).join(", ")}`,
  );
});

// Direct tests of the pin's selection rules (0.6.2 field report: a lone
// generic token pinned irrelevant files — "recommending the wrong ones").
// MIRRORS retrieval.rs::named_pin_tests; token lists are pre-tokenized.
test("pinnedNamedFile is conservative about what counts as naming a file", async () => {
  const { pinnedNamedFile } = await import("../src/server/retrieval.ts");
  const q = (s) => s.toLowerCase().split(/\s+/);

  // A verbatim name pins.
  assert.equal(
    pinnedNamedFile(q("what is inside 1 galaxy servers"), [
      { id: "1 Galaxy Servers.md", toks: ["1", "galaxy", "servers", "md"] },
      { id: "meeting-notes-1.md", toks: ["meeting", "notes", "1", "md"] },
    ]),
    "1 Galaxy Servers.md",
  );
  // A lone generic token ("plan", 4 chars) never pins.
  assert.equal(
    pinnedNamedFile(q("what is the plan for the rollout"), [
      { id: "plan.md", toks: ["plan", "md"] },
      { id: "roadmap.md", toks: ["roadmap", "md"] },
    ]),
    null,
  );
  // A distinctive single-token name (≥5 chars) still pins.
  assert.equal(
    pinnedNamedFile(q("can you summarize my resume"), [
      { id: "resume.pdf", toks: ["resume", "pdf"] },
      { id: "recipes.md", toks: ["recipes", "md"] },
    ]),
    "resume.pdf",
  );
  // Generic siblings tie → ambiguous → nothing pins.
  assert.equal(
    pinnedNamedFile(q("what did the meeting notes say"), [
      { id: "meeting-notes-1.md", toks: ["meeting", "notes", "1", "md"] },
      { id: "meeting-notes-2.md", toks: ["meeting", "notes", "2", "md"] },
    ]),
    null,
  );
  // Fuller name coverage beats partial.
  assert.equal(
    pinnedNamedFile(q("what is inside 1 galaxy servers"), [
      { id: "galaxy servers rollout plan.md", toks: ["galaxy", "servers", "rollout", "plan", "md"] },
      { id: "1 Galaxy Servers.md", toks: ["1", "galaxy", "servers", "md"] },
    ]),
    "1 Galaxy Servers.md",
  );
});
