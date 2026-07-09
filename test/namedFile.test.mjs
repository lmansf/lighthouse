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
  // Pin the default-inclusion experiment to opt_in (files start EXCLUDED) so
  // inclusion behavior is deterministic — the exact state of the field report.
  writeFileSync(
    path.join(vault, ".rag-vault", "experiments.json"),
    JSON.stringify({ onboarding: "key_first", default_inclusion: "opt_in", source: "override" }),
  );
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
