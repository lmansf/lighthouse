/**
 * Smoke test for /api/profile's getState() / signIn().
 *
 * PR #55 once made profile.getState() resolve A/B variants via experiment
 * getVariant(), and experiment.resolve() read the user's email through
 * license.accountEmail() — which itself calls profile.getState(). That cycle
 *   getState -> getVariant -> resolve -> accountEmail -> getState -> ...
 * recursed until the stack overflowed, 500-ing every /api/profile call. The
 * experiments layer (and that variant resolution) has since been removed, so the
 * cycle is gone by construction; this still guards that getState()/signIn() —
 * exactly what the endpoint's GET/POST run — resolve without throwing.
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

  assert.equal(state.step, "sign-in", "an untouched profile starts at the sign-in step");
});

test("POST signIn path: signIn() + getState() returns the signed-in user, still no recursion", async () => {
  freshVault();
  const { getState, signIn } = await import("../src/server/profile.ts");

  // The cycle ran through accountEmail() reading the profile email, so a
  // signed-in user (email present) is exactly the state that used to recurse.
  signIn("alice@example.com");
  const state = getState();

  assert.equal(state.user?.email, "alice@example.com", "the signed-in email round-trips");
  assert.equal(state.step, "register", "signIn advances onboarding to the register step");
});

test("accountEmail() still reads the signed-in profile email (its own path is unchanged)", async () => {
  freshVault();
  const { signIn } = await import("../src/server/profile.ts");
  const { accountEmail } = await import("../src/server/license.ts");

  signIn("user1@example.com");
  assert.equal(accountEmail(), "user1@example.com", "accountEmail reads the profile email");
});
