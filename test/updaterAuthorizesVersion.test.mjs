// Red-team 2026-08 — "forced downgrade". The engine gate is unit-tested
// (native/crates/lighthouse-core/tests/updater_downgrade_test.rs); what cannot
// be tested here is that the SHELL still calls it — supervise.rs only compiles
// with webkit/gtk. So pin the wiring as a source fact: `update_now` must
// authorize against the signed manifest, against the RUNNING build's version,
// BEFORE it hands the artifact to the OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISE = readFileSync(
  path.join(ROOT, "native/crates/lighthouse-desktop/src/desktop/supervise.rs"),
  "utf8",
);

/** The body of `update_now`, up to the next top-level fn. */
function updateNow() {
  const at = SUPERVISE.indexOf("pub async fn update_now(");
  assert.ok(at >= 0, "update_now must exist");
  const rest = SUPERVISE.slice(at);
  const end = rest.indexOf("\n/// Replace the running `.app` bundle");
  return end > 0 ? rest.slice(0, end) : rest;
}

test("update_now authorizes against the signed manifest before it installs", () => {
  const fn = updateNow();
  const authorize = fn.indexOf("authorize_update(");
  assert.ok(authorize > 0, "update_now must call authorize_update — a signature binds bytes, not a version");
  // The version compared is the RUNNING build, not the release tag.
  assert.match(
    fn.slice(authorize, authorize + 400),
    /env!\("CARGO_PKG_VERSION"\)/,
    "the install-time comparison must use the running build's version",
  );
  // Authorization precedes every hand-off to the OS/installer.
  const handoff = fn.indexOf("open_with_os(&dest)");
  assert.ok(handoff > authorize, "nothing may execute the artifact before authorization");
  const macSwap = fn.indexOf("install_macos_app_archive(&dest)");
  assert.ok(macSwap === -1 || macSwap > authorize, "the macOS in-place swap must also come after authorization");
});

test("update_now raises the monotonic floor so a superseded release can't be re-offered", () => {
  assert.match(updateNow(), /record_update_floor\(&dir,/, "update_now must persist the install floor");
});
