/**
 * E2E test for LINK-FIRST adds and the chat-drop resolution fix in the real
 * vault module (src/server/vault.ts) - the server side of the desktop
 * "add by reference, don't copy bytes" flow.
 *
 * Drives the SAME functions the /api/rag reference route and the store's
 * linkPaths()/attachOsFiles() call, against a REAL temp filesystem:
 *
 *   1. link a folder IN PLACE          - registered as ext0, zero bytes copied.
 *   2. the walk sees it IMMEDIATELY    - saveState invalidates the 3s walk cache,
 *                                        so an in-app add never reads as stale
 *                                        (the freeze-fix keeps mutations hot).
 *   3. chat-drop a file already inside  - re-linking a path already covered by an
 *      the linked folder                existing folder link RESOLVES to that
 *                                        file's existing node id (extN/rel) and
 *                                        does NOT throw "overlaps"; so the drop
 *                                        ATTACHES the file instead of silently
 *                                        vanishing (the head-commit fix).
 *   4. re-linking the same folder path  - idempotent, returns the same ext id.
 *   5. a genuinely overlapping path     - an ancestor that CONTAINS the link is
 *                                        rejected (can't index the same tree twice).
 *   6. a path inside the vault          - rejected (already first-class vault items).
 *   7. walk cache stays hot on upload   - addFile() invalidates too, so a copied-in
 *                                        file appears on the next listing at once.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// vault.ts uses TypeScript's extensionless relative imports (`./config`);
// register the shared resolve hook so Node can find `config.ts` et al.
register("./_ts-extensionless-hook.mjs", import.meta.url);

const log = (...a) => console.log("[vault-link]", ...a);

test("link-first adds: covered chat-drop resolves to its node, overlaps rejected, walk stays hot", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "lh-link-"));
  const vault = path.join(home, "vault");
  mkdirSync(vault, { recursive: true });
  process.env.VAULT_DIR = vault;
  // Keep telemetry/experiment code fully offline + deterministic for the test.
  delete process.env.LICENSE_API_URL;

  // A real external tree the user will link in place (NOT copied into the vault).
  const extFolder = path.join(home, "Desktop", "project");
  mkdirSync(path.join(extFolder, "sub"), { recursive: true });
  writeFileSync(path.join(extFolder, "report.txt"), "quarterly report body");
  writeFileSync(path.join(extFolder, "sub", "notes.md"), "# nested notes");
  const looseFile = path.join(home, "Desktop", "loose.txt");
  writeFileSync(looseFile, "a standalone file");

  const {
    addReference,
    listNodes,
    addFile,
    removeReference,
  } = await import("../src/server/vault.ts");

  // 1. Link the folder in place. No bytes are copied into the vault.
  const folderRef = addReference(extFolder);
  assert.equal(folderRef.kind, "folder");
  assert.match(folderRef.id, /^ext\d+$/, "a folder link is registered under an extN id");
  const vaultEntries = readdirSync(vault).filter((n) => !n.startsWith("."));
  assert.deepEqual(vaultEntries, [], "linking copies NOTHING into the vault");
  log(`1. linked folder in place -> ${folderRef.id} (${folderRef.kind}); vault dir still empty (no copy)`);

  // 2. The freshly linked tree is visible on the very next listing (the 3s walk
  //    cache was invalidated by the reference write - an in-app add is never stale).
  const all = listNodes();
  const reportNode = all.find((n) => n.name === "report.txt");
  const notesNode = all.find((n) => n.name === "notes.md");
  assert.ok(reportNode, "the linked folder's file is walked immediately after linking");
  assert.equal(reportNode.external, true, "it is marked as an external (in-place) reference");
  assert.equal(reportNode.id, `${folderRef.id}/report.txt`, "its node id is extN/<relpath>");
  assert.ok(notesNode && notesNode.id === `${folderRef.id}/sub/notes.md`, "nested files are walked too");
  log(`2. walk sees linked tree at once: ${reportNode.id}, ${notesNode.id} (cache invalidated on link)`);

  // 3. THE FIX: the user drags report.txt onto chat. Its real path is already
  //    covered by the folder link. Before the fix this threw "overlaps an
  //    existing reference" and the drop vanished with no attachment. Now it
  //    RESOLVES to the file's existing node id so the chat can attach it.
  const dropCovered = addReference(path.join(extFolder, "report.txt"));
  assert.equal(dropCovered.kind, "file", "a covered drop resolves as a file");
  assert.equal(dropCovered.id, reportNode.id, "it resolves to the SAME node the walk produced (attachable)");
  const dropNested = addReference(path.join(extFolder, "sub", "notes.md"));
  assert.equal(dropNested.id, notesNode.id, "a nested covered drop resolves to its existing node too");
  log(`3. chat-drop of a covered file -> resolves to ${dropCovered.id} (attaches, no longer vanishes)`);

  // 4. Re-linking the exact folder path is idempotent (same reference id).
  const again = addReference(extFolder);
  assert.equal(again.id, folderRef.id, "re-linking the same path returns the existing reference");
  log(`4. re-link same folder path -> ${again.id} (idempotent)`);

  // 5. A path that genuinely overlaps (an ANCESTOR that contains the linked
  //    folder) is rejected - it would re-index the same subtree twice.
  assert.throws(
    () => addReference(path.join(home, "Desktop")),
    /overlap/i,
    "linking an ancestor of an existing link is rejected",
  );
  log("5. linking an ancestor that contains the link -> rejected (overlaps an existing reference)");

  // 6. A path inside the vault is rejected - those are already vault items.
  const insideVault = path.join(vault, "already.txt");
  writeFileSync(insideVault, "in the vault");
  assert.throws(
    () => addReference(insideVault),
    /vault/i,
    "linking a path inside the vault is rejected",
  );
  log("6. linking a path inside the vault -> rejected (overlaps the vault)");

  // 7. A standalone file links as its own reference, and a copied-in vault file
  //    shows up on the next listing at once (addFile invalidates the walk cache
  //    too - the whole point of the freeze fix: in-app changes stay hot).
  const looseRef = addReference(looseFile);
  assert.equal(looseRef.kind, "file");
  assert.notEqual(looseRef.id, folderRef.id, "a separate file gets its own ext id");
  addFile("dropped-in.txt", Buffer.from("copied into the vault"));
  const afterCopy = listNodes();
  assert.ok(
    afterCopy.some((n) => n.name === "dropped-in.txt" && !n.external),
    "a file copied into the vault appears immediately (walk cache invalidated on upload)",
  );
  assert.ok(
    afterCopy.some((n) => n.name === "loose.txt" && n.external),
    "the standalone linked file is listed as external",
  );
  log(`7. linked loose file -> ${looseRef.id}; copied-in vault file visible at once (walk stays hot)`);

  // Cleanup of app state: unlink references (leaves the real external files).
  removeReference(folderRef.id);
  removeReference(looseRef.id);
  rmSync(home, { recursive: true, force: true });
  log("done: real external files were never copied or moved by linking");
});
