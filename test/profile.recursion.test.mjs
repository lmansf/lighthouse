/**
 * Smoke test for /api/profile's getState() + the first onboarding step action.
 *
 * PR #55 once made profile.getState() resolve A/B variants via experiment
 * getVariant(), and experiment.resolve() read the user's email through the
 * (now-deleted) license module — which itself called profile.getState(). That
 * cycle
 *   getState -> getVariant -> resolve -> accountEmail -> getState -> ...
 * recursed until the stack overflowed, 500-ing every /api/profile call. Both
 * the experiments and the licensing layers have since been removed, so the
 * cycle is gone by construction; this still guards that getState() and the
 * first step action — exactly what the endpoint's GET/POST run on first
 * launch — resolve without throwing.
 *
 * Run: `npm run test:extract`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The server modules use TypeScript's extensionless relative imports
// (`./config`), which `node --test` won't resolve on its own. Register a hook
// that retries a failed `./x` as `./x.ts`; Node still does the type-stripping.
register("./_ts-extensionless-hook.mjs", pathToFileURL(import.meta.filename));

/** Fresh, isolated vault dir per test so state never bleeds across. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-recursion-"));
  process.env.VAULT_DIR = dir;
  return dir;
}

test("GET /api/profile path: getState() resolves without recursing (no stack overflow)", async () => {
  freshVault();
  const { getState } = await import("../src/server/profile.ts");

  // Before the fix this threw RangeError: Maximum call stack size exceeded.
  const state = getState();

  assert.equal(state.step, "vault", "an untouched profile starts at the vault step");
});

test("POST finishVault path: finishVault() + getState() advances the step, still no recursion", async () => {
  freshVault();
  const { getState, finishVault } = await import("../src/server/profile.ts");

  // finishVault() is the first onboarding action the endpoint runs; it must
  // resolve without throwing and move the flow forward.
  finishVault();
  const state = getState();

  assert.equal(state.step, "mode", "finishVault advances onboarding to the mode step");
});
