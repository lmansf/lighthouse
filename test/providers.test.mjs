/**
 * Wiring guarantee for the model picker (src/contracts/mocks/providers.ts):
 * every provider offered in the UI must be one the answer engine actually
 * streams from. An earlier build listed OpenAI/Google/Mistral in the picker
 * while the engine silently ignored their keys — every answer fell back to
 * keyword extraction. This test makes that class of regression impossible to
 * reintroduce quietly. The Rust engine pins the same table from its side
 * (lighthouse-core llm.rs remote_provider_table_is_sound + profile_test.rs).
 *
 * Run: `node --test test/providers.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { MODEL_PROVIDERS } = await import("../src/contracts/mocks/providers.ts");
const { REMOTE_PROVIDERS, remoteProvider, validateKey } = await import("../src/server/llm.ts");

test("every picker provider is wired to a real backend", () => {
  const wired = new Set(["local", "anthropic", ...REMOTE_PROVIDERS.map((p) => p.id)]);
  for (const p of MODEL_PROVIDERS) {
    assert.ok(
      wired.has(p.id),
      `picker offers "${p.id}" but no engine backend streams from it — keys would be silently ignored`,
    );
  }
});

test("every wired remote provider is offered in the picker", () => {
  const offered = new Set(MODEL_PROVIDERS.map((p) => p.id));
  for (const p of REMOTE_PROVIDERS) {
    assert.ok(offered.has(p.id), `engine wires "${p.id}" but the picker never offers it`);
  }
});

test("provider table is sound", () => {
  const ids = new Set();
  for (const p of REMOTE_PROVIDERS) {
    assert.ok(!ids.has(p.id), `duplicate provider id ${p.id}`);
    ids.add(p.id);
    assert.notEqual(p.id, "local");
    assert.notEqual(p.id, "anthropic");
    assert.match(p.chatUrl, /^https:\/\/.+\/chat\/completions$/);
    assert.match(p.modelsUrl, /^https:\/\//);
    assert.ok(["max_tokens", "max_completion_tokens"].includes(p.maxTokensParam));
    assert.ok(p.defaultModel.length > 0 && p.envKey.length > 0);
    assert.equal(remoteProvider(p.id)?.id, p.id);
  }
  assert.equal(remoteProvider("anthropic"), undefined);
  assert.equal(remoteProvider("local"), undefined);
});

test("picker entries carry models and a key page", () => {
  for (const p of MODEL_PROVIDERS) {
    assert.ok(p.models.length > 0, `${p.id} offers no models`);
    assert.match(p.apiKeyUrl, /^https:\/\//, `${p.id} has no key page`);
    assert.ok(p.label.length > 0);
  }
});

test("validateKey rejects blanks and unkeyed providers without network", async () => {
  assert.equal((await validateKey("openai", "  ")).ok, false);
  assert.equal((await validateKey("local", "anything")).ok, false);
  assert.equal((await validateKey("not-a-provider", "anything")).ok, false);
});
