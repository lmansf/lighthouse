/**
 * Managed-policy ENFORCEMENT in the TS twin — the policy module's verdicts
 * (test/policy.test.mjs) must actually gate the engine paths, mirroring the
 * Rust call sites (profile.rs select_model, llm.rs stream_answer):
 *   - selectModel under forceLocalOnly leaves the profile unchanged and
 *     persists nothing (no provider, no sealed key);
 *   - streamAnswer refuses a disallowed keyed cloud provider at call time and
 *     answers with the extractive fallback, without touching the network.
 *
 * Run: `node --test test/policyEnforcement.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

// Isolated vault/app state (same pattern as secrets.test.mjs), plus a clean
// env so a developer's real keys can't leak into the gates under test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-policy-enforce-"));
process.env.VAULT_DIR = dir; // appStateDir falls back to <vault>/.rag-vault
delete process.env.LIGHTHOUSE_APP_STATE_DIR;
delete process.env.LIGHTHOUSE_POLICY_FILE;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const policy = await import("../src/server/policy.ts");
const { selectModel, getState, resolvedKeyFor } = await import("../src/server/profile.ts");
const { streamAnswer } = await import("../src/server/llm.ts");

/** Point the engine at a throwaway policy file for the duration of `fn`. */
async function withPolicy(content, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-pol-")), "policy.json");
  fs.writeFileSync(file, content);
  process.env.LIGHTHOUSE_POLICY_FILE = file;
  policy.resetPolicyForTests();
  try {
    await fn();
  } finally {
    delete process.env.LIGHTHOUSE_POLICY_FILE;
    policy.resetPolicyForTests();
  }
}

test("selectModel under forceLocalOnly leaves the profile untouched and seals no key", async () => {
  await withPolicy(JSON.stringify({ forceLocalOnly: true }), () => {
    selectModel("openai", "gpt-5-mini", "sk-live-blocked");
    const state = getState();
    assert.equal(state.providerId, null, "disallowed provider not persisted");
    assert.equal(state.step, "sign-in", "selectModel did not advance the profile");
    assert.equal(resolvedKeyFor("openai"), null, "no key sealed for a disallowed provider");
  });
  // Same call without the policy goes through — the gate above was the policy.
  selectModel("openai", "gpt-5-mini", "sk-live-allowed");
  assert.equal(resolvedKeyFor("openai"), "sk-live-allowed", "an allowed provider's key is sealed");
});

test("streamAnswer refuses a keyed-but-disallowed provider and falls back extractively", async () => {
  const contexts = [{ name: "notes.md", text: "Lighthouse ships two twin engines.", score: 0.9 }];
  const cfg = { providerId: "openai", modelId: "gpt-5-mini", apiKey: "sk-live-blocked" };
  const collect = async () => {
    let out = "";
    for await (const delta of streamAnswer("What ships?", contexts, cfg)) out += delta;
    return out;
  };
  // Any network attempt is a failure — the extractive path needs none.
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("network attempted");
  };
  try {
    await withPolicy(JSON.stringify({ forceLocalOnly: true }), async () => {
      const text = await collect();
      assert.ok(
        text.includes("Connect an AI model"),
        `expected the extractive no-key nudge, got: ${text.slice(0, 120)}`,
      );
      assert.ok(text.includes("notes.md"), "extractive answer cites the passage");
      assert.equal(fetched, false, "a disallowed provider must never be called");
    });
    // Without the policy the same config heads for the provider (and here hits
    // the stubbed network), so the block above genuinely exercised the gate.
    const text = await collect();
    assert.equal(fetched, true);
    assert.ok(text.includes("Live model unavailable"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
