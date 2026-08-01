// §56 #2 — update_now must not let the release manifest pick a path.
//
// The behaviour is tested for real in the engine
// (native/crates/lighthouse-core/tests/update_staging_test.rs): an absolute or
// `..` asset name is refused before anything is created. What CANNOT run here
// is the caller — lighthouse-desktop needs webkit/gtk and only compiles in CI —
// so pin the call site as a source fact, the same way
// updaterPreservesData.test.mjs pins the staging directory.
//
// The property: the manifest's asset name reaches disk BEFORE the minisign
// gate, so inside update_now it must pass through the guarded derivation and
// never be joined onto a path directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISE = "native/crates/lighthouse-desktop/src/desktop/supervise.rs";

/** update_now's body, as text — it runs to the macOS in-place-swap helper. */
function updateNow() {
  const s = readFileSync(path.join(ROOT, SUPERVISE), "utf8");
  const from = s.indexOf("pub async fn update_now(");
  const to = s.indexOf("fn install_macos_app_archive");
  assert.ok(from >= 0 && to > from, "update_now must exist, ahead of the swap helper");
  return s.slice(from, to);
}

test("the staging path is derived by the guarded helper, never from the manifest string", () => {
  const fn = updateNow();
  assert.match(
    fn,
    /staging_path\(&dir, &name\)/,
    "update_now must derive the staging path via lighthouse_core::updates::staging_path, " +
      "which admits only a single plain filename",
  );
  assert.ok(
    !/\.join\(&?name\)/.test(fn),
    "the manifest's asset name must never be joined onto a path directly — an absolute " +
      "or `..` name is an arbitrary-file write, and it happens BEFORE the signature check",
  );
});

test("an unusable asset name fails CLOSED, to the same notify-only page as every other failure", () => {
  const fn = updateNow();
  assert.match(fn, /unsafe asset name/, "the refusal must have its own explicit arm");
  // The refusal must degrade, not proceed: no download, just the releases page.
  const arm = fn.slice(fn.indexOf("staging_path(&dir, &name)"), fn.indexOf("let download ="));
  assert.match(arm, /open_with_os\(std::path::Path::new\(RELEASE_PAGE_URL\)\)/, "must open the releases page");
  assert.match(arm, /"ok": false/, "must report failure to the UI so the notice stands down");
});
