/**
 * Provider sign-in (0.12.1 §3) — the registration-gated, fail-closed device
 * flow. The engine-level E2E (mocked vendor endpoints, sealed tokens, the
 * bearer-swapped ask) lives in native tests/provider_auth_test.rs; this suite
 * pins the CLIENT half in the house style (privacyLegibility/boardsUi): the
 * scripted mock service is exercised for real (it drives the dialog offline),
 * the JSX surface is asserted structurally against the source (it can't load
 * in node), the TS twin's settings mirror round-trips for real, and a
 * repo-wide grep proves the policy invariants — no vendor endpoint, no
 * foreign client id, anywhere in shipped code.
 *
 * Run: `node --test test/providerSignin.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const menu = read("src/features/settings/SettingsMenu.tsx");
const routeTwin = read("app/api/rag/route.ts");
const llmTwin = read("src/server/llm.ts");
const llmRust = read("native/crates/lighthouse-core/src/llm.rs");
const providerAuthRust = read("native/crates/lighthouse-core/src/provider_auth.rs");
const realService = read("src/contracts/real/rag.real.ts");
const types = read("src/contracts/types.ts");
const services = read("src/contracts/services.ts");

// --- A. Fail-closed invisibility: no sign-in affordance until configured ---

test("the sign-in control is gated on engine-reported availability (stock builds render nothing)", () => {
  assert.match(
    menu,
    /providerId === "openai" &&\s*\n\s*desktop &&\s*\n\s*signin !== null &&\s*\n\s*\(signin\.available \|\| signin\.method === "signin"\)/,
    "the control's gate requires desktop AND the engine's availability (or the one signed-in-choice recovery case)",
  );
  assert.match(
    menu,
    /\{signinControl && \(/,
    "the segmented auth-method choice renders only under the gate",
  );
  assert.match(
    menu,
    /\{signinPane && \(/,
    "the sign-in pane renders only when the gate holds AND the method is signin",
  );
  // Unknown status fails closed too: a status fetch failure clears to null.
  assert.match(
    menu,
    /setSignin\(null\); \/\/ unknown ⇒ render nothing \(fail closed\)/,
    "a failed status read renders nothing rather than guessing",
  );
});

test("the key path's UI is untouched under method \"key\" and only steps aside for the pane", () => {
  assert.match(menu, /\{!signinPane && \(/, "the API-key field is gated on !signinPane only");
  assert.match(menu, /placeholder=\{\s*providerHasSavedKey/s, "the existing key field survives");
  // §31 §3: the method chooser is the segmented control now; the two labels
  // stay byte-identical as its options.
  assert.match(menu, /\{ value: "key", label: "Use API key" \},/);
  assert.match(menu, /\{ value: "signin", label: "Sign in" \},/);
  assert.match(menu, /<LhSegmented/, "the chooser is the §3 segmented primitive");
});

test("the user code renders LARGE with tabular numerals, and the browser opens via the feedback flow's idiom", () => {
  assert.match(menu, /signinCode: \{[^}]*fontFamily: tokens\.fontFamilyMonospace/s);
  assert.match(menu, /fontVariantNumeric: "tabular-nums"/);
  assert.match(menu, /fontSize: tokens\.fontSizeHero800/, "the code is display-sized");
  assert.match(
    menu,
    /window\.open\(url, "_blank", "noopener,noreferrer"\)/,
    "openExternal mirrors BugReport.tsx's hand-off exactly",
  );
  assert.match(menu, /openExternal\(signinFlow\.verificationUri\)/);
});

// --- B. The scripted mock drives the whole dialog flow (real calls) --------

test("mock: start → code shown → pending twice → complete → signed in → sign out", async () => {
  const { ragService } = await import("../src/contracts/mocks/rag.mock.ts");

  let status = await ragService.providerAuthStatus();
  assert.equal(status.available, true, "the mock simulates a configured build");
  assert.equal(status.signedIn, false);
  assert.equal(status.method, "key", "the default method is the key path");

  const set = await ragService.providerAuthSetMethod("signin");
  assert.equal(set.ok, true);
  status = await ragService.providerAuthStatus();
  assert.equal(status.method, "signin");

  const { start, error } = await ragService.providerAuthStart();
  assert.equal(error, undefined);
  assert.equal(start.userCode, "MOCK-0421");
  assert.match(start.verificationUri, /^https:\/\//);
  assert.ok(start.intervalMs > 0);

  assert.equal((await ragService.providerAuthPoll()).status, "pending");
  assert.equal((await ragService.providerAuthPoll()).status, "pending");
  const done = await ragService.providerAuthPoll();
  assert.equal(done.status, "complete");
  assert.equal(done.accountHint, "mock@example.com");

  status = await ragService.providerAuthStatus();
  assert.equal(status.signedIn, true, "status flips after completion");
  assert.equal(status.accountHint, "mock@example.com");
  assert.ok(status.expiresMs > Date.now());

  await ragService.providerAuthSignout();
  status = await ragService.providerAuthStatus();
  assert.equal(status.signedIn, false, "signout clears the session");
  assert.equal(status.accountHint, undefined);
  assert.equal((await ragService.providerAuthPoll()).status, "idle");
});

// --- C. The TS twin: fail-closed stub + settings mirror --------------------

test("the twin route answers every providerAuth action with the fail-closed stub", () => {
  assert.match(routeTwin, /case "providerAuth": \{/);
  const arm = routeTwin.slice(
    routeTwin.indexOf('case "providerAuth"'),
    routeTwin.indexOf('case "policy"'),
  );
  assert.match(arm, /available: false/, "unavailable, always");
  assert.match(arm, /sign-in runs in the desktop app/, "with the honest reason");
  assert.match(arm, /signedIn: false/, "status is honest-empty");
  assert.match(
    arm,
    /body\.action === "setMethod" && body\.method === "key"/,
    'only setMethod "key" (restoring the default) writes anything',
  );
  assert.doesNotMatch(arm, /fetch\(|https?:\/\//, "the twin dials no auth host");
});

test("the twin settings mirror round-trips openaiAuthMethod for real", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lh-signin-settings-"));
  process.env.LIGHTHOUSE_SETTINGS_FILE = path.join(dir, "settings.json");
  try {
    const { readDesktopSettings, writeDesktopSettings } = await import(
      "../src/server/settings.ts"
    );
    assert.equal(readDesktopSettings().openaiAuthMethod, undefined, "default: unset ⇒ key");
    writeDesktopSettings({ openaiAuthMethod: "signin" });
    assert.equal(readDesktopSettings().openaiAuthMethod, "signin");
    writeDesktopSettings({ openaiAuthMethod: "key" });
    assert.equal(readDesktopSettings().openaiAuthMethod, "key");
  } finally {
    delete process.env.LIGHTHOUSE_SETTINGS_FILE;
  }
});

// --- D. The engines' key path is untouched ---------------------------------

test("the TS twin's answer engine has no sign-in path at all (PARITY: desktop-only)", () => {
  assert.doesNotMatch(llmTwin, /signin|providerAuth|openai_auth|openaiAuthMethod/i);
});

test("the Rust ask path enters sign-in ONLY on the persisted choice, and never falls back to the key", () => {
  assert.match(
    llmRust,
    /cfg\.provider_id\.as_deref\(\) == Some\("openai"\)\s*\n\s*&& crate::settings::read_desktop_settings\(\)\.openai_auth_method\.as_deref\(\)\s*\n\s*== Some\("signin"\)/,
    "the branch requires the explicit signin method (default key never enters)",
  );
  assert.match(llmRust, /NEVER falls back to the API-key path/);
  assert.match(
    llmRust,
    /stream_chat_completions\(/,
    "one shared chat-completions streamer backs both the keyed and signed-in asks",
  );
  assert.match(
    llmRust,
    /PURPOSE_SIGNED_IN_ASK/,
    "signed-in asks file under their own egress purpose",
  );
});

// --- E. Policy invariants: nothing vendor-specific ships -------------------

/** Every shipped source file (src/, app/, native crates src+tests, docs). */
function shippedSources() {
  const out = [];
  const skip = new Set(["node_modules", "target", ".next", ".git", "dist", "build"]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|rs|mjs|md)$/.test(name)) out.push(p);
    }
  };
  for (const top of ["src", "app", "native/crates", "docs", "test"]) {
    walk(path.join(ROOT, top));
  }
  return out;
}

test("no vendor auth endpoint or foreign client id appears anywhere in shipped code", () => {
  // The flow must be GENERIC: every identifier is maintainer-supplied after
  // vendor registration. No vendor sign-in host, no other application's
  // client id (the app_… shape), no undocumented backend — anywhere.
  const offenders = [];
  for (const file of shippedSources()) {
    const text = readFileSync(file, "utf8");
    for (const pattern of [/chatgpt\.com/i, /auth\.openai\.com/i, /\bapp_[A-Za-z0-9]{20,}/]) {
      if (pattern.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], "vendor-specific auth identifiers must not ship");
});

test("provider_auth.rs is generic and reads all four identifiers from the maintainer", () => {
  for (const key of [
    "LIGHTHOUSE_SIGNIN_CLIENT_ID",
    "LIGHTHOUSE_SIGNIN_DEVICE_AUTH_URL",
    "LIGHTHOUSE_SIGNIN_TOKEN_URL",
    "LIGHTHOUSE_SIGNIN_API_BASE",
  ]) {
    assert.ok(providerAuthRust.includes(key), `${key} is maintainer-supplied`);
    assert.ok(
      providerAuthRust.includes(`option_env!("${key}")`),
      `${key} also has the build-time counterpart (runtime wins)`,
    );
  }
  assert.match(
    providerAuthRust,
    /sign-in isn't configured in this build/,
    "the fail-closed reason is the module's single unconfigured answer",
  );
  assert.doesNotMatch(
    providerAuthRust,
    /https:\/\/(?!.*example)/,
    "no real host ships as a default in the auth module",
  );
});

// --- F. Contracts: types + service surface + real wiring -------------------

test("contracts expose the sign-in surface and the real service posts the providerAuth op", () => {
  for (const t of ["SigninStatus", "SigninStart", "SigninPoll"]) {
    assert.ok(types.includes(`export interface ${t}`), `types.ts exports ${t}`);
  }
  for (const m of [
    "providerAuthStatus",
    "providerAuthStart",
    "providerAuthPoll",
    "providerAuthSignout",
    "providerAuthSetMethod",
  ]) {
    assert.ok(services.includes(`${m}(`), `RagService declares ${m}`);
    assert.ok(realService.includes(`async ${m}(`), `real service implements ${m}`);
  }
  for (const action of ["status", "start", "poll", "signout", "setMethod"]) {
    assert.ok(
      realService.includes(`op: "providerAuth", action: "${action}"`),
      `real service wires action ${action}`,
    );
  }
});
