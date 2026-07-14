/**
 * Provider API keys must persist — sealed, install-global, sign-out-proof.
 *
 * Guards the 0.11 fix for "there isn't a good way to persistently save API
 * keys": pre-0.11 they sat as plaintext inside profile.json and were wiped by
 * signOut(). Now they live in the encrypted secrets store (src/server/
 * secrets.ts, Rust twin secrets.rs):
 *   - seal/open roundtrip, never plaintext on disk
 *   - legacy plaintext profile.json keys migrate on first load and are
 *     stripped from the profile file
 *   - signOut() resets the profile but keys survive
 *
 * Run: `node --test test/secrets.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-secrets-"));
process.env.VAULT_DIR = dir; // appStateDir falls back to <vault>/.rag-vault
delete process.env.LIGHTHOUSE_APP_STATE_DIR;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { setProviderKey, getProviderKey } = await import("../src/server/secrets.ts");
const { selectModel, signOut, resolvedKeyFor, getState } = await import(
  "../src/server/profile.ts"
);

const stateDir = path.join(dir, ".rag-vault");

test("seal/open roundtrip; plaintext never on disk; empty removes", () => {
  setProviderKey("openai", "sk-live-abc123");
  assert.equal(getProviderKey("openai"), "sk-live-abc123");
  const raw = fs.readFileSync(path.join(stateDir, "secrets.json"), "utf8");
  assert.ok(!raw.includes("sk-live-abc123"), "key stored in plaintext");
  setProviderKey("openai", "");
  assert.equal(getProviderKey("openai"), null);
});

test("selectModel stores the key sealed and keeps profile.json clean", () => {
  selectModel("openai", "gpt-4o-mini", "sk-live-select1");
  assert.equal(resolvedKeyFor("openai"), "sk-live-select1");
  const profileRaw = fs.readFileSync(path.join(stateDir, "profile.json"), "utf8");
  assert.ok(!profileRaw.includes("sk-live-select1"), "profile.json carries a raw key");
  assert.ok(getState().keyedProviders.includes("openai"));
});

test("legacy plaintext profile keys migrate into the store and are stripped", () => {
  // Simulate a pre-0.11 profile.json written by an older build.
  const legacy = {
    step: "done",
    user: { id: "local", name: "T", email: "t@example.com" },
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    hasApiKey: true,
    apiKey: "sk-ant-legacy",
    apiKeys: { anthropic: "sk-ant-legacy", xai: "xai-legacy" },
  };
  fs.writeFileSync(path.join(stateDir, "profile.json"), JSON.stringify(legacy));
  // Any profile read triggers the one-time migration.
  assert.equal(resolvedKeyFor("anthropic"), "sk-ant-legacy");
  assert.equal(resolvedKeyFor("xai"), "xai-legacy");
  const after = fs.readFileSync(path.join(stateDir, "profile.json"), "utf8");
  assert.ok(!after.includes("sk-ant-legacy"), "legacy key left in profile.json");
  assert.ok(!after.includes("xai-legacy"), "legacy map left in profile.json");
});

test("signOut resets the profile but provider keys survive", () => {
  selectModel("openai", "gpt-4o-mini", "sk-live-survivor");
  signOut();
  assert.equal(getState().step, "sign-in", "profile reset");
  assert.equal(resolvedKeyFor("openai"), "sk-live-survivor", "key lost on sign-out");
});
