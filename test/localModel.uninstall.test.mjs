/**
 * E2E test for the local-model "install clarity" + uninstall lifecycle
 * (src/server/localModel.ts) - the state source the model picker renders from
 * via GET/DELETE /api/model.
 *
 * The bug this guards: older Lighthouse builds bundled the `.gguf` in
 * resources/llm. After an update that leftover is STILL found (and run) by
 * electron/main.js findModel(), which searches BOTH the download dir and
 * resources/llm - but the picker's status check only looked at the download dir,
 * so it showed a dead "＋ install" that appeared to do nothing. installedModel()
 * now searches the SAME dirs, so the picker's "installed" state matches what
 * llama-server actually runs.
 *
 * Lifecycle exercised (exactly what the user sees in the picker):
 *   1. leftover in resources/llm, empty download dir -> "ready" ("Installed",
 *      NOT a dead "＋"). This is the core fix.
 *   2. requestUninstall() -> "uninstalling" ("Removing…" + spinner) and drops the
 *      `.uninstall` marker electron/main.js acts on (only main owns the running
 *      llama-server that mmap-locks the weights).
 *   3. status stays "uninstalling" while the marker is present, even though the
 *      weights are still on disk (they are deleted by main after it stops the
 *      server) - so the picker never flickers back to "Installed" mid-removal.
 *   4. main finishes (weights gone, marker cleared) -> "absent" ("＋" returns,
 *      so a fresh install can be tested from a clean state).
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  mkdtempSync, mkdirSync, existsSync, rmSync, openSync, writeSync, ftruncateSync, closeSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// localModel.ts imports `./config` extensionless; reuse the shared resolve hook.
register("./_ts-extensionless-hook.mjs", import.meta.url);

const UNINSTALL_MARKER = ".uninstall";
const LEFTOVER = "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf";

function log(...a) {
  console.log("[uninstall]", ...a);
}

/** Create a `.gguf` of `size` bytes fast (sparse), to clear the >100MB guard.
 *  Starts with the "GGUF" magic so it passes the module's real-model check. */
function makeModel(dir, name, size) {
  const p = path.join(dir, name);
  const fd = openSync(p, "w");
  writeSync(fd, Buffer.from("GGUF")); // valid GGUF magic (detection requires it)
  ftruncateSync(fd, size);
  closeSync(fd);
  return p;
}

test("local model: leftover in resources/llm reads Installed, then uninstalls cleanly", async () => {
  // The download dir (LIGHTHOUSE_MODELS_DIR) is empty - the ONLY place the old
  // picker looked. The leftover model lives in <resources>/llm, where an older
  // Lighthouse bundled it and where main.js findModel() still runs it from.
  const downloadDir = mkdtempSync(path.join(tmpdir(), "lh-dl-"));
  const resourcesDir = mkdtempSync(path.join(tmpdir(), "lh-res-"));
  const llmDir = path.join(resourcesDir, "llm");
  mkdirSync(llmDir, { recursive: true });
  const leftover = makeModel(llmDir, LEFTOVER, 100 * 1024 * 1024 + 1024); // just over MIN_BYTES

  process.env.LIGHTHOUSE_MODELS_DIR = downloadDir;
  process.env.LIGHTHOUSE_RESOURCES_PATH = resourcesDir;

  const { modelStatus, requestUninstall } = await import("../src/server/localModel.ts");

  // 1. The core fix: a leftover in resources/llm reads as "ready" even though the
  //    download dir is empty. Before this change the picker showed a dead "＋".
  assert.equal(
    modelStatus().status,
    "ready",
    "a leftover model in resources/llm must read as installed (matches what main.js runs)",
  );
  assert.equal(existsSync(path.join(downloadDir, LEFTOVER)), false, "download dir is genuinely empty");
  log("1. leftover in resources/llm, empty download dir -> status =", modelStatus().status, "(picker shows 'Installed')");

  // 2. Uninstall: only main owns the mmap-locking llama-server, so the server
  //    side just drops a marker for main to act on and reports "uninstalling".
  const res = requestUninstall();
  assert.equal(res.status, "uninstalling", "requestUninstall reports the removing state immediately");
  assert.equal(
    existsSync(path.join(downloadDir, UNINSTALL_MARKER)),
    true,
    "a .uninstall marker is dropped for electron/main.js to act on",
  );
  assert.equal(modelStatus().status, "uninstalling", "status reflects the pending uninstall");
  log("2. requestUninstall() -> status =", modelStatus().status, "(picker shows 'Removing…'); marker dropped for main.js");

  // 3. While the marker is present the status stays "uninstalling" even though the
  //    weights are still on disk (main deletes them only after stopping the
  //    server) - the picker must not flicker back to "Installed" mid-removal.
  assert.equal(existsSync(leftover), true, "weights are still present until main.js deletes them");
  assert.equal(modelStatus().status, "uninstalling", "marker present -> stays 'uninstalling', never 'ready'");
  log("3. weights still on disk but marker present -> status stays", modelStatus().status, "(no flicker to 'Installed')");

  // 4. main.js finishes: it deletes the weights and clears the marker. The
  //    picker returns to "absent" ("＋"), so a fresh install can be re-tested.
  rmSync(leftover, { force: true });
  rmSync(path.join(downloadDir, UNINSTALL_MARKER), { force: true });
  assert.equal(modelStatus().status, "absent", "once weights are gone and the marker cleared, status is absent");
  const ggufs = readdirSync(llmDir).filter((n) => n.toLowerCase().endsWith(".gguf"));
  assert.deepEqual(ggufs, [], "no model weights remain after uninstall");
  log("4. main.js deletes weights + clears marker -> status =", modelStatus().status, "(picker shows '＋'; fresh install re-testable)");

  // 5. Uninstalling when nothing is installed is a no-op (no stray marker).
  const none = requestUninstall();
  assert.equal(none.status, "absent", "uninstall with nothing installed reports absent");
  assert.equal(existsSync(path.join(downloadDir, UNINSTALL_MARKER)), false, "no marker dropped when nothing to remove");
  log("5. requestUninstall() with nothing installed -> status =", none.status, "(no-op, no stray marker)");

  rmSync(downloadDir, { recursive: true, force: true });
  rmSync(resourcesDir, { recursive: true, force: true });
});
