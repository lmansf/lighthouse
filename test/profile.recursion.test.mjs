/**
 * Regression test for the /api/profile 500 (infinite recursion).
 *
 * PR #55 made profile.getState() resolve the A/B variants via experiment
 * getVariant(), and experiment.resolve() read the user's email through
 * license.accountEmail() - which itself calls profile.getState(). That cycle
 *   getState -> getVariant -> resolve -> accountEmail -> getState -> ...
 * recursed until the stack overflowed, so EVERY GET/POST to /api/profile
 * returned 500 ("RangeError: Maximum call stack size exceeded") and sign-in /
 * onboarding were completely broken (shipped in 0.1.4).
 *
 * The route's GET returns `getState()` and POST runs an op then returns
 * `getState()`, so exercising profile.getState()/signIn() reproduces exactly
 * what the endpoint does. This guards that the cycle stays broken and that the
 * variants still resolve (the reason getState touches experiments at all).
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

/** Fresh, isolated vault dir per test so resolved variants never bleed across. */
function freshVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-recursion-"));
  process.env.VAULT_DIR = dir;
  return dir;
}

const ONBOARDING = ["play_first", "key_first"];
const INCLUSION = ["opt_in", "opt_out"];

test("GET /api/profile path: getState() resolves without recursing (no stack overflow)", async () => {
  freshVault();
  const { getState } = await import("../src/server/profile.ts");

  // Before the fix this threw RangeError: Maximum call stack size exceeded.
  const state = getState();

  assert.equal(state.step, "sign-in", "an untouched profile starts at the sign-in step");
  assert.ok(ONBOARDING.includes(state.onboardingVariant), "onboarding variant is resolved");
  assert.ok(INCLUSION.includes(state.defaultInclusionVariant), "default_inclusion variant is resolved");
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
  assert.ok(ONBOARDING.includes(state.onboardingVariant));
  assert.ok(INCLUSION.includes(state.defaultInclusionVariant));
});

test("pilot override: a FIRST_USERS email resolves to its pinned factorial cell via the file (not getState)", async () => {
  freshVault();
  const { getState, signIn } = await import("../src/server/profile.ts");
  const { accountEmail } = await import("../src/server/license.ts");

  // user1@example.com is pinned to { onboarding: play_first, default_inclusion: opt_in }.
  signIn("user1@example.com");
  const state = getState();

  assert.equal(state.onboardingVariant, "play_first", "pilot override pins onboarding");
  assert.equal(state.defaultInclusionVariant, "opt_in", "pilot override pins default_inclusion");

  // accountEmail() (the telemetry path) is unchanged and still reads via getState().
  assert.equal(accountEmail(), "user1@example.com", "accountEmail still works after the fix");
});
