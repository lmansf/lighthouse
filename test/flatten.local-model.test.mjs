/**
 * Regression test for the bundled-local-model fetch on macOS/Linux (issue #24).
 *
 * llama.cpp ships macOS/Linux as .tar.gz whose binary resolves its shared
 * libraries by SONAME via RUNPATH $ORIGIN — e.g. llama-server NEEDs
 * `libllama-common.so.0`, which the archive ships as a symlink to the versioned
 * `libllama-common.so.0.0.NNNN`. An earlier flatten() moved only `f.isFile()`
 * dirents and then deleted the extraction tree, silently dropping every SONAME
 * symlink, so the flattened llama-server could not start. This guards that
 * flatten() carries the symlinks (not just regular files) into resources/llm/.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, lstatSync, readlinkSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "fetch-local-model.mjs");

// Import the real flatten() from the script without triggering its
// network-calling main() at module load.
async function loadFlatten() {
  let src = readFileSync(SCRIPT, "utf8").replace(/main\(\)\.catch\([\s\S]*$/, "export { flatten };\n");
  const modPath = path.join(mkdtempSync(path.join(tmpdir(), "fetchmod-")), "mod.mjs");
  writeFileSync(modPath, src);
  return (await import(modPath)).flatten;
}

test("flatten() carries SONAME symlinks (not just files) next to the binary", { skip: process.platform === "win32" ? "POSIX symlink layout" : false }, async () => {
  const flatten = await loadFlatten();

  // Mimic a .tar.gz release extracted into resources/llm/: a nested build/bin/
  // holding the binary, a versioned lib, and the SONAME symlink the loader needs.
  const dest = mkdtempSync(path.join(tmpdir(), "resources-llm-"));
  const bin = path.join(dest, "build", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "llama-server"), "#!/bin/sh\n");
  writeFileSync(path.join(bin, "libllama-common.so.0.0.9839"), "ELF");
  symlinkSync("libllama-common.so.0.0.9839", path.join(bin, "libllama-common.so.0"));

  flatten(dest);

  const top = readdirSync(dest);
  assert.ok(top.includes("llama-server"), "binary should be flattened to top level");
  assert.ok(top.includes("libllama-common.so.0.0.9839"), "versioned lib should be flattened");
  assert.ok(top.includes("libllama-common.so.0"), "SONAME symlink must survive flatten()");

  const link = path.join(dest, "libllama-common.so.0");
  assert.ok(lstatSync(link).isSymbolicLink(), "SONAME entry must remain a symlink");
  assert.equal(readlinkSync(link), "libllama-common.so.0.0.9839", "symlink must still point at the versioned lib");

  // The nested extraction tree should be gone (everything is flat now).
  assert.ok(!top.includes("build"), "extraction subtree should be removed");
});
