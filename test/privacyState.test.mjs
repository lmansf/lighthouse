/**
 * Privacy legibility (0.12.1 §2) — the pure predicate behind "is a cloud
 * provider answering right now" (src/lib/privacyState.ts).
 * `cloudProviderActive` is the UI mirror of the engine predicate
 * (synth.rs::is_cloud_provider ⇄ synth.ts::isCloudProvider), so its truth table
 * is pinned case by case here.
 *
 * The per-file withheld count and the local-only skip-note regex it fed went
 * with the local-only marks in 0.15.0 (openspec: refocus-chat-attachments):
 * there is no per-file cloud gate to count, because the corpus is what the user
 * attached to THIS chat and the provider choice applies to the whole ask.
 *
 * Run: `node --test test/privacyState.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./_ts-extensionless-hook.mjs", import.meta.url);

const { cloudProviderActive } = await import("../src/lib/privacyState.ts");

// --- cloudProviderActive: the single rule, mirroring origin "device" ------------

test("cloudProviderActive: the device path (no provider / local) is NOT cloud", () => {
  // No provider chosen yet — the private local default (and the engine's
  // model-free extractive fallback) answer on this device.
  assert.equal(cloudProviderActive(null), false, "null provider = device");
  assert.equal(cloudProviderActive(undefined), false, "undefined provider = device");
  assert.equal(cloudProviderActive("local"), false, "the private model = device");
  // The engine's originOf treats a falsy provider id as device; the empty
  // string must not read as an armed cloud provider.
  assert.equal(cloudProviderActive(""), false, "empty id = device (engine: !providerId)");
});

test("cloudProviderActive: any named vendor is cloud — identity, not key presence", () => {
  assert.equal(cloudProviderActive("anthropic"), true);
  assert.equal(cloudProviderActive("openai"), true);
  // Even an id the catalog doesn't know is cloud: local-only fails CLOSED
  // toward privacy, exactly like the engine's is_cloud_provider.
  assert.equal(cloudProviderActive("some-future-vendor"), true);
});

// --- hiddenFromCloudCount: the set actually being withheld ----------------------

const file = (over = {}) => ({ kind: "file", ragIncluded: true, localOnly: true, ...over });
