/**
 * Regression test for the bundled-local-model swap to Mistral-7B (issue #24).
 *
 * The desktop app loads the FIRST `.gguf` it finds in `resources/llm/`, and that
 * folder persists between builds, so after swapping the bundled weights an old
 * model (e.g. the previous SmolLM2-1.7B `.gguf`) could linger and get loaded
 * ahead of the intended one. fetch-local-model.mjs now prunes every `.gguf` that
 * isn't the model it just fetched. This guards that prune against the REAL loop
 * text taken from the script, plus the model-id derivation from DEFAULT_MODEL_URL.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "fetch-local-model.mjs");

// Build a callable from the EXACT prune loop in the shipping script, so this test
// fails if that logic regresses (rather than re-implementing it here).
async function loadPrune() {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(/for \(const f of readdirSync\(dest\)\) \{[\s\S]*?\n  \}/);
  assert.ok(m, "could not locate the stale-model prune loop in fetch-local-model.mjs");
  const body = `
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export function prune(dest, modelFile) {
  ${m[0]}
}
`;
  const modPath = path.join(mkdtempSync(path.join(tmpdir(), "prunemod-")), "mod.mjs");
  writeFileSync(modPath, body);
  return (await import(pathToFileURL(modPath).href)).prune;
}

test("prune removes a stale (old SmolLM2) .gguf but keeps the intended model and non-gguf assets", async () => {
  const prune = await loadPrune();

  const dest = mkdtempSync(path.join(tmpdir(), "resources-llm-"));
  const keep = "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf";
  writeFileSync(path.join(dest, keep), "new weights");
  writeFileSync(path.join(dest, "smollm2-1.7b-instruct-q4_k_m.gguf"), "old weights");
  writeFileSync(path.join(dest, "another-model.GGUF"), "case-insensitive stale");   // upper-case ext
  writeFileSync(path.join(dest, "llama-server.exe"), "binary");                     // must survive
  writeFileSync(path.join(dest, "libllama.so"), "lib");                             // must survive

  prune(dest, keep);

  const left = readdirSync(dest).sort();
  assert.ok(existsSync(path.join(dest, keep)), "intended model must remain");
  assert.ok(!existsSync(path.join(dest, "smollm2-1.7b-instruct-q4_k_m.gguf")), "old SmolLM2 model must be pruned");
  assert.ok(!existsSync(path.join(dest, "another-model.GGUF")), "stale .GGUF (upper-case) must be pruned");
  assert.ok(existsSync(path.join(dest, "llama-server.exe")), "llama-server binary must survive");
  assert.ok(existsSync(path.join(dest, "libllama.so")), "shared libraries must survive");
  assert.deepEqual(left, [keep, "libllama.so", "llama-server.exe"], `unexpected leftovers: ${left}`);
});

test("the default bundled model resolves to Mistral-7B-Instruct-v0.3 Q4_K_M", async () => {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(/const DEFAULT_MODEL_URL\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(m, "DEFAULT_MODEL_URL not found");
  const url = m[1];
  assert.match(url, /bartowski\/Mistral-7B-Instruct-v0\.3-GGUF/, "default must point at the Mistral repo");
  const file = path.basename(new URL(url).pathname);
  assert.equal(file, "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf", "derived bundled filename");
});
