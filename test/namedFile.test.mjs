/**
 * Named-file guarantees (0.6.0 field report: a question naming a file
 * verbatim got "the file is not present in the provided context").
 *
 *   1. retrieve() PINS the strongly-named file into the top-k even when
 *      keyword-heavy chunks from other files outscore it — KEEP IN SYNC with
 *      the Rust twin (vault.rs, named-file guarantee + embed_test.rs repro).
 *   2. namedButExcluded() flags a named-but-not-included file so the answer
 *      pipeline can say so instead of letting the model deny it exists.
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

function freshVault() {
  const home = mkdtempSync(path.join(tmpdir(), "lh-named-"));
  const vault = path.join(home, "vault");
  mkdirSync(path.join(vault, ".rag-vault"), { recursive: true });
  process.env.VAULT_DIR = vault;
  delete process.env.LICENSE_API_URL;
  // With no explicit default-inclusion choice on the profile, files start
  // EXCLUDED (the app's conservative default) — deterministic inclusion, the
  // exact state of the field report.
  return vault;
}

test("retrieve pins the literally-named file into the top-k under keyword crowding", async () => {
  const vault = freshVault();
  const { retrieve, listNodes, setIncluded } = await import("../src/server/vault.ts");

  // The wanted file: named like the question, content shares no query words.
  writeFileSync(
    path.join(vault, "1 Galaxy Servers.md"),
    "srv-001 10.0.0.1 rack-a\nsrv-002 10.0.0.2 rack-b",
  );
  // Six distractors whose CONTENT is practically the query, repeated — their
  // chunks outscore anything the named file offers.
  const crowd = "galaxy servers rollout deployment cluster summary inside ";
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(path.join(vault, `meeting-notes-${i}.md`), crowd.repeat(12));
  }
  const ids = listNodes()
    .filter((n) => n.kind === "file")
    .map((n) => n.id);
  assert.equal(ids.length, 7);
  for (const id of ids) setIncluded(id, true);

  const r = await retrieve("galaxy servers rollout deployment cluster summary inside", ids, 5);
  assert.ok(
    r.references.some((ref) => ref.name === "1 Galaxy Servers.md"),
    `named file must be retrieved; got ${r.references.map((ref) => ref.name).join(", ")}`,
  );
});

// Direct tests of the pin's selection rules (0.6.2 field report: a lone
// generic token pinned irrelevant files — "recommending the wrong ones").
// MIRRORS vault.rs::named_pin_tests; token lists are pre-tokenized.
test("pinnedNamedFile is conservative about what counts as naming a file", async () => {
  const { pinnedNamedFile } = await import("../src/server/vault.ts");
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

test("namedButExcluded flags a named file that isn't included, and only then", async () => {
  const vault = freshVault();
  const { namedButExcluded, listNodes, setIncluded } = await import("../src/server/vault.ts");

  writeFileSync(path.join(vault, "1 Galaxy Servers.xlsx"), "placeholder");
  writeFileSync(path.join(vault, "recipes.md"), "chocolate cake");

  // opt_in arm ⇒ files start excluded: the note source must flag it.
  assert.deepEqual(
    namedButExcluded("how many entries are in 1 Galaxy Servers.xlsx?"),
    ["1 Galaxy Servers.xlsx"],
  );
  // Unrelated question: silent.
  assert.deepEqual(namedButExcluded("what does the onboarding doc say?"), []);

  // Included ⇒ silent.
  const id = listNodes().find((n) => n.name === "1 Galaxy Servers.xlsx").id;
  setIncluded(id, true);
  assert.deepEqual(namedButExcluded("how many entries are in 1 Galaxy Servers.xlsx?"), []);
});
